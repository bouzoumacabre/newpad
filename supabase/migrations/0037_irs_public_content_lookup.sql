-- ============================================================================
-- NEWPAD — Migration 0037 : registres IRS, contenu public, annuaire
-- ============================================================================
-- Audit fonctionnalité par fonctionnalité — étape 12.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- A. `profile_public_lookup` était un annuaire ouvert
-- ----------------------------------------------------------------------------
--     select id, username, display_name, role from profiles where id = p_id;
--
-- Aucun contrôle : ni session, ni rôle, ni portée. La fonction traduit un
-- identifiant en nom, identifiant de connexion ET RÔLE, pour n'importe quel
-- profil. Elle n'a qu'un usage légitime — permettre au client de lire le nom du
-- conseiller qui lui a été attribué, puisque la policy `profiles_select` lui
-- interdit de lire un autre profil que le sien.
--
-- Les identifiants ne se devinent pas, mais ils circulent : `related_client_id`
-- d'une alerte, `assigned_advisor_id`, `created_by` d'une transaction, les
-- métadonnées d'une notification. Un client qui en récupère un pouvait donc
-- lever l'anonymat de son porteur — et repérer au passage quels comptes sont
-- administrateurs, ce qui est exactement le renseignement qu'on cherche avant
-- de tenter quoi que ce soit.
--
-- La portée est resserrée : le personnel et l'IRS résolvent tout le monde, un
-- client ne résout que lui-même et les membres du personnel (son conseiller).

create or replace function profile_public_lookup(p_id uuid)
returns table(id uuid, username text, display_name text, role user_role)
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_caller user_role;
  v_target user_role;
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;

  select p.role into v_caller from profiles p where p.id = auth.uid();
  select p.role into v_target from profiles p where p.id = p_id;
  if v_target is null then return; end if;

  if not (
    v_caller in ('employee', 'admin', 'irs')
    or p_id = auth.uid()
    or v_target in ('employee', 'admin')
  ) then
    raise exception 'Accès refusé';
  end if;

  return query select p.id, p.username, p.display_name, p.role from profiles p where p.id = p_id;
end;
$function$;


-- ----------------------------------------------------------------------------
-- B. Le contenu du site était public AVANT publication
-- ----------------------------------------------------------------------------
--     site_content_select_public : using (true)
--
-- La policy ouvre la table entière à tout le monde, y compris sans session —
-- ce qui est voulu pour la page d'accueil. Mais elle ignore `is_active` : un
-- bloc préparé et non publié (annonce à venir, communiqué en brouillon) était
-- lisible par n'importe qui via l'API REST, avant sa mise en ligne. Le filtre
-- n'existait que côté navigateur, dans le rendu de la page d'accueil.
--
-- Le personnel conserve la lecture complète, pour continuer à voir ses
-- brouillons dans l'écran d'édition.

drop policy if exists site_content_select_public on site_content;

create policy site_content_select_public on site_content
for select using (is_active or is_staff());


-- ----------------------------------------------------------------------------
-- C. Le compteur de comptes de l'IRS ne correspondait pas à son registre
-- ----------------------------------------------------------------------------
-- `irs_list_accounts` exclut explicitement la trésorerie de la banque
-- (`is_bank_treasury = false`), mais `irs_stats` la comptait :
--
--     'accounts_total', (select count(*) from accounts a where not is_masked_for(...))
--
-- Le tableau de bord annonçait donc un compte de plus que ce que le registre
-- montre — et ce compte-là est justement celui que l'IRS n'a pas à voir.
-- Le nombre de clients ignorait de la même façon le masquage par interface.

create or replace function irs_stats()
returns jsonb
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_irs() then raise exception 'Réservé au rôle IRS'; end if;
  perform require_feature('irs.accounts.view');
  return jsonb_build_object(
    'clients_total', (select count(*) from profiles where role = 'client'),
    'accounts_total', (select count(*) from accounts a
                       where not is_masked_for('account', a.id, 'irs')
                         and a.is_bank_treasury = false),
    'transactions_total', (select count(*) from transactions t
                           where not is_masked_for('transaction', t.id, 'irs')),
    'gold_weight_kg', (select coalesce(round(sum(weight_grams)/1000, 2), 0) from gold_bars)
  );
end;
$function$;


-- ----------------------------------------------------------------------------
-- D. Les quatre registres IRS échappaient au contrôle des fonctionnalités
-- ----------------------------------------------------------------------------
-- L'étape 8 a branché `require_feature` sur 28 portes d'entrée, mais les clés
-- `irs.*` du registre étaient restées sans effet : décocher « Registre des
-- transactions » retirait l'entrée du menu IRS sans fermer la fonction.
do $do$
declare
  m record;
  v_def text;
  v_new text;
begin
  for m in
    select * from (values
      ('irs_list_accounts',     'irs.accounts.view'),
      ('irs_list_clients',      'irs.clients.view'),
      ('irs_list_transactions', 'irs.transactions.view'),
      ('irs_list_gold_bars',    'irs.gold.view')
    ) as t(fn, key)
  loop
    if not exists (select 1 from feature_registry where key = m.key) then
      raise exception 'Clé de fonctionnalité inconnue au registre : %', m.key;
    end if;
    select pg_get_functiondef(p.oid) into v_def
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = m.fn;
    if v_def is null then raise exception 'Fonction introuvable : %', m.fn; end if;
    if v_def ilike '%require_feature(%' then continue; end if;

    v_new := regexp_replace(v_def, E'\nbegin\n',
               E'\nbegin\n  perform require_feature(''' || m.key || E''');\n');
    if v_new = v_def then raise exception 'Point d''injection introuvable dans %', m.fn; end if;
    execute v_new;
  end loop;
end
$do$;


-- ----------------------------------------------------------------------------
-- Permissions (voir 0015 ; exceptions rappelées en 0021, 0022, 0026 à 0036).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

grant execute on function record_login_attempt(text, boolean) to anon;
grant execute on function gold_price_snapshot() to anon;
revoke execute on function revoke_user_sessions(uuid) from authenticated;
revoke execute on function _system_fraud_alert(text, text, text, uuid, uuid, uuid, text) from authenticated;
revoke execute on function _system_adjust_trust_score(uuid, numeric) from authenticated;
revoke execute on function _bypass_profile_guard() from authenticated;
revoke execute on function notify(uuid, text, text, text, text, jsonb) from authenticated;
revoke execute on function notify_all_staff(text, text, text, text, boolean) from authenticated;
revoke execute on function purge_old_notifications() from authenticated;

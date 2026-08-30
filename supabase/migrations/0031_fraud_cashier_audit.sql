-- ============================================================================
-- NEWPAD — Migration 0031 : fraude, caisse, journal d'activité
-- ============================================================================
-- Audit fonctionnalité par fonctionnalité — étape 7.
-- État constaté avant correction : 14 alertes de fraude (toutes classées),
-- 15 rapports de caisse quotidiens (série continue, cohérente en interne),
-- 43 entrées au journal d'activité.
-- ============================================================================


-- ############################################################################
-- PARTIE A — FRAUDE : QUI PEUT ÉCRIRE QUOI
-- ############################################################################

-- ----------------------------------------------------------------------------
-- A1. N'importe quel client pouvait CRÉER une alerte de fraude
-- ----------------------------------------------------------------------------
-- `create_fraud_alert` ne vérifiait aucun rôle et était exécutable par tout
-- utilisateur authentifié. Un client pouvait donc :
--
--   - fabriquer une alerte visant N'IMPORTE QUEL autre joueur (`p_client_id`
--     est un paramètre libre), avec la description de son choix — c'est-à-dire
--     inscrire une accusation dans le registre de fraude de la banque ;
--   - passer `p_origin = 'auto'`, ce qui met `created_by` à NULL : l'alerte
--     apparaissait alors comme détectée par le système, sans auteur ;
--   - déclencher une notification à tout le personnel, autant de fois qu'il
--     le voulait.
--
-- La fonction est aussi appelée par le système lui-même (`_adjust_balance`
-- quand un compte passe en négatif, `record_login_attempt` sur échecs
-- répétés). On ne peut donc pas simplement exiger `is_staff()` : le chemin
-- interne est séparé dans `_system_fraud_alert`, non exécutable par
-- `authenticated` — appelée depuis une fonction SECURITY DEFINER, c'est le
-- propriétaire de la fonction qui a le droit d'exécution, pas l'appelant.

create or replace function _system_fraud_alert(p_origin text, p_rule_key text, p_severity text, p_client_id uuid, p_account_id uuid, p_transaction_id uuid, p_description text)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
begin
  insert into fraud_alerts (origin, rule_key, severity, related_client_id, related_account_id, related_transaction_id, description, created_by)
  values (p_origin, p_rule_key, p_severity, p_client_id, p_account_id, p_transaction_id, p_description,
          case when p_origin = 'manual' then auth.uid() else null end)
  returning id into v_id;
  perform notify_all_staff('fraud_alert', 'Nouvelle alerte fraude', p_description, '/employee/fraud');
  return v_id;
end;
$function$;


-- Signalement manuel : réservé au personnel, origine et auteur imposés.
create or replace function create_fraud_alert(p_origin text, p_rule_key text, p_severity text, p_client_id uuid, p_account_id uuid, p_transaction_id uuid, p_description text)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  if p_description is null or trim(p_description) = '' then
    raise exception 'La description du signalement est requise.';
  end if;
  if length(p_description) > 2000 then
    raise exception 'La description est trop longue (2 000 caractères maximum).';
  end if;
  if coalesce(p_severity, '') not in ('low', 'medium', 'high') then
    raise exception 'Gravité invalide (attendu : low, medium ou high).';
  end if;
  if p_client_id is not null and not exists (select 1 from profiles where id = p_client_id) then
    raise exception 'Profil visé introuvable.';
  end if;

  -- `p_origin` est ignoré : un signalement passé par cette porte est
  -- forcément manuel, et son auteur est celui qui l'a saisi.
  v_id := _system_fraud_alert('manual', p_rule_key, p_severity, p_client_id, p_account_id, p_transaction_id, trim(p_description));
  perform log_audit('create_fraud_alert', 'fraud_alerts', v_id, jsonb_build_object(
    'severity', p_severity,
    'client', (select display_name from profiles where id = p_client_id)));
  return v_id;
end;
$function$;


-- ----------------------------------------------------------------------------
-- A2. N'importe quel client pouvait MODIFIER une note de confiance
-- ----------------------------------------------------------------------------
-- `adjust_trust_score` commence par `_bypass_profile_guard()` — elle neutralise
-- volontairement le garde-fou qui empêche un client de toucher à son propre
-- rôle, statut ou note de confiance — puis écrit directement dans `profiles`.
-- Elle était exécutable par tout utilisateur authentifié : un client pouvait
-- porter sa note à 100, ou faire tomber celle d'un rival à 0.
--
-- Même découpage que pour la fraude : chemin interne fermé, porte publique
-- réservée au personnel.

create or replace function _system_adjust_trust_score(p_client_id uuid, p_delta numeric)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  perform _bypass_profile_guard();
  update profiles set trust_score = greatest(0, least(100, trust_score + p_delta))
  where id = p_client_id;
end;
$function$;


create or replace function adjust_trust_score(p_client_id uuid, p_delta numeric)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_old numeric;
  v_new numeric;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  if p_delta is null then raise exception 'Ajustement invalide'; end if;

  select trust_score into v_old from profiles where id = p_client_id;
  if v_old is null then raise exception 'Profil introuvable'; end if;

  perform _system_adjust_trust_score(p_client_id, p_delta);
  select trust_score into v_new from profiles where id = p_client_id;

  perform log_audit('adjust_trust_score', 'profiles', p_client_id, jsonb_build_object(
    'client', (select display_name from profiles where id = p_client_id),
    'avant', v_old, 'apres', v_new, 'delta', p_delta));
end;
$function$;


-- Les fonctions internes qui émettaient une alerte ou touchaient la note de
-- confiance passent par les chemins système.

create or replace function _adjust_balance(p_account_id uuid, p_delta numeric)
returns numeric
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_old numeric;
  v_new numeric;
  v_client uuid;
  v_is_treasury boolean;
  v_iban text;
begin
  select balance into v_old from accounts where id = p_account_id;
  if v_old is null then
    raise exception 'Compte introuvable: %', p_account_id;
  end if;

  update accounts set balance = balance + p_delta where id = p_account_id
  returning balance, client_id, is_bank_treasury, iban into v_new, v_client, v_is_treasury, v_iban;

  if v_new < 0 and v_old >= 0 and not coalesce(v_is_treasury, false) then
    perform _system_fraud_alert('auto', 'negative_balance', 'medium', v_client, p_account_id, null,
      'Compte ' || coalesce(v_iban, p_account_id::text) || ' passé en négatif (' || v_new || ' $)');
  end if;

  return v_new;
end;
$function$;


create or replace function record_login_attempt(p_username text, p_success boolean)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_profile_id uuid;
  v_recent_failures int;
  v_threshold int;
  v_success boolean;
  v_username text;
begin
  v_username := lower(trim(coalesce(p_username, '')));
  if v_username = '' then return; end if;

  select id into v_profile_id from profiles where username = v_username;

  v_success := coalesce(p_success, false)
               and v_profile_id is not null
               and auth.uid() = v_profile_id;

  insert into login_log (profile_id, username_attempted, success)
  values (v_profile_id, v_username, v_success);

  if not v_success then
    select count(*) into v_recent_failures from login_log
    where username_attempted = v_username and success = false and created_at > now() - interval '15 minutes';

    v_threshold := coalesce((get_setting('fraud_failed_login_threshold')->>'amount')::int, 5);

    -- La déduplication comparait la DESCRIPTION avec un `like '%' || nom || '%'`
    -- non échappé : un identifiant contenant % ou _ ne se dédupliquait pas, et
    -- un identifiant contenu dans un autre (« bob » dans « bobby ») supprimait
    -- à tort l'alerte du second. On compare désormais l'identifiant lui-même,
    -- via la table qui le stocke tel quel.
    if v_recent_failures >= v_threshold
       and not exists (
         select 1 from fraud_alerts f
         where f.rule_key = 'failed_login_attempts'
           and f.created_at > now() - interval '15 minutes'
           and f.related_client_id is not distinct from v_profile_id
       )
    then
      perform _system_fraud_alert('auto', 'failed_login_attempts', 'high', v_profile_id, null, null,
        'Tentatives de connexion échouées répétées pour ' || v_username);
    end if;
  end if;
end;
$function$;


-- ----------------------------------------------------------------------------
-- A3. Le personnel pouvait RÉÉCRIRE une alerte de fraude, pas seulement la
--     classer
-- ----------------------------------------------------------------------------
-- La policy `fraud_alerts_staff_update` autorisait `is_staff()` à modifier
-- N'IMPORTE QUELLE colonne d'une alerte : description, gravité, client visé,
-- origine, auteur. Un employé signalé par une alerte automatique pouvait donc
-- en réécrire le contenu, ou la réattribuer à quelqu'un d'autre. Un registre
-- de fraude que ses propres sujets peuvent réécrire ne prouve rien.
--
-- L'écriture directe est retirée ; seul le classement passe, par une fonction
-- qui ne touche que le statut, le relecteur et la note de traitement.

alter table fraud_alerts add column if not exists resolution_note text;

comment on column fraud_alerts.resolution_note is
  'Note de traitement saisie au classement. La description d''origine n''est jamais modifiable — voir migration 0031.';

drop policy if exists fraud_alerts_staff_update on fraud_alerts;

create or replace function set_fraud_alert_status(p_id uuid, p_status text, p_note text default null)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  a fraud_alerts%rowtype;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  if p_status not in ('open', 'reviewed', 'dismissed') then
    raise exception 'Statut invalide (attendu : open, reviewed ou dismissed).';
  end if;

  select * into a from fraud_alerts where id = p_id for update;
  if a is null then raise exception 'Alerte introuvable'; end if;

  update fraud_alerts set
    status = p_status,
    resolution_note = coalesce(p_note, resolution_note),
    reviewed_by = case when p_status = 'open' then null else auth.uid() end,
    reviewed_at = case when p_status = 'open' then null else now() end
  where id = p_id;

  perform log_audit('set_fraud_alert_status', 'fraud_alerts', p_id, jsonb_build_object(
    'avant', a.status, 'apres', p_status, 'note', p_note, 'regle', a.rule_key));
end;
$function$;


-- ############################################################################
-- PARTIE B — RAPPORT DE CAISSE
-- ############################################################################

alter table cashier_reports add column if not exists actual_balance numeric;
alter table cashier_reports add column if not exists discrepancy numeric;
alter table cashier_reports add column if not exists money_supply numeric;

comment on column cashier_reports.actual_balance is
  'Solde réel du compte de trésorerie au moment de la génération. Comparé au solde de clôture calculé — voir discrepancy.';
comment on column cashier_reports.discrepancy is
  'Solde calculé moins solde réel. Toute valeur non nulle signale un mouvement de trésorerie que le rapport n''explique pas.';
comment on column cashier_reports.money_supply is
  'Somme des soldes de TOUS les comptes. Le rapport ne surveillait que la trésorerie : de l''argent créé directement sur un compte client n''y apparaissait pas.';


-- ----------------------------------------------------------------------------
-- B1. Le rapport ne voyait pas les commissions, et ne se vérifiait jamais
-- ----------------------------------------------------------------------------
-- Trois défauts distincts :
--
--   1. COMMISSIONS INVISIBLES. Les entrées étaient calculées ainsi :
--
--          case when to_account_id = v_bank_account then amount + fee_amount end
--
--      Or sur un virement, la ligne de transaction va de l'émetteur au
--      destinataire : la banque n'est NI `from_account_id` NI `to_account_id`.
--      La commission encaissée (`fee_amount`) n'était donc jamais comptée. Le
--      `+ fee_amount` ne servait que sur les lignes où la banque est bien la
--      destination — et sur celles-là, il DOUBLERAIT la part de frais si elle
--      y était renseignée.
--
--   2. AUCUNE RÉCONCILIATION. Le solde de clôture était calculé de proche en
--      proche (clôture de la veille + entrées − sorties) sans jamais être
--      comparé au solde réel du compte de trésorerie. Une dérive pouvait
--      s'installer sans que rien ne la signale — c'est pourtant la raison
--      d'être d'un rapport de caisse.
--
--   3. AVEUGLE À LA MASSE MONÉTAIRE. Le rapport ne regarde que la trésorerie.
--      De l'argent apparu directement sur un compte CLIENT n'y laisse aucune
--      trace : c'est très exactement le cas des 3 004 531 $ orphelins des 17
--      et 18/08 (dépôts sans compte d'origine, antérieurs au correctif 0010),
--      que quinze rapports quotidiens successifs n'ont jamais signalés.
--
-- Quatrième défaut, sur la reprise : si le rapport de la veille manque (base
-- indisponible une journée), l'ouverture retombait sur le solde ACTUEL, auquel
-- les mouvements du jour étaient ensuite ajoutés — donc comptés deux fois. Le
-- repli déduit désormais les mouvements du jour du solde constaté.

create or replace function generate_daily_cashier_report()
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_bank_account uuid;
  v_prev_closing numeric;
  v_in numeric;
  v_out numeric;
  v_fees numeric;
  v_closing numeric;
  v_actual numeric;
  v_supply numeric;
  v_adjustment numeric;
  v_discrepancy numeric;
begin
  v_bank_account := bank_treasury_account_id();
  select balance into v_actual from accounts where id = v_bank_account;

  -- Entrées et sorties de la trésorerie sur la journée.
  select
    coalesce(sum(case when to_account_id   = v_bank_account then amount else 0 end), 0),
    coalesce(sum(case when from_account_id = v_bank_account then amount else 0 end), 0),
    -- Commissions encaissées sur des mouvements entre deux tiers : la banque
    -- n'apparaît sur aucune des deux colonnes de compte, mais elle encaisse.
    coalesce(sum(case
      when coalesce(fee_amount, 0) > 0
       and to_account_id   is distinct from v_bank_account
       and from_account_id is distinct from v_bank_account
      then fee_amount else 0 end), 0)
  into v_in, v_out, v_fees
  from transactions
  where created_at::date = current_date
    and status = 'validated';

  v_in := v_in + v_fees;

  -- Sur un virement émis PAR la banque, la commission lui revient : la sortie
  -- nette vaut le montant moins les frais retenus sur cette même ligne.
  select v_out - coalesce(sum(coalesce(fee_amount, 0)), 0) into v_out
  from transactions
  where created_at::date = current_date and status = 'validated'
    and from_account_id = v_bank_account;

  select closing_balance - coalesce(adjustment_amount, 0)
  into v_prev_closing
  from cashier_reports where report_date = current_date - 1;

  if v_prev_closing is null then
    -- Repli : on remonte des mouvements du jour vers l'ouverture, au lieu de
    -- prendre le solde actuel comme ouverture puis d'y rajouter ces mêmes
    -- mouvements.
    v_prev_closing := v_actual - v_in + v_out;
  end if;

  -- Une correction manuelle de l'admin ne doit pas être effacée par la
  -- régénération du rapport (le `on conflict do update` écrasait le solde de
  -- clôture ajusté par le solde recalculé).
  select coalesce(adjustment_amount, 0) into v_adjustment
  from cashier_reports where report_date = current_date;
  v_adjustment := coalesce(v_adjustment, 0);

  v_closing := v_prev_closing + v_in - v_out + v_adjustment;

  select coalesce(sum(balance), 0) into v_supply from accounts where status <> 'closed';

  v_discrepancy := v_closing - v_actual;

  insert into cashier_reports (report_date, opening_balance, total_in, total_out, closing_balance,
                               actual_balance, discrepancy, money_supply)
  values (current_date, v_prev_closing, v_in, v_out, v_closing, v_actual, v_discrepancy, v_supply)
  on conflict (report_date) do update set
    opening_balance = excluded.opening_balance,
    total_in = excluded.total_in,
    total_out = excluded.total_out,
    closing_balance = excluded.closing_balance,
    actual_balance = excluded.actual_balance,
    discrepancy = excluded.discrepancy,
    money_supply = excluded.money_supply,
    generated_at = now();

  -- Un écart entre le solde calculé et le solde réel est une anomalie
  -- comptable : elle doit remonter au personnel le jour même, pas attendre
  -- qu'un humain relise la colonne.
  if abs(v_discrepancy) >= 0.01 then
    perform _system_fraud_alert('auto', 'cashier_discrepancy', 'high', null, v_bank_account, null,
      'Écart de caisse du ' || current_date || ' : ' || v_discrepancy ||
      ' $ entre le solde calculé (' || v_closing || ' $) et le solde réel de la trésorerie (' || v_actual || ' $).');
  end if;
end;
$function$;


-- ----------------------------------------------------------------------------
-- B2. Corriger un rapport inexistant « réussissait »
-- ----------------------------------------------------------------------------
-- `admin_adjust_cashier_report` ne vérifiait pas que la ligne existait : un
-- identifiant erroné ne modifiait rien, ne levait aucune erreur, et inscrivait
-- quand même au journal d'activité une correction qui n'avait pas eu lieu.
create or replace function admin_adjust_cashier_report(p_report_id uuid, p_amount numeric, p_note text)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r cashier_reports%rowtype;
begin
  if not is_admin() then raise exception 'Réservé à l''admin'; end if;
  if p_amount is null or p_amount = 0 then
    raise exception 'Le montant de la correction doit être non nul.';
  end if;
  if p_note is null or trim(p_note) = '' then
    raise exception 'Une note justifiant la correction est requise.';
  end if;

  select * into r from cashier_reports where id = p_report_id for update;
  if r is null then raise exception 'Rapport de caisse introuvable'; end if;

  update cashier_reports set
    adjustment_amount = coalesce(adjustment_amount, 0) + p_amount,
    -- Recalculé à partir des composants plutôt qu'incrémenté : le solde reste
    -- juste même après plusieurs corrections ou une régénération du rapport.
    closing_balance = opening_balance + total_in - total_out + coalesce(adjustment_amount, 0) + p_amount,
    discrepancy = (opening_balance + total_in - total_out + coalesce(adjustment_amount, 0) + p_amount) - coalesce(actual_balance, opening_balance + total_in - total_out),
    adjusted_by = auth.uid(), adjusted_at = now(),
    adjustment_note = coalesce(adjustment_note || E'\n', '') || trim(p_note)
  where id = p_report_id;

  perform log_audit('adjust_cashier_report', 'cashier_reports', p_report_id, jsonb_build_object(
    'date', r.report_date, 'amount', p_amount, 'note', trim(p_note)));
end;
$function$;


-- Reprise de l'historique : les 15 rapports existants n'ont ni solde réel ni
-- masse monétaire. On ne peut pas reconstituer le solde de trésorerie d'un jour
-- passé, mais on peut au moins renseigner le rapport du jour courant.
update cashier_reports set
  actual_balance = (select balance from accounts where is_bank_treasury limit 1),
  money_supply = (select coalesce(sum(balance), 0) from accounts where status <> 'closed'),
  discrepancy = closing_balance - (select balance from accounts where is_bank_treasury limit 1)
where report_date = current_date;


-- ############################################################################
-- PARTIE C — JOURNAL D'ACTIVITÉ ET CONNEXIONS
-- ############################################################################

-- ----------------------------------------------------------------------------
-- C1. Le journal n'était ni filtrable ni cherchable
-- ----------------------------------------------------------------------------
-- L'écran chargeait les 150 dernières lignes, sans recherche ni filtre : dès
-- que le journal grossit, une action précise devient introuvable. Retrouver
-- « qui a validé ce virement » supposait de faire défiler à la main.
create or replace function staff_list_audit_log(p_search text default null, p_action text default null, p_role text default null, p_limit integer default 200)
returns table(id uuid, created_at timestamptz, actor_id uuid, actor_name text, actor_role user_role,
              action text, target_type text, target_id uuid, details jsonb)
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  return query
  select a.id, a.created_at, a.actor_id, p.display_name, a.actor_role,
         a.action, a.target_type, a.target_id, a.details
  from audit_log a
  left join profiles p on p.id = a.actor_id
  where (p_action is null or trim(p_action) = '' or a.action = p_action)
    and (p_role is null or trim(p_role) = '' or a.actor_role::text = p_role)
    and (p_search is null or trim(p_search) = ''
         or p.display_name ilike '%' || p_search || '%'
         or p.username ilike '%' || p_search || '%'
         or a.action ilike '%' || p_search || '%'
         or a.details::text ilike '%' || p_search || '%')
  order by a.created_at desc
  limit least(coalesce(p_limit, 200), 1000);
end;
$function$;


create or replace function list_audit_actions()
returns table(action text, total bigint)
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  return query select a.action, count(*) from audit_log a group by a.action order by a.action;
end;
$function$;


-- ----------------------------------------------------------------------------
-- C2. L'historique des connexions n'était affiché nulle part
-- ----------------------------------------------------------------------------
-- `login_log` est alimenté à chaque tentative et lisible par l'admin
-- (policy `login_log_select`), mais AUCUN écran ne l'affiche : la détection
-- d'échecs répétés produit une alerte sans que personne ne puisse consulter
-- les tentatives qui l'ont provoquée.
create or replace function admin_list_login_log(p_search text default null, p_only_failures boolean default false, p_limit integer default 200)
returns table(id uuid, created_at timestamptz, profile_id uuid, display_name text, username_attempted text, success boolean)
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  return query
  select l.id, l.created_at, l.profile_id, p.display_name, l.username_attempted, l.success
  from login_log l
  left join profiles p on p.id = l.profile_id
  where (not coalesce(p_only_failures, false) or l.success = false)
    and (p_search is null or trim(p_search) = ''
         or l.username_attempted ilike '%' || p_search || '%'
         or p.display_name ilike '%' || p_search || '%')
  order by l.created_at desc
  limit least(coalesce(p_limit, 200), 1000);
end;
$function$;


-- ----------------------------------------------------------------------------
-- Permissions (voir 0015 ; exceptions rappelées en 0021, 0022, 0026 à 0030).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

grant execute on function record_login_attempt(text, boolean) to anon;
grant execute on function gold_price_snapshot() to anon;
revoke execute on function revoke_user_sessions(uuid) from authenticated;

-- Chemins internes : appelés uniquement depuis des fonctions SECURITY DEFINER
-- (le droit est alors évalué sur le propriétaire de la fonction, pas sur
-- l'appelant), jamais depuis le navigateur.
revoke execute on function _system_fraud_alert(text, text, text, uuid, uuid, uuid, text) from authenticated;
revoke execute on function _system_adjust_trust_score(uuid, numeric) from authenticated;

-- `_bypass_profile_guard` neutralise le garde-fou qui empêche un client de
-- modifier son propre rôle, son statut ou sa note de confiance. Elle n'a
-- jamais eu de raison d'être appelable depuis le navigateur.
revoke execute on function _bypass_profile_guard() from authenticated;

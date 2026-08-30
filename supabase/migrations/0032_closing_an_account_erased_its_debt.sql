-- ============================================================================
-- NEWPAD — Migration 0032 : clôturer un compte effaçait sa dette
-- ============================================================================
-- Anomalie révélée par la réconciliation ajoutée en 0031 : la masse monétaire
-- calculée sur les comptes NON clôturés (253 009 510,49 $) était SUPÉRIEURE au
-- total de tous les comptes (253 004 530,50 $). Autrement dit, les comptes
-- clôturés pesaient −4 979,99 $ : deux comptes ont été clôturés alors qu'ils
-- étaient débiteurs de 2 490 $ chacun.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- `admin_set_account_status` clôturait un compte quel que soit son solde
-- ----------------------------------------------------------------------------
--     update accounts set status = p_status, closed_at = ... where id = ...
--
-- Aucun contrôle de solde, alors que `admin_delete_account` — l'autre porte de
-- sortie — refuse justement de supprimer un compte dont le solde n'est pas nul
-- ou qui porte un historique. La clôture était donc la voie de contournement.
--
-- Ce n'est pas cosmétique. `client_total_balance()`, qui décide si un client
-- respecte le solde minimum et donc s'il peut faire un virement ou acheter un
-- lingot, EXCLUT les comptes clôturés :
--
--     select coalesce(sum(balance), 0) from accounts
--     where client_id = p_client_id and status != 'closed';
--
-- Clôturer un compte débiteur effaçait donc la dette du total du client, sans
-- que le moindre mouvement d'argent soit enregistré. Un client dont un compte
-- part en négatif voyait son patrimoine « remonter » d'autant.
--
-- Symétriquement, clôturer un compte CRÉDITEUR immobilise l'argent : il sort du
-- total du client, mais reste au bilan de la banque, sans propriétaire visible.
--
-- Un compte se solde avant de se clôturer. Pour ramener un solde à zéro,
-- l'écran /admin/treasury (migration 0024) le fait déjà, en traçant la
-- contrepartie.

create or replace function admin_set_account_status(p_account_id uuid, p_status account_status)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  a accounts%rowtype;
begin
  if not is_admin() then raise exception 'Réservé à l''admin'; end if;

  select * into a from accounts where id = p_account_id for update;
  if a is null then raise exception 'Compte introuvable'; end if;

  if p_status = 'closed' and a.balance <> 0 then
    raise exception
      'Impossible de clôturer le compte % : son solde est de % $. Soldez-le d''abord (écran Trésorerie) — sinon la somme disparaît du patrimoine du client sans qu''aucun mouvement ne soit enregistré.',
      a.iban, a.balance;
  end if;

  if a.is_bank_treasury and p_status <> 'active' then
    raise exception 'Le compte de trésorerie de la banque ne peut pas être gelé ni clôturé.';
  end if;

  update accounts set
    status = p_status,
    closed_at = case when p_status = 'closed' then now() else null end
  where id = p_account_id;

  perform log_audit('admin_set_account_status', 'accounts', p_account_id, jsonb_build_object(
    'iban', a.iban, 'avant', a.status, 'apres', p_status, 'solde', a.balance,
    'client', (select display_name from profiles where id = a.client_id)));
end;
$function$;


-- ----------------------------------------------------------------------------
-- Contrôle d'intégrité : les comptes clôturés à solde non nul
-- ----------------------------------------------------------------------------
-- Les deux comptes déjà clôturés en négatif ne sont PAS corrigés ici : leur
-- dette existe bel et bien dans le grand livre, et décider si la banque
-- l'efface, la recouvre ou la passe en perte est un choix de jeu, pas une
-- correction technique. La fonction ci-dessous les rend visibles.

create or replace function admin_list_account_anomalies()
returns table(account_id uuid, iban text, status account_status, balance numeric,
              client_name text, anomalie text)
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  return query
  select a.id, a.iban, a.status, a.balance, p.display_name,
         case
           when a.status = 'closed' and a.balance <> 0
             then 'Compte clôturé avec un solde non nul — la somme est sortie du patrimoine du client sans mouvement enregistré'
           when a.balance < 0
             then 'Solde négatif — découvert non encadré'
         end
  from accounts a
  left join profiles p on p.id = a.client_id
  where (a.status = 'closed' and a.balance <> 0) or a.balance < 0
  order by a.balance;
end;
$function$;


-- ----------------------------------------------------------------------------
-- Permissions (voir 0015 ; exceptions rappelées en 0021, 0022, 0026 à 0031).
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

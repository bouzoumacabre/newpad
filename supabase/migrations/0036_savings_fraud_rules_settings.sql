-- ============================================================================
-- NEWPAD — Migration 0036 : épargne, règles de fraude, paramètres économiques
-- ============================================================================
-- Audit fonctionnalité par fonctionnalité — étape 11.
-- ============================================================================


-- ############################################################################
-- PARTIE A — INTÉRÊTS D'ÉPARGNE
-- ############################################################################

-- ----------------------------------------------------------------------------
-- A1. La banque versait des intérêts sans vérifier qu'elle en avait les moyens
-- ----------------------------------------------------------------------------
-- `pay_savings_interest` crédite le client et débite la trésorerie, sans jamais
-- regarder ce que la trésorerie contient — le même défaut que le décaissement
-- de prêt (corrigé en 0027) et le dépôt d'ouverture (corrigé en 0020). Les
-- intérêts sont désactivés aujourd'hui (`savings_interest_enabled` = false) ;
-- le jour où ils seront activés, un versement mensuel sur un parc de comptes
-- épargne suffisamment garni ferait passer les fonds propres en négatif, en
-- silence et automatiquement, à 3 h 10 du matin.
--
-- A2. Un seul compte en échec interrompait TOUT le versement
-- ----------------------------------------------------------------------------
-- Même structure que le traitement des échéances de prêt avant la migration
-- 0028 : une exception sur un compte faisait tomber la boucle entière, et
-- personne n'était payé cette nuit-là. Chaque compte est désormais isolé.
--
-- Note : le taux est bien appliqué PAR VERSEMENT et non par an — le libellé du
-- paramètre le dit explicitement (« Taux d'épargne (%/versement) »), à la
-- différence du taux de prêt qui est annuel et divisé par douze. Ce n'est donc
-- pas une erreur, mais l'asymétrie mérite d'être connue.

create or replace function pay_savings_interest()
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  acc record;
  v_rate numeric;
  v_frequency_days int;
  v_amount numeric;
  v_bank_account uuid;
  v_last_paid timestamptz;
  v_treasury numeric;
  v_total numeric := 0;
  v_payes int := 0;
  v_err text;
begin
  if coalesce((get_setting('savings_interest_enabled')->>'enabled')::boolean, false) is not true then return; end if;
  v_rate := coalesce(get_setting_numeric('savings_rate'), 0) / 100;
  v_frequency_days := coalesce((get_setting('savings_payout_frequency_days')->>'amount')::int, 30);
  if v_rate <= 0 then return; end if;
  v_bank_account := bank_treasury_account_id();

  for acc in select * from accounts where status = 'active' and account_type = 'epargne' loop
    begin
      select max(created_at) into v_last_paid from transactions
      where tx_type = 'savings_interest' and to_account_id = acc.id;

      if v_last_paid is not null and v_last_paid > now() - (v_frequency_days || ' days')::interval then
        continue;
      end if;

      v_amount := round(acc.balance * v_rate, 2);
      if v_amount <= 0 then continue; end if;

      -- CORRECTIF 0036 : la banque ne verse que ce qu'elle possède.
      select balance into v_treasury from accounts where id = v_bank_account;
      if v_amount > v_treasury then
        perform notify_all_staff('savings_interest_halted',
          'Versement des intérêts d''épargne interrompu — trésorerie insuffisante',
          'Il manque ' || (v_amount - v_treasury) || ' $ pour honorer le compte suivant. ' ||
          v_payes || ' compte(s) déjà servi(s) pour ' || v_total || ' $.',
          '/admin/treasury', true);
        return;
      end if;

      perform _adjust_balance(acc.id, v_amount);
      perform _adjust_balance(v_bank_account, -v_amount);

      insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
      values ('savings_interest', 'validated', v_bank_account, acc.id, v_amount, 'Intérêts d''épargne', null);

      perform notify(acc.client_id, 'savings_interest', 'Intérêts d''épargne versés', v_amount || ' $', '/client/accounts');
      v_total := v_total + v_amount;
      v_payes := v_payes + 1;
    exception when others then
      v_err := sqlerrm;
      perform notify_all_staff('savings_interest_failed', 'Intérêts d''épargne non versés sur un compte',
        left(v_err, 200), '/employee/clients');
    end;
  end loop;

  if v_payes > 0 then
    perform log_audit('pay_savings_interest', 'accounts', null, jsonb_build_object(
      'comptes', v_payes, 'total', v_total, 'taux_par_versement', v_rate * 100));
  end if;
end;
$function$;


-- Même isolation pour les frais de gestion : une anomalie sur un compte ne doit
-- pas dispenser tous les autres de leurs frais.
create or replace function charge_account_fees()
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  acc record;
  v_fee_pct numeric;
  v_fee numeric;
  v_frequency_days int;
  v_bank_account uuid;
  v_tx_id uuid;
  v_last_charged timestamptz;
  v_err text;
begin
  v_fee_pct := coalesce(get_setting_numeric('account_fee_percent'), 0);
  v_frequency_days := coalesce((get_setting('account_fee_frequency_days')->>'amount')::int, 30);
  if v_fee_pct <= 0 then return; end if;
  v_bank_account := bank_treasury_account_id();

  for acc in select * from accounts where status = 'active' and is_bank_treasury = false loop
    begin
      select max(created_at) into v_last_charged from transactions
      where tx_type = 'fee_management' and from_account_id = acc.id;

      if v_last_charged is not null and v_last_charged > now() - (v_frequency_days || ' days')::interval then
        continue;
      end if;

      if acc.balance <= 0 then continue; end if;
      v_fee := round(acc.balance * v_fee_pct / 100, 2);
      if v_fee <= 0 then continue; end if;

      perform _adjust_balance(acc.id, -v_fee);
      perform _adjust_balance(v_bank_account, v_fee);

      insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
      values ('fee_management', 'validated', acc.id, v_bank_account, v_fee, 'Frais de gestion de compte (' || v_fee_pct || '%)', null)
      returning id into v_tx_id;

      perform notify(acc.client_id, 'fee_charged', 'Frais de gestion de compte prélevés', v_fee || ' $ (' || v_fee_pct || '% du solde)', '/client/accounts');

      if (select balance from accounts where id = acc.id) < 0 then
        perform notify(acc.client_id, 'account_negative', 'Votre compte est passé en négatif', null, '/client/accounts');
        perform notify_all_staff('account_negative', 'Compte client passé en négatif suite à des frais', acc.client_id::text, '/employee/clients');
      end if;

      if client_total_balance(acc.client_id) < coalesce(get_setting_numeric('min_client_balance', acc.client_id), 1000000) then
        -- CORRECTIF 0036 : la règle `balance_below_minimum` est déclarée au
        -- registre des fraudes depuis l'origine ; elle n'émettait jusqu'ici
        -- qu'une notification, jamais l'alerte correspondante.
        perform _system_fraud_alert('auto', 'balance_below_minimum', 'low', acc.client_id, acc.id, null,
          'Client sous le solde minimum après prélèvement des frais de gestion.');
      end if;
    exception when others then
      v_err := sqlerrm;
      perform notify_all_staff('fee_charge_failed', 'Frais de gestion non prélevés sur un compte',
        left(v_err, 200), '/employee/clients');
    end;
  end loop;
end;
$function$;


-- ############################################################################
-- PARTIE B — RÈGLES DE FRAUDE : DÉCLARÉES MAIS PAS BRANCHÉES
-- ############################################################################

-- ----------------------------------------------------------------------------
-- B1. Deux règles sur trois ne pouvaient pas se déclencher
-- ----------------------------------------------------------------------------
-- La table `fraud_rules` déclare trois règles, toutes marquées « activées » :
--
--   failed_login_attempts   → implémentée (record_login_attempt)
--   unusual_transfer_amount → N'EXISTE NULLE PART dans le code
--   balance_below_minimum   → n'émettait qu'une notification, pas d'alerte
--
-- Le seuil correspondant, `fraud_unusual_transfer_amount` (20 000 000 $),
-- figure dans l'écran Pilotage économique et n'est lu par AUCUNE fonction, ni
-- par le navigateur : un administrateur pouvait le régler avec soin sans que
-- cela ait le moindre effet.
--
-- Symétriquement, deux alertes bel et bien émises par le code
-- (`negative_balance`, `cashier_discrepancy`) n'étaient déclarées nulle part —
-- donc invisibles à l'écran des règles.
--
-- Enfin, la colonne `enabled` de `fraud_rules` n'était consultée par personne :
-- désactiver une règle ne la désactivait pas.

insert into fraud_rules (key, label, enabled, threshold_config)
values
  ('negative_balance', 'Compte client passé en négatif', true, '{}'::jsonb),
  ('cashier_discrepancy', 'Écart entre la caisse calculée et le solde réel', true, '{}'::jsonb)
on conflict (key) do nothing;


-- `enabled` devient effectif : une règle désactivée n'émet plus d'alerte. Les
-- signalements manuels (rule_key nul) ne sont jamais concernés.
create or replace function _system_fraud_alert(p_origin text, p_rule_key text, p_severity text, p_client_id uuid, p_account_id uuid, p_transaction_id uuid, p_description text)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
  v_enabled boolean;
begin
  if p_rule_key is not null then
    select enabled into v_enabled from fraud_rules where key = p_rule_key;
    if v_enabled is false then return null; end if;
  end if;

  insert into fraud_alerts (origin, rule_key, severity, related_client_id, related_account_id, related_transaction_id, description, created_by)
  values (p_origin, p_rule_key, p_severity, p_client_id, p_account_id, p_transaction_id, p_description,
          case when p_origin = 'manual' then auth.uid() else null end)
  returning id into v_id;
  perform notify_all_staff('fraud_alert', 'Nouvelle alerte fraude', p_description, '/employee/fraud');
  return v_id;
end;
$function$;


-- ----------------------------------------------------------------------------
-- B2. Implémentation de `unusual_transfer_amount`
-- ----------------------------------------------------------------------------
-- Le contrôle est posé à la DÉCISION du virement plutôt qu'à la demande : une
-- demande refusée n'a rien déplacé et n'a donc rien de suspect à signaler.
create or replace function _flag_unusual_transfer()
returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_seuil numeric;
  v_client uuid;
begin
  if new.tx_type <> 'transfer' or new.status <> 'validated' then return new; end if;

  v_seuil := get_setting_numeric('fraud_unusual_transfer_amount');
  if v_seuil is null or v_seuil <= 0 then return new; end if;
  if new.amount < v_seuil then return new; end if;

  select client_id into v_client from accounts where id = new.from_account_id;
  perform _system_fraud_alert('auto', 'unusual_transfer_amount', 'medium', v_client, new.from_account_id, new.id,
    'Virement de ' || new.amount || ' $ — au-delà du seuil de ' || v_seuil || ' $ défini en pilotage économique.');
  return new;
end;
$function$;

drop trigger if exists trg_flag_unusual_transfer on transactions;
create trigger trg_flag_unusual_transfer
after insert on transactions
for each row execute function _flag_unusual_transfer();


-- ############################################################################
-- PARTIE C — PARAMÈTRES ÉCONOMIQUES
-- ############################################################################

-- ----------------------------------------------------------------------------
-- C1. Aucune valeur n'était contrôlée à l'enregistrement
-- ----------------------------------------------------------------------------
-- L'écriture se fait directement dans la table depuis /admin/economic-settings.
-- Rien n'empêchait d'enregistrer un solde minimum négatif, une commission de
-- virement de 500 % (le client recevrait moins que rien), ou un plafond de prêt
-- négatif. Ces valeurs sont ensuite lues par les fonctions qui déplacent
-- l'argent, sans aucune vérification à ce moment-là non plus.

create or replace function _validate_economic_setting()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_amount numeric;
begin
  if new.value is null or jsonb_typeof(new.value) <> 'object' then
    raise exception 'La valeur du paramètre « % » doit être un objet JSON.', new.key;
  end if;

  if new.value ? 'amount' then
    begin
      v_amount := (new.value->>'amount')::numeric;
    exception when others then
      raise exception 'Le montant du paramètre « % » n''est pas un nombre.', new.key;
    end;

    if v_amount < 0 then
      raise exception 'Le paramètre « % » ne peut pas être négatif (valeur reçue : %).', new.key, v_amount;
    end if;

    -- Les clés exprimées en pourcentage doivent rester dans une plage qui a un
    -- sens : au-delà de 100 %, une commission dépasse le montant transféré.
    if new.key in ('transfer_commission_rate', 'marketplace_commission_rate', 'account_fee_percent',
                   'savings_rate', 'loan_rate', 'loan_late_penalty_rate',
                   'gold_price_max_move_percent', 'gold_price_smoothing')
       and v_amount > 100 then
      raise exception 'Le paramètre « % » est un pourcentage : % dépasse 100.', new.key, v_amount;
    end if;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_validate_economic_setting on economic_settings;
create trigger trg_validate_economic_setting
before insert or update on economic_settings
for each row execute function _validate_economic_setting();


-- ----------------------------------------------------------------------------
-- Permissions (voir 0015 ; exceptions rappelées en 0021, 0022, 0026 à 0035).
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

-- ============================================================================
-- NEWPAD — Migration 0002c : rendre les frais/intérêts périodiques sensibles
-- à leur fréquence configurable (account_fee_frequency_days,
-- savings_payout_frequency_days), plutôt que de s'appliquer à chaque exécution
-- du job planifié.
-- ============================================================================

create or replace function charge_account_fees() returns void
language plpgsql security definer as $$
declare
  acc record;
  v_fee numeric;
  v_frequency_days int;
  v_bank_account uuid;
  v_tx_id uuid;
  v_last_charged timestamptz;
begin
  v_fee := coalesce(get_setting_numeric('account_fee_amount'), 0);
  v_frequency_days := coalesce((get_setting('account_fee_frequency_days')->>'amount')::int, 30);
  if v_fee <= 0 then return; end if;
  v_bank_account := bank_treasury_account_id();

  for acc in select * from accounts where status = 'active' and is_bank_treasury = false loop
    select max(created_at) into v_last_charged from transactions
    where tx_type = 'fee_management' and from_account_id = acc.id;

    if v_last_charged is not null and v_last_charged > now() - (v_frequency_days || ' days')::interval then
      continue;
    end if;

    perform _adjust_balance(acc.id, -v_fee);
    perform _adjust_balance(v_bank_account, v_fee);

    insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
    values ('fee_management', 'validated', acc.id, v_bank_account, v_fee, 'Frais de gestion de compte', null)
    returning id into v_tx_id;

    perform notify(acc.client_id, 'fee_charged', 'Frais de gestion de compte prélevés', v_fee || ' $', '/client/accounts');

    if (select balance from accounts where id = acc.id) < 0 then
      perform notify(acc.client_id, 'account_negative', 'Votre compte est passé en négatif', null, '/client/accounts');
      perform notify_all_staff('account_negative', 'Compte client passé en négatif suite à des frais', acc.client_id::text, '/employee/clients');
    end if;

    if client_total_balance(acc.client_id) < coalesce(get_setting_numeric('min_client_balance', acc.client_id), 1000000) then
      perform notify_all_staff('below_minimum', 'Client sous le solde minimum après frais', acc.client_id::text, '/admin/clients', true);
    end if;
  end loop;
end;
$$;

create or replace function pay_savings_interest() returns void
language plpgsql security definer as $$
declare
  acc record;
  v_rate numeric;
  v_frequency_days int;
  v_amount numeric;
  v_bank_account uuid;
  v_last_paid timestamptz;
begin
  if coalesce((get_setting('savings_interest_enabled')->>'enabled')::boolean, false) is not true then return; end if;
  v_rate := coalesce(get_setting_numeric('savings_rate'), 0) / 100;
  v_frequency_days := coalesce((get_setting('savings_payout_frequency_days')->>'amount')::int, 30);
  if v_rate <= 0 then return; end if;
  v_bank_account := bank_treasury_account_id();

  for acc in select * from accounts where status = 'active' and account_type = 'epargne' loop
    select max(created_at) into v_last_paid from transactions
    where tx_type = 'savings_interest' and to_account_id = acc.id;

    if v_last_paid is not null and v_last_paid > now() - (v_frequency_days || ' days')::interval then
      continue;
    end if;

    v_amount := round(acc.balance * v_rate, 2);
    if v_amount <= 0 then continue; end if;
    perform _adjust_balance(acc.id, v_amount);
    perform _adjust_balance(v_bank_account, -v_amount);

    insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
    values ('savings_interest', 'validated', v_bank_account, acc.id, v_amount, 'Intérêts d''épargne', null);

    perform notify(acc.client_id, 'savings_interest', 'Intérêts d''épargne versés', v_amount || ' $', '/client/accounts');
  end loop;
end;
$$;

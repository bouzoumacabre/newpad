-- ############################################################################
-- 0063 — RAPPORT DE CAISSE : une correction se reporte au lendemain
-- ############################################################################
-- Le solde d'ouverture était « clôture de la veille MOINS la correction de la
-- veille ». Une correction manuelle (qui sert à expliquer un mouvement réel
-- de la trésorerie absent du grand livre du jour) disparaissait donc dès le
-- lendemain, et l'écart — avec son alerte fraude — revenait chaque jour.
-- Désormais, l'ouverture est la clôture de la veille, correction comprise.
-- Aucune correction n'avait jamais été saisie (45 rapports) : l'historique
-- n'est pas affecté.
--
-- Correction du jour : la réparation des livres (repairs/0002) a débité la
-- trésorerie de 3 004 531 $ en rattachant des dépôts d'août, sans transaction
-- datée d'aujourd'hui. Consignée ici, sinon le rapport de 23 h 55 lèverait
-- une fausse alerte d'écart de caisse.
-- ############################################################################

create or replace function public.generate_daily_cashier_report()
 returns void
 language plpgsql
 security definer
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

  select
    coalesce(sum(case when to_account_id   = v_bank_account then amount else 0 end), 0),
    coalesce(sum(case when from_account_id = v_bank_account then amount else 0 end), 0),
    coalesce(sum(case
      when coalesce(fee_amount, 0) > 0
       and to_account_id   is distinct from v_bank_account
       and from_account_id is distinct from v_bank_account
      then fee_amount
      when coalesce(fee_amount, 0) > 0
       and to_account_id = v_bank_account
       and fee_paid_by = 'sender'
      then fee_amount
      else 0 end), 0)
  into v_in, v_out, v_fees
  from transactions
  where created_at::date = current_date
    and status = 'validated';

  v_in := v_in + v_fees;

  select v_out - coalesce(sum(coalesce(fee_amount, 0)), 0) into v_out
  from transactions
  where created_at::date = current_date and status = 'validated'
    and from_account_id = v_bank_account
    and fee_paid_by = 'recipient';

  -- La clôture de la veille, correction comprise : c'est ce qui était
  -- réellement en caisse le soir.
  select closing_balance into v_prev_closing
  from cashier_reports where report_date = current_date - 1;

  if v_prev_closing is null then
    v_prev_closing := v_actual - v_in + v_out;
  end if;

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

  if abs(v_discrepancy) >= 0.01 then
    perform _system_fraud_alert('auto', 'cashier_discrepancy', 'high', null, v_bank_account, null,
      'Écart de caisse du ' || current_date || ' : ' || v_discrepancy ||
      ' $ entre le solde calculé (' || v_closing || ' $) et le solde réel de la trésorerie (' || v_actual || ' $).');
  end if;
end;
$function$;

-- La correction du 29/09/2026 (date de la réparation). Le rapport du soir
-- recalcule tout le reste et garde cette correction.
insert into cashier_reports (report_date, opening_balance, total_in, total_out, closing_balance,
                             actual_balance, discrepancy, money_supply,
                             adjustment_amount, adjustment_note, adjusted_at)
select date '2026-09-29', 0, 0, 0, 0, 0, 0, 0, -3004531.00,
       'Réparation des livres (repairs/0002) : la trésorerie paie les 9 dépôts d''ouverture d''août jamais débités.',
       now()
where current_date = date '2026-09-29'
on conflict (report_date) do update set
  adjustment_amount = coalesce(cashier_reports.adjustment_amount, 0) - 3004531.00,
  adjustment_note = coalesce(cashier_reports.adjustment_note || E'\n', '') || excluded.adjustment_note,
  adjusted_at = now();

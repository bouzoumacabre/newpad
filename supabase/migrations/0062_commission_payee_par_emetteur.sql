-- ############################################################################
-- 0062 — LA COMMISSION EST PAYÉE PAR L'ÉMETTEUR ET PAR L'ACHETEUR
-- ############################################################################
-- Décision de l'exploitant (29/09/2026). Jusqu'ici, le destinataire d'un
-- virement et le vendeur d'un lingot supportaient la commission. Désormais,
-- comme dans une banque classique : celui qui envoie ou achète paie le
-- montant PLUS la commission ; celui qui reçoit ou vend touche le montant
-- entier.
--
-- L'historique n'est PAS réécrit : chaque transaction porte désormais qui a
-- payé sa commission (`fee_paid_by`). Les anciennes restent `recipient`, les
-- nouvelles sont `sender`, et tous les calculs (contrôle d'intégrité, relevé
-- client, correction admin) suivent la ligne. Sans cette colonne, chaque
-- nouveau virement serait signalé comme une anomalie par le contrôle
-- d'intégrité, ou les anciens le deviendraient.
-- ############################################################################

alter table transactions add column if not exists fee_paid_by text not null default 'recipient';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'transactions_fee_paid_by_check') then
    alter table transactions add constraint transactions_fee_paid_by_check
      check (fee_paid_by in ('recipient', 'sender'));
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- Virements
-- ----------------------------------------------------------------------------
create or replace function public.decide_transfer(p_transfer_id uuid, p_approve boolean, p_note text default null::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  t transfers%rowtype;
  v_sender_client uuid;
  v_recipient_client uuid;
  v_sender_balance numeric;
  v_sender_status text;
  v_recipient_status text;
  v_new_total numeric;
  v_min_balance numeric;
  v_fee_rate numeric;
  v_fee numeric;
  v_tx_id uuid;
  v_bank_account uuid;
begin
  perform require_feature('employee.transfers.process');
  if not is_staff() then raise exception 'Réservé au personnel'; end if;

  select * into t from transfers where id = p_transfer_id for update;
  if t is null or t.status not in ('pending','processing') then
    raise exception 'Virement introuvable ou déjà décidé';
  end if;

  select client_id, balance, status into v_sender_client, v_sender_balance, v_sender_status
  from accounts where id = t.sender_account_id;
  select client_id, status into v_recipient_client, v_recipient_status
  from accounts where id = t.recipient_account_id;

  if not p_approve then
    update transfers set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = p_note
    where id = p_transfer_id;
    perform notify(v_sender_client, 'transfer_rejected', 'Virement refusé', p_note, '/client/transfers');
    perform log_audit('reject_transfer', 'transfers', p_transfer_id, jsonb_build_object(
      'client', (select display_name from profiles where id = v_sender_client), 'amount', t.amount, 'note', p_note));
    return;
  end if;

  if v_sender_status is null or v_sender_status <> 'active' then
    raise exception 'Le compte émetteur n''est plus actif (%). Refusez ce virement.', coalesce(v_sender_status, 'introuvable');
  end if;
  if v_recipient_status is null or v_recipient_status <> 'active' then
    raise exception 'Le compte destinataire n''est plus actif (%). Refusez ce virement.', coalesce(v_recipient_status, 'introuvable');
  end if;

  -- La commission est calculée AVANT les contrôles de solde : c'est
  -- l'émetteur qui la paie, elle fait partie de ce qu'il doit avoir.
  if t.is_internal then
    v_fee := 0;
  else
    v_fee_rate := coalesce((get_setting('transfer_commission_rate')->>'amount')::numeric, 0);
    v_fee := round(t.amount * v_fee_rate / 100, 2);
  end if;

  if t.amount + v_fee > v_sender_balance then
    raise exception 'Solde insuffisant sur le compte émetteur : % $ disponibles pour un virement de % $ (commission de % $ comprise).',
      v_sender_balance, t.amount + v_fee, v_fee;
  end if;

  if not t.is_internal then
    v_min_balance := coalesce(get_setting_numeric('min_client_balance', v_sender_client), 1000000);
    v_new_total := client_total_balance(v_sender_client) - t.amount - v_fee;

    if v_new_total < v_min_balance and not is_admin() then
      update transfers set status = 'pending', requires_admin_override = true, processing_by = auth.uid(), processing_at = now()
      where id = p_transfer_id;
      perform notify_all_staff('transfer_needs_admin', 'Virement sous le solde minimum — autorisation admin requise', t.amount || ' $', '/admin/transfers', true);
      return;
    end if;
  end if;

  v_bank_account := bank_treasury_account_id();

  perform _adjust_balance(t.sender_account_id, -(t.amount + v_fee));
  perform _adjust_balance(t.recipient_account_id, t.amount);
  if v_fee > 0 then
    perform _adjust_balance(v_bank_account, v_fee);
  end if;

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, fee_amount, fee_paid_by, description, related_request_type, related_request_id, created_by)
  values ('transfer', 'validated', t.sender_account_id, t.recipient_account_id, t.amount, v_fee, 'sender', t.motif, 'transfers', t.id, auth.uid())
  returning id into v_tx_id;

  update transfers set status = 'validated', decided_by = auth.uid(), decided_at = now(), decision_note = p_note, resulting_transaction_id = v_tx_id
  where id = p_transfer_id;

  perform notify(v_sender_client, 'transfer_validated', 'Virement validé',
    t.amount || ' $' || case when v_fee > 0 then ' (+ ' || v_fee || ' $ de commission)' else '' end, '/client/transfers');
  if v_recipient_client is not null and v_recipient_client != v_sender_client then
    perform notify(v_recipient_client, 'transfer_received', 'Virement reçu', t.amount || ' $', '/client/transfers');
  end if;
  perform log_audit('approve_transfer', 'transfers', p_transfer_id, jsonb_build_object(
    'client', (select display_name from profiles where id = v_sender_client), 'amount', t.amount, 'fee', v_fee, 'fee_paid_by', 'sender'));
end;
$function$;

-- ----------------------------------------------------------------------------
-- Marché de revente des lingots
-- ----------------------------------------------------------------------------
create or replace function public.decide_market_purchase(p_request_id uuid, p_approve boolean, p_note text default null::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  r gold_market_purchase_requests%rowtype;
  l gold_market_listings%rowtype;
  v_bar gold_bars%rowtype;
  v_buyer_account uuid;
  v_buyer_balance numeric;
  v_seller_account uuid;
  v_bank_account uuid;
  v_fee_rate numeric;
  v_fee numeric;
  v_tx_id uuid;
  v_min_balance numeric;
  v_new_total numeric;
begin
  perform require_feature('employee.gold.process');
  if not is_staff() then raise exception 'Réservé au personnel'; end if;

  select * into r from gold_market_purchase_requests where id = p_request_id and status in ('pending','processing') for update;
  if r is null then raise exception 'Demande introuvable'; end if;

  select * into l from gold_market_listings where id = r.listing_id for update;

  if not p_approve then
    update gold_market_purchase_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now() where id = p_request_id;
    perform notify(r.buyer_client_id, 'gold_market_rejected', 'Achat marché refusé', p_note, '/client/gold/market');
    perform log_audit('reject_gold_market_purchase', 'gold_market_purchase_requests', p_request_id, jsonb_build_object(
      'buyer', (select display_name from profiles where id = r.buyer_client_id), 'price', l.listed_price));
    return;
  end if;

  if l is null then raise exception 'Annonce introuvable'; end if;
  if l.status <> 'active' then
    raise exception 'Ce lingot a déjà été vendu (annonce %). Refusez cette demande.', l.status;
  end if;

  select * into v_bar from gold_bars where id = l.gold_bar_id;
  if v_bar is null or v_bar.status <> 'listed'
     or coalesce(v_bar.owner_client_id::text, '') <> coalesce(l.seller_client_id::text, '') then
    raise exception 'Le lingot de cette annonce n''est plus disponible à la vente. Refusez cette demande.';
  end if;

  -- Commission payée par l'acheteur, en plus du prix ; aucune quand c'est la
  -- banque elle-même qui vend.
  if l.seller_client_id is null then
    v_fee := 0;
  else
    v_fee_rate := coalesce((get_setting('marketplace_commission_rate')->>'amount')::numeric, 0);
    v_fee := round(l.listed_price * v_fee_rate / 100, 2);
  end if;

  v_min_balance := coalesce(get_setting_numeric('min_client_balance', r.buyer_client_id), 1000000);
  v_new_total := client_total_balance(r.buyer_client_id) - l.listed_price - v_fee;
  if v_new_total < v_min_balance and not is_admin() then
    update gold_market_purchase_requests set status = 'pending', processing_by = auth.uid(), processing_at = now() where id = p_request_id;
    perform notify_all_staff('gold_market_needs_admin', 'Achat marché sous le solde minimum — autorisation admin requise', l.listed_price || ' $', '/admin/gold', true);
    return;
  end if;

  select id, balance into v_buyer_account, v_buyer_balance
  from accounts where client_id = r.buyer_client_id and status = 'active'
  order by is_bank_treasury, opened_at limit 1;

  if v_buyer_account is null then
    raise exception 'L''acheteur n''a aucun compte actif pour régler cet achat.';
  end if;

  if l.listed_price + v_fee > v_buyer_balance then
    raise exception 'Solde insuffisant sur le compte de l''acheteur : % $ disponibles pour un achat de % $ (commission de % $ comprise).',
      v_buyer_balance, l.listed_price + v_fee, v_fee;
  end if;

  v_bank_account := bank_treasury_account_id();

  perform _adjust_balance(v_buyer_account, -(l.listed_price + v_fee));

  if l.seller_client_id is null then
    perform _adjust_balance(v_bank_account, l.listed_price);
  else
    select id into v_seller_account from accounts where client_id = l.seller_client_id and status='active' order by is_bank_treasury, opened_at limit 1;
    if v_seller_account is null then
      raise exception 'Le vendeur n''a plus de compte actif pour encaisser cette vente.';
    end if;
    perform _adjust_balance(v_seller_account, l.listed_price);
    if v_fee > 0 then
      perform _adjust_balance(v_bank_account, v_fee);
    end if;
  end if;

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, fee_amount, fee_paid_by, description, related_request_type, related_request_id, created_by)
  values ('gold_purchase_market', 'validated', v_buyer_account, v_seller_account, l.listed_price, v_fee, 'sender', 'Achat marché lingot ' || l.gold_bar_id, 'gold_market_purchase_requests', r.id, auth.uid())
  returning id into v_tx_id;

  update gold_bars set status = 'sold', owner_client_id = r.buyer_client_id where id = l.gold_bar_id;
  update gold_market_listings set status = 'sold' where id = l.id;
  update gold_market_purchase_requests set status = 'validated', decided_by = auth.uid(), decided_at = now(), resulting_transaction_id = v_tx_id,
    admin_authorized_by = case when is_admin() and v_new_total < v_min_balance then auth.uid() else null end
  where id = p_request_id;

  update gold_market_purchase_requests
  set status = 'rejected', decided_by = auth.uid(), decided_at = now()
  where listing_id = l.id and id <> p_request_id and status in ('pending', 'processing');

  if l.seller_client_id is not null then
    perform _update_gold_price_from_sale(l.listed_price, v_bar.weight_grams, v_tx_id);
  end if;

  perform notify(r.buyer_client_id, 'gold_market_validated', 'Achat marché validé',
    l.listed_price || ' $' || case when v_fee > 0 then ' (+ ' || v_fee || ' $ de commission)' else '' end, '/client/gold/market');
  if l.seller_client_id is not null then
    perform notify(l.seller_client_id, 'gold_market_sold', 'Votre lingot a été vendu', l.listed_price || ' $', '/client/gold/market');
  end if;
  perform log_audit('approve_gold_market_purchase', 'gold_market_purchase_requests', p_request_id, jsonb_build_object(
    'buyer', (select display_name from profiles where id = r.buyer_client_id),
    'price', l.listed_price, 'fee', v_fee, 'fee_paid_by', 'sender', 'gold_bar_id', l.gold_bar_id));
end;
$function$;

-- ----------------------------------------------------------------------------
-- Contrôle d'intégrité : chaque transaction dit qui a payé sa commission
-- ----------------------------------------------------------------------------
create or replace function public.admin_check_ledger_integrity()
 returns table(anomalie text, detail text, montant numeric)
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;

  return query
    select 'Transaction sans contrepartie'::text,
           t.tx_type || ' du ' || to_char(t.created_at, 'DD/MM/YYYY') ||
             case when t.from_account_id is null then ' (crédit sans émetteur)' else ' (débit sans destinataire)' end,
           t.amount
    from transactions t
    where t.status = 'validated'
      and t.tx_type <> 'money_issuance'
      and (t.from_account_id is null or t.to_account_id is null);

  return query
    select 'Virement sur le même compte'::text,
           'Transaction ' || t.id::text,
           t.amount
    from transactions t
    where t.tx_type = 'transfer' and t.from_account_id = t.to_account_id;

  return query
    with mouvements as (
      select from_account_id as acc,
             -(amount + case when fee_paid_by = 'sender' then coalesce(fee_amount, 0) else 0 end) as delta
        from transactions where status='validated' and from_account_id is not null
      union all
      select to_account_id,
             amount - case when fee_paid_by = 'recipient' then coalesce(fee_amount, 0) else 0 end
        from transactions where status='validated' and to_account_id is not null
      union all
      select (select id from accounts where is_bank_treasury), coalesce(fee_amount, 0)
        from transactions where status='validated' and coalesce(fee_amount, 0) <> 0
    ),
    ecarts as (
      select a.iban,
             coalesce(pr.display_name, 'Trésorerie') as titulaire,
             round(a.balance - coalesce(sum(m.delta), 0)
                   - case when a.is_bank_treasury then 250000000 else 0 end, 2) as ecart
      from accounts a
      left join mouvements m on m.acc = a.id
      left join profiles pr on pr.id = a.client_id
      group by a.id, a.iban, a.balance, a.is_bank_treasury, pr.display_name
    )
    select 'Solde incohérent avec le grand livre'::text,
           e.titulaire || ' (' || e.iban || ')',
           e.ecart
    from ecarts e
    where e.ecart <> 0;

  return query
    select 'Émission monétaire cumulée (information)'::text,
           count(*)::text || ' opération(s) admin depuis l''origine',
           round(sum(case when t.to_account_id is not null then t.amount else -t.amount end), 2)
    from transactions t
    where t.status = 'validated' and t.tx_type = 'money_issuance'
    having count(*) > 0;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Rapport de caisse : la trésorerie encaisse la commission en plus du montant
-- quand un client lui vire de l'argent en payant la commission lui-même.
-- Sans cela, écart de caisse (et alerte fraude) à chaque virement vers la
-- banque.
-- ----------------------------------------------------------------------------
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

  -- Commission payée par le destinataire sur une sortie de la trésorerie :
  -- elle lui revient aussitôt, la sortie nette est donc réduite d'autant.
  select v_out - coalesce(sum(coalesce(fee_amount, 0)), 0) into v_out
  from transactions
  where created_at::date = current_date and status = 'validated'
    and from_account_id = v_bank_account
    and fee_paid_by = 'recipient';

  select closing_balance - coalesce(adjustment_amount, 0)
  into v_prev_closing
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

-- ----------------------------------------------------------------------------
-- Relevé client : le montant net suit le payeur de la commission
-- ----------------------------------------------------------------------------
create or replace function public.my_transactions(p_search text default null::text, p_tx_type text default null::text, p_from date default null::date, p_to date default null::date, p_limit integer default 50, p_offset integer default 0)
 returns table(id uuid, tx_type text, status request_status, amount numeric, fee_amount numeric, net_amount numeric, description text, created_at timestamp with time zone, from_account_id uuid, to_account_id uuid, counterpart_label text, sens text, total_count bigint)
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  return query
  with mes_comptes as (
    select a.id as compte_id from accounts a where a.client_id = auth.uid()
  ),
  filtre as (
    select t.id, t.tx_type, t.status, t.amount, t.fee_amount,
           case when t.from_account_id in (select mc.compte_id from mes_comptes mc)
                then -(t.amount + case when t.fee_paid_by = 'sender' then coalesce(t.fee_amount, 0) else 0 end)
                else t.amount - case when t.fee_paid_by = 'recipient' then coalesce(t.fee_amount, 0) else 0 end
           end as net_amount,
           t.description, t.created_at,
           t.from_account_id, t.to_account_id,
           case
             when t.from_account_id in (select mc.compte_id from mes_comptes mc)
               then coalesce(pt.display_name, case when at_.is_bank_treasury then 'Newman Bank' else null end, 'Externe')
             else coalesce(pf.display_name, case when af.is_bank_treasury then 'Newman Bank' else null end, 'Externe')
           end as counterpart_label,
           case when t.from_account_id in (select mc.compte_id from mes_comptes mc) then 'debit' else 'credit' end as sens
    from transactions t
    left join accounts af on af.id = t.from_account_id
    left join accounts at_ on at_.id = t.to_account_id
    left join profiles pf on pf.id = af.client_id
    left join profiles pt on pt.id = at_.client_id
    where (t.from_account_id in (select mc.compte_id from mes_comptes mc)
           or t.to_account_id in (select mc.compte_id from mes_comptes mc))
      and visible_for_current_role('transaction', t.id)
      and (p_tx_type is null or p_tx_type = '' or t.tx_type = p_tx_type)
      and (p_from is null or t.created_at >= p_from)
      and (p_to is null or t.created_at < (p_to + 1))
      and (p_search is null or trim(p_search) = ''
           or t.description ilike '%' || p_search || '%'
           or t.amount::text ilike '%' || p_search || '%')
  )
  select f.*, (select count(*) from filtre) as total_count
  from filtre f
  order by f.created_at desc
  limit least(coalesce(p_limit, 50), 500)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$function$;

-- ----------------------------------------------------------------------------
-- Correction admin d'une transaction : l'écart de commission touche le payeur
-- ----------------------------------------------------------------------------
create or replace function public.admin_correct_transaction_amount(p_transaction_id uuid, p_new_amount numeric, p_note text default null::text, p_new_fee numeric default null::numeric)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  t transactions%rowtype;
  v_bank_account uuid;
  v_delta numeric;
  v_delta_fee numeric;
  v_new_fee numeric;
begin
  perform require_feature('admin.treasury.manage');
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  if p_new_amount is null or p_new_amount < 0 then
    raise exception 'Le nouveau montant doit être positif ou nul';
  end if;

  select * into t from transactions where id = p_transaction_id for update;
  if not found then raise exception 'Transaction introuvable'; end if;

  v_new_fee := coalesce(p_new_fee, t.fee_amount, 0);
  if v_new_fee < 0 then raise exception 'La commission ne peut pas être négative'; end if;
  if t.fee_paid_by = 'recipient' and v_new_fee > p_new_amount then
    raise exception 'La commission (% $) ne peut pas dépasser le montant (% $)', v_new_fee, p_new_amount;
  end if;

  v_delta     := round(p_new_amount - t.amount, 2);
  v_delta_fee := round(v_new_fee - coalesce(t.fee_amount, 0), 2);

  if v_delta = 0 and v_delta_fee = 0 then
    raise exception 'Cette transaction porte déjà ce montant et cette commission';
  end if;

  v_bank_account := bank_treasury_account_id();

  if t.from_account_id is not null then
    perform _adjust_balance(t.from_account_id,
      -v_delta - case when t.fee_paid_by = 'sender' then v_delta_fee else 0 end);
  end if;
  if t.to_account_id is not null then
    perform _adjust_balance(t.to_account_id,
      v_delta - case when t.fee_paid_by = 'recipient' then v_delta_fee else 0 end);
  end if;
  if v_delta_fee <> 0 then
    perform _adjust_balance(v_bank_account, v_delta_fee);
  end if;

  update transactions
  set amount = p_new_amount,
      fee_amount = v_new_fee,
      description = coalesce(description, '') ||
        ' [corrigé le ' || to_char(now(), 'DD/MM/YYYY') ||
        case when p_note is not null and trim(p_note) <> '' then ' : ' || trim(p_note) else '' end || ']'
  where id = p_transaction_id;

  perform log_audit('admin_correct_transaction_amount', 'transactions', p_transaction_id, jsonb_build_object(
    'ancien_montant', t.amount, 'nouveau_montant', p_new_amount,
    'ancienne_commission', t.fee_amount, 'nouvelle_commission', v_new_fee,
    'payeur_commission', t.fee_paid_by, 'note', p_note));
end;
$function$;

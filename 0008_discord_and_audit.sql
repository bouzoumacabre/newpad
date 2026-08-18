-- ============================================================================
-- NEWPAD — Migration 0008 : identifiant Discord + journal d'activité enrichi
-- ============================================================================
-- 1) Ajoute profiles.discord_id (facultatif), rempli à l'inscription et par le
--    personnel. Prépare le terrain pour la réinitialisation de mot de passe
--    via Discord (à venir, nécessite un bot Discord côté Edge Function).
-- 2) Ajoute des appels log_audit() manquants sur les fonctions de décision
--    métier (virements, prêts, lingots, coffres, adhésion, support,
--    consulting) — jusqu'ici seules quelques actions purement admin étaient
--    journalisées ; l'essentiel du travail quotidien du personnel ne
--    laissait aucune trace exploitable dans /admin/audit.
-- 3) Corrige un trou : les virements internes (entre comptes du même client)
--    ne notifiaient jamais le personnel, contrairement aux virements
--    externes — ils pouvaient rester "en attente" indéfiniment sans que
--    personne ne soit prévenu.
-- ============================================================================

alter table profiles add column if not exists discord_id text;
comment on column profiles.discord_id is 'Identifiant Discord (ID numérique) — utilisé pour la réinitialisation de mot de passe et la liaison de compte.';

-- ----------------------------------------------------------------------------
-- 1) Auto-création du profil : reprend aussi discord_id depuis les métadonnées
-- ----------------------------------------------------------------------------

create or replace function handle_new_auth_user() returns trigger
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
begin
  insert into profiles (id, username, role, display_name, discord_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'prospect'),
    coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    nullif(new.raw_user_meta_data->>'discord_id', '')
  );
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 2) VIREMENTS — journal + correction de la notification interne manquante
-- ----------------------------------------------------------------------------

create or replace function submit_transfer(p_sender_account_id uuid, p_recipient_account_id uuid, p_amount numeric, p_motif text) returns uuid
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_client_id uuid;
  v_recipient_client_id uuid;
  v_is_internal boolean;
  v_min_amount numeric;
  v_id uuid;
begin
  select client_id into v_client_id from accounts where id = p_sender_account_id;
  if v_client_id is null or v_client_id != auth.uid() then
    raise exception 'Compte émetteur invalide';
  end if;
  select client_id into v_recipient_client_id from accounts where id = p_recipient_account_id;
  if v_recipient_client_id is null then
    raise exception 'Compte destinataire invalide';
  end if;

  v_is_internal := (v_recipient_client_id = v_client_id);

  if not v_is_internal then
    v_min_amount := coalesce(get_setting_numeric('min_transfer_amount', v_client_id), 100000);
    if p_amount < v_min_amount then
      raise exception 'Le montant minimum de virement est de % $', v_min_amount;
    end if;
  end if;

  if p_amount <= 0 then
    raise exception 'Montant invalide';
  end if;

  insert into transfers (sender_account_id, recipient_account_id, amount, motif, is_internal)
  values (p_sender_account_id, p_recipient_account_id, p_amount, p_motif, v_is_internal)
  returning id into v_id;

  -- Corrigé (0008) : auparavant seuls les virements externes notifiaient le
  -- personnel ; les virements internes pouvaient rester invisibles.
  perform notify_all_staff('transfer_request', 'Nouveau virement à traiter', p_amount || ' $', '/employee/operations/transfers');

  return v_id;
end;
$$;

create or replace function claim_transfer(p_transfer_id uuid) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_client_id uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  update transfers set status = 'processing', processing_by = auth.uid(), processing_at = now()
  where id = p_transfer_id and status = 'pending';
  if not found then raise exception 'Virement introuvable ou déjà en traitement'; end if;

  select client_id into v_client_id from accounts a join transfers t on t.sender_account_id = a.id where t.id = p_transfer_id;
  perform notify(v_client_id, 'transfer_processing', 'Virement en cours de traitement', null, '/client/transfers');
  perform log_audit('claim_transfer', 'transfers', p_transfer_id, jsonb_build_object('client', (select display_name from profiles where id = v_client_id)));
end;
$$;

create or replace function decide_transfer(p_transfer_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  t transfers%rowtype;
  v_sender_client uuid;
  v_recipient_client uuid;
  v_new_total numeric;
  v_min_balance numeric;
  v_fee_rate numeric;
  v_fee numeric;
  v_tx_id uuid;
  v_bank_account uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;

  select * into t from transfers where id = p_transfer_id for update;
  if t is null or t.status not in ('pending','processing') then
    raise exception 'Virement introuvable ou déjà décidé';
  end if;

  select client_id into v_sender_client from accounts where id = t.sender_account_id;
  select client_id into v_recipient_client from accounts where id = t.recipient_account_id;

  if not p_approve then
    update transfers set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = p_note
    where id = p_transfer_id;
    perform notify(v_sender_client, 'transfer_rejected', 'Virement refusé', p_note, '/client/transfers');
    perform log_audit('reject_transfer', 'transfers', p_transfer_id, jsonb_build_object(
      'client', (select display_name from profiles where id = v_sender_client), 'amount', t.amount, 'note', p_note));
    return;
  end if;

  if not t.is_internal then
    v_min_balance := coalesce(get_setting_numeric('min_client_balance', v_sender_client), 1000000);
    v_new_total := client_total_balance(v_sender_client) - t.amount;

    if v_new_total < v_min_balance and not is_admin() then
      update transfers set status = 'pending', requires_admin_override = true, processing_by = auth.uid(), processing_at = now()
      where id = p_transfer_id;
      perform notify_all_staff('transfer_needs_admin', 'Virement sous le solde minimum — autorisation admin requise', t.amount || ' $', '/admin/operations/transfers', true);
      perform log_audit('transfer_flagged_needs_admin', 'transfers', p_transfer_id, jsonb_build_object('amount', t.amount, 'projected_total', v_new_total));
      return; -- état métier normal : en attente d'un admin, pas une erreur
    end if;

    if v_new_total < v_min_balance and is_admin() then
      update transfers set admin_authorized_by = auth.uid(), requires_admin_override = true where id = p_transfer_id;
    end if;
  end if;

  v_bank_account := bank_treasury_account_id();
  v_fee_rate := coalesce((get_setting('transfer_commission_rate')->>'amount')::numeric, 0);
  v_fee := round(t.amount * v_fee_rate / 100, 2);

  perform _adjust_balance(t.sender_account_id, -t.amount);
  perform _adjust_balance(t.recipient_account_id, t.amount - v_fee);
  if v_fee > 0 and not t.is_internal then
    perform _adjust_balance(v_bank_account, v_fee);
  end if;

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, fee_amount, description, related_request_type, related_request_id, created_by)
  values ('transfer', 'validated', t.sender_account_id, t.recipient_account_id, t.amount, case when t.is_internal then 0 else v_fee end, t.motif, 'transfers', t.id, auth.uid())
  returning id into v_tx_id;

  update transfers set status = 'validated', decided_by = auth.uid(), decided_at = now(), decision_note = p_note, resulting_transaction_id = v_tx_id
  where id = p_transfer_id;

  perform notify(v_sender_client, 'transfer_validated', 'Virement validé', t.amount || ' $', '/client/transfers');
  if v_recipient_client is not null and v_recipient_client != v_sender_client then
    perform notify(v_recipient_client, 'transfer_received', 'Virement reçu', (t.amount - v_fee) || ' $', '/client/transfers');
  end if;
  perform log_audit('approve_transfer', 'transfers', p_transfer_id, jsonb_build_object(
    'from', (select display_name from profiles where id = v_sender_client),
    'to', (select display_name from profiles where id = v_recipient_client),
    'amount', t.amount, 'fee', v_fee));
end;
$$;

-- ----------------------------------------------------------------------------
-- 2) LINGOTS D'OR (banque + marché) — journal
-- ----------------------------------------------------------------------------

create or replace function decide_gold_bank_purchase(p_request_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  r gold_bank_purchase_requests%rowtype;
  v_client_account uuid;
  v_bank_account uuid;
  v_tx_id uuid;
  v_min_balance numeric;
  v_new_total numeric;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into r from gold_bank_purchase_requests where id = p_request_id and status in ('pending','processing') for update;
  if r is null then raise exception 'Demande introuvable'; end if;

  if not p_approve then
    update gold_bank_purchase_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now() where id = p_request_id;
    update gold_bars set status = 'in_vault' where id = r.gold_bar_id;
    perform notify(r.client_id, 'gold_purchase_rejected', 'Achat de lingot refusé', p_note, '/client/gold');
    perform log_audit('reject_gold_bank_purchase', 'gold_bank_purchase_requests', p_request_id, jsonb_build_object(
      'client', (select display_name from profiles where id = r.client_id), 'price', r.price));
    return;
  end if;

  v_min_balance := coalesce(get_setting_numeric('min_client_balance', r.client_id), 1000000);
  v_new_total := client_total_balance(r.client_id) - r.price;
  if v_new_total < v_min_balance and not is_admin() then
    update gold_bank_purchase_requests set status = 'pending', processing_by = auth.uid(), processing_at = now() where id = p_request_id;
    perform notify_all_staff('gold_purchase_needs_admin', 'Achat de lingot sous le solde minimum — autorisation admin requise', r.price || ' $', '/admin/operations/gold', true);
    return;
  end if;

  select id into v_client_account from accounts where client_id = r.client_id and status = 'active' order by is_bank_treasury, opened_at limit 1;
  v_bank_account := bank_treasury_account_id();

  perform _adjust_balance(v_client_account, -r.price);
  perform _adjust_balance(v_bank_account, r.price);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, related_request_type, related_request_id, created_by)
  values ('gold_purchase_bank', 'validated', v_client_account, v_bank_account, r.price, 'Achat lingot ' || r.gold_bar_id, 'gold_bank_purchase_requests', r.id, auth.uid())
  returning id into v_tx_id;

  update gold_bars set status = 'sold', owner_client_id = r.client_id where id = r.gold_bar_id;
  update gold_bank_purchase_requests set status = 'validated', decided_by = auth.uid(), decided_at = now(), resulting_transaction_id = v_tx_id,
    admin_authorized_by = case when is_admin() and v_new_total < v_min_balance then auth.uid() else null end
  where id = p_request_id;

  perform notify(r.client_id, 'gold_purchase_validated', 'Achat de lingot validé', r.price || ' $', '/client/gold');
  perform log_audit('approve_gold_bank_purchase', 'gold_bank_purchase_requests', p_request_id, jsonb_build_object(
    'client', (select display_name from profiles where id = r.client_id), 'price', r.price, 'gold_bar_id', r.gold_bar_id));
end;
$$;

create or replace function decide_market_purchase(p_request_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  r gold_market_purchase_requests%rowtype;
  l gold_market_listings%rowtype;
  v_buyer_account uuid;
  v_seller_account uuid;
  v_bank_account uuid;
  v_fee_rate numeric;
  v_fee numeric;
  v_tx_id uuid;
  v_min_balance numeric;
  v_new_total numeric;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into r from gold_market_purchase_requests where id = p_request_id and status in ('pending','processing') for update;
  if r is null then raise exception 'Demande introuvable'; end if;
  select * into l from gold_market_listings where id = r.listing_id;

  if not p_approve then
    update gold_market_purchase_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now() where id = p_request_id;
    perform notify(r.buyer_client_id, 'gold_market_rejected', 'Achat marché refusé', p_note, '/client/gold/market');
    perform log_audit('reject_gold_market_purchase', 'gold_market_purchase_requests', p_request_id, jsonb_build_object(
      'buyer', (select display_name from profiles where id = r.buyer_client_id), 'price', l.listed_price));
    return;
  end if;

  v_min_balance := coalesce(get_setting_numeric('min_client_balance', r.buyer_client_id), 1000000);
  v_new_total := client_total_balance(r.buyer_client_id) - l.listed_price;
  if v_new_total < v_min_balance and not is_admin() then
    update gold_market_purchase_requests set status = 'pending', processing_by = auth.uid(), processing_at = now() where id = p_request_id;
    perform notify_all_staff('gold_market_needs_admin', 'Achat marché sous le solde minimum — autorisation admin requise', l.listed_price || ' $', '/admin/operations/gold', true);
    return;
  end if;

  select id into v_buyer_account from accounts where client_id = r.buyer_client_id and status='active' order by is_bank_treasury, opened_at limit 1;
  select id into v_seller_account from accounts where client_id = l.seller_client_id and status='active' order by is_bank_treasury, opened_at limit 1;
  v_bank_account := bank_treasury_account_id();
  v_fee_rate := coalesce((get_setting('marketplace_commission_rate')->>'amount')::numeric, 0);
  v_fee := round(l.listed_price * v_fee_rate / 100, 2);

  perform _adjust_balance(v_buyer_account, -l.listed_price);
  perform _adjust_balance(v_seller_account, l.listed_price - v_fee);
  perform _adjust_balance(v_bank_account, v_fee);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, fee_amount, description, related_request_type, related_request_id, created_by)
  values ('gold_purchase_market', 'validated', v_buyer_account, v_seller_account, l.listed_price, v_fee, 'Achat marché lingot ' || l.gold_bar_id, 'gold_market_purchase_requests', r.id, auth.uid())
  returning id into v_tx_id;

  update gold_bars set status = 'sold', owner_client_id = r.buyer_client_id where id = l.gold_bar_id;
  update gold_market_listings set status = 'sold' where id = l.id;
  update gold_market_purchase_requests set status = 'validated', decided_by = auth.uid(), decided_at = now(), resulting_transaction_id = v_tx_id,
    admin_authorized_by = case when is_admin() and v_new_total < v_min_balance then auth.uid() else null end
  where id = p_request_id;

  perform notify(r.buyer_client_id, 'gold_market_validated', 'Achat marché validé', l.listed_price || ' $', '/client/gold/market');
  perform notify(l.seller_client_id, 'gold_market_sold', 'Votre lingot a été vendu', (l.listed_price - v_fee) || ' $', '/client/gold/market');
  perform log_audit('approve_gold_market_purchase', 'gold_market_purchase_requests', p_request_id, jsonb_build_object(
    'buyer', (select display_name from profiles where id = r.buyer_client_id),
    'seller', (select display_name from profiles where id = l.seller_client_id),
    'price', l.listed_price, 'fee', v_fee));
end;
$$;

-- ----------------------------------------------------------------------------
-- 2) COFFRES-FORTS — journal
-- ----------------------------------------------------------------------------

create or replace function claim_safe_request(p_request_id uuid, p_safe_box_id uuid, p_appointment_at timestamptz, p_appointment_location text) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_client uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  update safe_rental_requests set status='processing', safe_box_id = p_safe_box_id, appointment_at = p_appointment_at,
    appointment_location = p_appointment_location, processing_by = auth.uid(), processing_at = now()
  where id = p_request_id and status = 'pending'
  returning client_id into v_client;
  if not found then raise exception 'Demande introuvable'; end if;
  update safe_deposit_boxes set status = 'reserved' where id = p_safe_box_id;
  perform notify(v_client, 'safe_appointment', 'Rendez-vous programmé pour votre coffre', p_appointment_at::text, '/client/safes');
  perform log_audit('claim_safe_request', 'safe_rental_requests', p_request_id, jsonb_build_object(
    'client', (select display_name from profiles where id = v_client), 'appointment_at', p_appointment_at));
end;
$$;

create or replace function confirm_safe_rental(p_request_id uuid) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  r safe_rental_requests%rowtype;
  b safe_deposit_boxes%rowtype;
  v_account uuid;
  v_bank_account uuid;
  v_tx_id uuid;
  v_min_balance numeric;
  v_new_total numeric;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into r from safe_rental_requests where id = p_request_id and status = 'processing' for update;
  if r is null then raise exception 'Demande introuvable'; end if;
  select * into b from safe_deposit_boxes where id = r.safe_box_id;

  v_min_balance := coalesce(get_setting_numeric('min_client_balance', r.client_id), 1000000);
  v_new_total := client_total_balance(r.client_id) - b.annual_fee;
  if v_new_total < v_min_balance and not is_admin() then
    perform notify_all_staff('safe_needs_admin', 'Location de coffre sous le solde minimum — autorisation admin requise', b.code, '/admin/operations/safes', true);
    return; -- reste en 'processing' ; un admin doit relancer confirm_safe_rental
  end if;

  select id into v_account from accounts where client_id = r.client_id and status='active' order by is_bank_treasury, opened_at limit 1;
  v_bank_account := bank_treasury_account_id();

  perform _adjust_balance(v_account, -b.annual_fee);
  perform _adjust_balance(v_bank_account, b.annual_fee);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, related_request_type, related_request_id, created_by)
  values ('safe_rental', 'validated', v_account, v_bank_account, b.annual_fee, 'Location coffre ' || b.code, 'safe_rental_requests', r.id, auth.uid())
  returning id into v_tx_id;

  update safe_deposit_boxes set status = 'rented', client_id = r.client_id, rented_since = current_date where id = b.id;
  update safe_rental_requests set status = 'validated', confirmed_by = auth.uid(), confirmed_at = now(), resulting_transaction_id = v_tx_id
  where id = p_request_id;

  perform notify(r.client_id, 'safe_validated', 'Location de coffre confirmée', b.code, '/client/safes');
  perform log_audit('confirm_safe_rental', 'safe_rental_requests', p_request_id, jsonb_build_object(
    'client', (select display_name from profiles where id = r.client_id), 'safe_code', b.code, 'annual_fee', b.annual_fee));
end;
$$;

-- ----------------------------------------------------------------------------
-- 2) PRÊTS — journal (revue employé + décision finale admin)
-- ----------------------------------------------------------------------------

create or replace function employee_review_loan(p_loan_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_client uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  update loans set status = 'processing', employee_reviewed_by = auth.uid(), employee_reviewed_at = now(), decision_note = p_note
  where id = p_loan_id and status = 'pending'
  returning client_id into v_client;
  if not found then raise exception 'Prêt introuvable'; end if;
  perform log_audit('employee_review_loan', 'loans', p_loan_id, jsonb_build_object('client', (select display_name from profiles where id = v_client)));
end;
$$;

create or replace function admin_decide_loan(p_loan_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  l loans%rowtype;
  v_rate numeric;
  v_monthly numeric;
  v_bank_account uuid;
  v_client_account uuid;
  v_tx_id uuid;
  i int;
  v_balance numeric;
  v_interest numeric;
  v_principal numeric;
begin
  if not is_admin() then raise exception 'Seul l''admin peut valider un prêt'; end if;
  select * into l from loans where id = p_loan_id and status in ('pending','processing') for update;
  if l is null then raise exception 'Prêt introuvable'; end if;

  if not p_approve then
    update loans set status = 'rejected', admin_decided_by = auth.uid(), admin_decided_at = now(), decision_note = p_note where id = p_loan_id;
    perform notify(l.client_id, 'loan_rejected', 'Demande de prêt refusée', p_note, '/client/loans');
    perform log_audit('reject_loan', 'loans', p_loan_id, jsonb_build_object(
      'client', (select display_name from profiles where id = l.client_id), 'amount', l.requested_amount, 'note', p_note));
    return;
  end if;

  v_rate := coalesce(get_setting_numeric('loan_rate', l.client_id), 5) / 100;
  v_bank_account := bank_treasury_account_id();
  select id into v_client_account from accounts where client_id = l.client_id and status='active' order by is_bank_treasury, opened_at limit 1;

  perform _adjust_balance(v_client_account, l.requested_amount);
  perform _adjust_balance(v_bank_account, -l.requested_amount);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, related_request_type, related_request_id, created_by)
  values ('loan_disbursement', 'validated', v_bank_account, v_client_account, l.requested_amount, 'Décaissement prêt', 'loans', l.id, auth.uid())
  returning id into v_tx_id;

  update loans set status = 'active', interest_rate = v_rate, outstanding_balance = l.requested_amount,
    admin_decided_by = auth.uid(), admin_decided_at = now(), decision_note = p_note,
    disbursed_at = now(), disbursement_account_id = v_client_account, disbursement_transaction_id = v_tx_id
  where id = p_loan_id;

  -- Génération de l'échéancier (amortissement linéaire simplifié)
  v_balance := l.requested_amount;
  for i in 1..l.term_months loop
    v_interest := round(v_balance * v_rate / 12, 2);
    v_principal := round(l.requested_amount / l.term_months, 2);
    insert into loan_schedules (loan_id, installment_number, due_date, amount_due, principal, interest)
    values (l.id, i, (current_date + (i || ' months')::interval)::date, v_principal + v_interest, v_principal, v_interest);
    v_balance := v_balance - v_principal;
  end loop;

  perform notify(l.client_id, 'loan_approved', 'Prêt validé et décaissé', l.requested_amount || ' $', '/client/loans');
  perform log_audit('approve_loan', 'loans', p_loan_id, jsonb_build_object(
    'client', (select display_name from profiles where id = l.client_id), 'amount', l.requested_amount, 'rate', v_rate, 'term_months', l.term_months));
end;
$$;

-- ----------------------------------------------------------------------------
-- 2) ADHÉSION — journal du refus (l'approbation avait déjà log_audit)
-- ----------------------------------------------------------------------------

create or replace function decide_membership_request(p_request_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  m membership_requests%rowtype;
  v_min_balance numeric;
  v_account_id uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into m from membership_requests where id = p_request_id and status in ('pending','processing') for update;
  if m is null then raise exception 'Demande introuvable'; end if;

  if not p_approve then
    update membership_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now() where id = p_request_id;
    perform notify(m.applicant_id, 'membership_rejected', 'Votre demande d''adhésion a été refusée', p_note, null);
    perform log_audit('reject_membership', 'membership_requests', p_request_id, jsonb_build_object(
      'applicant', (select display_name from profiles where id = m.applicant_id), 'note', p_note));
    return;
  end if;

  v_min_balance := coalesce(get_setting_numeric('min_client_balance', m.applicant_id), 1000000);
  if m.initial_deposit < v_min_balance and not is_admin() then
    update membership_requests set status = 'pending', requires_admin_override = true, processing_by = auth.uid(), processing_at = now()
    where id = p_request_id;
    perform notify_all_staff('membership_needs_admin', 'Adhésion sous le solde minimum — autorisation admin requise', m.applicant_id::text, '/admin/clients/membership', true);
    return;
  end if;

  insert into accounts (client_id, account_type, iban, balance, opened_by)
  values (m.applicant_id, coalesce(m.requested_account_type, 'courant'), generate_iban(), m.initial_deposit, auth.uid())
  returning id into v_account_id;

  perform _bypass_profile_guard();
  update profiles set role = 'client', client_since = current_date where id = m.applicant_id;

  if m.initial_deposit > 0 then
    insert into transactions (tx_type, status, to_account_id, amount, description, created_by)
    values ('cash_deposit', 'validated', v_account_id, m.initial_deposit, 'Dépôt initial à l''ouverture', auth.uid());
  end if;

  update membership_requests set status = 'validated', decided_by = auth.uid(), decided_at = now(),
    created_account_id = v_account_id, admin_authorized_by = case when is_admin() and m.initial_deposit < v_min_balance then auth.uid() else null end
  where id = p_request_id;

  perform notify(m.applicant_id, 'membership_approved', 'Bienvenue chez Newman Bank', 'Votre compte client est actif.', '/client');
  perform log_audit('approve_membership', 'membership_requests', p_request_id, jsonb_build_object(
    'applicant', (select display_name from profiles where id = m.applicant_id), 'initial_deposit', m.initial_deposit));
end;
$$;

-- ----------------------------------------------------------------------------
-- 2) SUPPORT & CONSULTING — journal
-- ----------------------------------------------------------------------------

create or replace function resolve_support_ticket(p_ticket_id uuid) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_client uuid; v_subject text;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  update support_tickets set status = 'resolved', resolved_at = now() where id = p_ticket_id
  returning client_id, subject into v_client, v_subject;
  if not found then raise exception 'Ticket introuvable'; end if;
  perform log_audit('resolve_support_ticket', 'support_tickets', p_ticket_id, jsonb_build_object(
    'client', (select display_name from profiles where id = v_client), 'subject', v_subject));
end;
$$;

create or replace function assign_consulting_request(p_id uuid, p_advisor_id uuid) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare v_client uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  update consulting_requests set status = 'assigned', assigned_advisor_id = p_advisor_id where id = p_id returning client_id into v_client;
  perform notify(v_client, 'consulting_assigned', 'Un conseiller vous a été attribué', null, '/client/consulting');
  perform log_audit('assign_consulting_request', 'consulting_requests', p_id, jsonb_build_object(
    'client', (select display_name from profiles where id = v_client), 'advisor', (select display_name from profiles where id = p_advisor_id)));
end;
$$;

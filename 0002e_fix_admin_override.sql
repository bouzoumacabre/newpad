-- ============================================================================
-- NEWPAD — Migration 0002e : correction du garde-fou "solde minimum → admin"
-- ============================================================================
-- Bug corrigé : dans la version initiale, `update ... set requires_admin_override
-- = true` était immédiatement suivi d'un `raise exception` DANS LA MÊME
-- fonction — or une exception PL/pgSQL annule (rollback) tous les effets de
-- l'appel de fonction en cours, y compris cet update. Le drapeau ne
-- persistait donc jamais, et admin_authorized_by n'était jamais renseigné.
-- Correction : on n'utilise plus `raise exception` pour ce cas — c'est un
-- état métier normal, pas une erreur. La fonction persiste le drapeau et
-- retourne normalement ; le personnel voit alors (via lecture/realtime) que
-- la demande est passée en "nécessite une autorisation admin".
--
-- Complément : le même garde-fou (solde minimum → admin uniquement) est
-- maintenant aussi appliqué à l'achat de lingot (banque + marché) et à la
-- confirmation de location de coffre, comme l'exige le cahier des charges
-- ("Toute transaction qui ferait passer le solde total d'un client sous ce
-- seuil ... ne peut pas être validée par un simple employé"), pas seulement
-- aux virements.
-- ============================================================================

create or replace function decide_transfer(p_transfer_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer as $$
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
end;
$$;

create or replace function decide_membership_request(p_request_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer as $$
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
  perform log_audit('approve_membership', 'membership_requests', p_request_id, '{}');
end;
$$;

create or replace function finalize_manual_account_opening(p_opening_id uuid, p_client_profile_id uuid) returns uuid
language plpgsql security definer as $$
declare
  o manual_account_openings%rowtype;
  v_min_balance numeric;
  v_account_id uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into o from manual_account_openings where id = p_opening_id for update;
  if o is null then raise exception 'Ouverture introuvable'; end if;

  v_min_balance := coalesce(get_setting_numeric('min_client_balance', p_client_profile_id), 1000000);
  if o.initial_deposit < v_min_balance and not is_admin() then
    update manual_account_openings set requires_admin_override = true where id = p_opening_id;
    perform notify_all_staff('account_opening_needs_admin', 'Ouverture de compte sous le solde minimum — autorisation admin requise', o.display_name, '/admin/clients/openings', true);
    raise exception 'Le dépôt initial est sous le solde minimum requis (%). Autorisation admin nécessaire — demande enregistrée en attente.', v_min_balance;
  end if;

  insert into accounts (client_id, account_type, iban, balance, opened_by)
  values (p_client_profile_id, o.account_type, generate_iban(), o.initial_deposit, auth.uid())
  returning id into v_account_id;

  if o.initial_deposit > 0 then
    insert into transactions (tx_type, status, to_account_id, amount, description, created_by)
    values ('cash_deposit', 'validated', v_account_id, o.initial_deposit, 'Dépôt initial à l''ouverture (guichet)', auth.uid());
  end if;

  update manual_account_openings set status = 'validated', client_id = p_client_profile_id, created_account_id = v_account_id, decided_at = now(),
    admin_authorized_by = case when is_admin() and o.initial_deposit < v_min_balance then auth.uid() else null end
  where id = p_opening_id;

  return v_account_id;
end;
$$;

create or replace function decide_gold_bank_purchase(p_request_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer as $$
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
end;
$$;

create or replace function decide_market_purchase(p_request_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer as $$
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
end;
$$;

create or replace function confirm_safe_rental(p_request_id uuid) returns void
language plpgsql security definer as $$
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
end;
$$;

-- ============================================================================
-- NEWPAD — Migration 0002 : fonctions utilitaires & logique métier atomique
-- ============================================================================
-- Toutes les fonctions de mouvement de solde sont SECURITY DEFINER + plpgsql :
-- chaque fonction s'exécute dans une seule transaction Postgres implicite,
-- donc tout débit/crédit + écriture transactions + notification est atomique.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- HELPERS D'IDENTITÉ & PERMISSIONS
-- ----------------------------------------------------------------------------

create or replace function current_role_name() returns user_role
language sql stable security definer as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function is_admin() returns boolean
language sql stable security definer as $$
  select coalesce((select role = 'admin' from profiles where id = auth.uid()), false);
$$;

create or replace function is_staff() returns boolean
language sql stable security definer as $$
  select coalesce((select role in ('employee','admin') from profiles where id = auth.uid()), false);
$$;

create or replace function is_irs() returns boolean
language sql stable security definer as $$
  select coalesce((select role = 'irs' from profiles where id = auth.uid()), false);
$$;

create or replace function has_feature(p_key text, p_uid uuid default auth.uid()) returns boolean
language plpgsql stable security definer as $$
declare
  v_role user_role;
  v_default_roles user_role[];
  v_enabled boolean;
  v_override boolean;
begin
  select role into v_role from profiles where id = p_uid;
  if v_role is null then return false; end if;
  if v_role = 'admin' then return true; end if; -- l'admin a toujours accès (Principe 2/3)

  select default_roles, enabled into v_default_roles, v_enabled
  from feature_registry where key = p_key;

  if v_default_roles is null then return false; end if; -- fonctionnalité inconnue
  if not v_enabled then return false; end if;

  select granted into v_override
  from permission_grants where account_id = p_uid and feature_key = p_key;

  if v_override is not null then
    return v_override;
  end if;

  return v_role = any(v_default_roles);
end;
$$;

-- ----------------------------------------------------------------------------
-- PARAMÈTRES ÉCONOMIQUES (globaux + exception par client)
-- ----------------------------------------------------------------------------

create or replace function get_setting(p_key text, p_client_id uuid default null) returns jsonb
language plpgsql stable security definer as $$
declare
  v_override jsonb;
  v_global jsonb;
begin
  if p_client_id is not null then
    select value into v_override from client_setting_overrides
    where client_id = p_client_id and setting_key = p_key;
    if v_override is not null then return v_override; end if;
  end if;
  select value into v_global from economic_settings where key = p_key;
  return v_global;
end;
$$;

create or replace function get_setting_numeric(p_key text, p_client_id uuid default null) returns numeric
language sql stable security definer as $$
  select (get_setting(p_key, p_client_id)->>'amount')::numeric;
$$;

-- ----------------------------------------------------------------------------
-- SOLDES
-- ----------------------------------------------------------------------------

create or replace function _adjust_balance(p_account_id uuid, p_delta numeric) returns numeric
language plpgsql security definer as $$
declare
  v_new numeric;
begin
  update accounts set balance = balance + p_delta where id = p_account_id
  returning balance into v_new;
  if v_new is null then
    raise exception 'Compte introuvable: %', p_account_id;
  end if;
  return v_new;
end;
$$;

create or replace function client_total_balance(p_client_id uuid) returns numeric
language sql stable security definer as $$
  select coalesce(sum(balance), 0) from accounts
  where client_id = p_client_id and status != 'closed';
$$;

create or replace function bank_treasury_account_id() returns uuid
language sql stable security definer as $$
  select id from accounts where is_bank_treasury = true limit 1;
$$;

-- ----------------------------------------------------------------------------
-- AUDIT, NOTIFICATIONS, ALERTES
-- ----------------------------------------------------------------------------

create or replace function log_audit(p_action text, p_target_type text default null, p_target_id uuid default null, p_details jsonb default '{}') returns void
language plpgsql security definer as $$
begin
  insert into audit_log (actor_id, actor_role, action, target_type, target_id, details)
  values (auth.uid(), (select role from profiles where id = auth.uid()), p_action, p_target_type, p_target_id, p_details);
end;
$$;

create or replace function notify(p_recipient_id uuid, p_type text, p_title text, p_body text default null, p_link text default null, p_metadata jsonb default '{}') returns void
language plpgsql security definer as $$
begin
  insert into notifications (recipient_id, type, title, body, link, metadata)
  values (p_recipient_id, p_type, p_title, p_body, p_link, p_metadata);
end;
$$;

create or replace function notify_all_staff(p_type text, p_title text, p_body text default null, p_link text default null, p_admin_only boolean default false) returns void
language plpgsql security definer as $$
begin
  insert into notifications (recipient_id, type, title, body, link)
  select id, p_type, p_title, p_body, p_link from profiles
  where (case when p_admin_only then role = 'admin' else role in ('employee','admin') end)
    and status = 'active';
end;
$$;

create or replace function create_fraud_alert(p_origin text, p_rule_key text, p_severity text, p_client_id uuid, p_account_id uuid, p_transaction_id uuid, p_description text) returns uuid
language plpgsql security definer as $$
declare
  v_id uuid;
begin
  insert into fraud_alerts (origin, rule_key, severity, related_client_id, related_account_id, related_transaction_id, description, created_by)
  values (p_origin, p_rule_key, p_severity, p_client_id, p_account_id, p_transaction_id, p_description, case when p_origin = 'manual' then auth.uid() else null end)
  returning id into v_id;
  perform notify_all_staff('fraud_alert', 'Nouvelle alerte fraude', p_description, '/employee/fraud');
  return v_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- MASQUAGE GÉNÉRIQUE
-- ----------------------------------------------------------------------------

create or replace function is_masked_for(p_target_type visibility_target, p_target_id uuid, p_iface app_interface) returns boolean
language sql stable security definer as $$
  select coalesce(
    (select p_iface = any(hidden_from_interfaces) from visibility_masks
     where target_type = p_target_type and target_id = p_target_id),
    false
  );
$$;

-- ----------------------------------------------------------------------------
-- NOTE DE CONFIANCE
-- ----------------------------------------------------------------------------

-- Autorise, pour la durée de la transaction en cours seulement, une fonction
-- SECURITY DEFINER de confiance à modifier les champs protégés de `profiles`
-- (role/status/trust_score/...) malgré le garde-fou anti self-update
-- (trg_enforce_profile_self_update, migration 0003b). Jamais exposé au client.
create or replace function _bypass_profile_guard() returns void
language sql as $$
  select set_config('app.bypass_profile_guard', 'true', true);
$$;

create or replace function adjust_trust_score(p_client_id uuid, p_delta numeric) returns void
language plpgsql security definer as $$
begin
  perform _bypass_profile_guard();
  update profiles set trust_score = greatest(0, least(100, trust_score + p_delta))
  where id = p_client_id;
end;
$$;

-- ============================================================================
-- VIREMENTS
-- ============================================================================

create or replace function submit_transfer(p_sender_account_id uuid, p_recipient_account_id uuid, p_amount numeric, p_motif text) returns uuid
language plpgsql security definer as $$
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

  if not v_is_internal then
    perform notify_all_staff('transfer_request', 'Nouveau virement à traiter', p_amount || ' $', '/employee/operations/transfers');
  end if;

  return v_id;
end;
$$;

create or replace function claim_transfer(p_transfer_id uuid) returns void
language plpgsql security definer as $$
declare
  v_client_id uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  update transfers set status = 'processing', processing_by = auth.uid(), processing_at = now()
  where id = p_transfer_id and status = 'pending';
  if not found then raise exception 'Virement introuvable ou déjà en traitement'; end if;

  select client_id into v_client_id from accounts a join transfers t on t.sender_account_id = a.id where t.id = p_transfer_id;
  perform notify(v_client_id, 'transfer_processing', 'Virement en cours de traitement', null, '/client/transfers');
end;
$$;

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

  -- Vérification solde minimum (hors virements internes)
  if not t.is_internal then
    v_min_balance := coalesce(get_setting_numeric('min_client_balance', v_sender_client), 1000000);
    v_new_total := client_total_balance(v_sender_client) - t.amount;
    if v_new_total < v_min_balance and not (t.requires_admin_override and is_admin()) then
      if not is_admin() then
        update transfers set status = 'pending', requires_admin_override = true where id = p_transfer_id;
        perform notify_all_staff('transfer_needs_admin', 'Virement sous le solde minimum — autorisation admin requise', t.amount || ' $', '/admin/operations/transfers', true);
        raise exception 'Ce virement ferait passer le client sous le solde minimum requis (%). Autorisation admin nécessaire.', v_min_balance;
      end if;
    end if;
    if t.requires_admin_override then
      update transfers set admin_authorized_by = auth.uid() where id = p_transfer_id;
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

-- ============================================================================
-- LINGOTS D'OR
-- ============================================================================

create or replace function mint_gold_bar(p_serial text, p_weight_grams numeric, p_notes text default null) returns uuid
language plpgsql security definer as $$
declare
  v_id uuid;
begin
  if not is_admin() then raise exception 'Réservé à l''admin'; end if;
  insert into gold_bars (serial_number, weight_grams, minted_by, notes)
  values (p_serial, p_weight_grams, auth.uid(), p_notes)
  returning id into v_id;
  perform log_audit('mint_gold_bar', 'gold_bars', v_id, jsonb_build_object('serial', p_serial, 'weight', p_weight_grams));
  return v_id;
end;
$$;

create or replace function admin_update_gold_bar(p_gold_bar_id uuid, p_status gold_bar_status default null, p_location text default null, p_owner_client_id uuid default null, p_notes text default null) returns void
language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'Réservé à l''admin'; end if;
  update gold_bars set
    status = coalesce(p_status, status),
    location = coalesce(p_location, location),
    owner_client_id = case when p_owner_client_id is not null then p_owner_client_id else owner_client_id end,
    notes = coalesce(p_notes, notes)
  where id = p_gold_bar_id;
  perform log_audit('admin_update_gold_bar', 'gold_bars', p_gold_bar_id, jsonb_build_object('status', p_status, 'owner', p_owner_client_id));
end;
$$;

create or replace function submit_gold_bank_purchase(p_gold_bar_id uuid) returns uuid
language plpgsql security definer as $$
declare
  v_bar gold_bars%rowtype;
  v_price numeric;
  v_id uuid;
begin
  select * into v_bar from gold_bars where id = p_gold_bar_id and owner_client_id is null and status = 'in_vault';
  if v_bar is null then raise exception 'Lingot indisponible'; end if;
  v_price := round(v_bar.weight_grams * coalesce(get_setting_numeric('gold_price_per_gram'), 60), 2);

  insert into gold_bank_purchase_requests (client_id, gold_bar_id, price)
  values (auth.uid(), p_gold_bar_id, v_price)
  returning id into v_id;

  update gold_bars set status = 'reserved' where id = p_gold_bar_id;
  perform notify_all_staff('gold_bank_purchase_request', 'Nouvelle demande d''achat de lingot', v_price || ' $', '/employee/operations/gold');
  return v_id;
end;
$$;

create or replace function decide_gold_bank_purchase(p_request_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer as $$
declare
  r gold_bank_purchase_requests%rowtype;
  v_client_account uuid;
  v_bank_account uuid;
  v_tx_id uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into r from gold_bank_purchase_requests where id = p_request_id for update;
  if r is null or r.status not in ('pending','processing') then raise exception 'Demande introuvable'; end if;

  if not p_approve then
    update gold_bank_purchase_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now() where id = p_request_id;
    update gold_bars set status = 'in_vault' where id = r.gold_bar_id;
    perform notify(r.client_id, 'gold_purchase_rejected', 'Achat de lingot refusé', p_note, '/client/gold');
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
  update gold_bank_purchase_requests set status = 'validated', decided_by = auth.uid(), decided_at = now(), resulting_transaction_id = v_tx_id where id = p_request_id;

  perform notify(r.client_id, 'gold_purchase_validated', 'Achat de lingot validé', r.price || ' $', '/client/gold');
end;
$$;

create or replace function create_market_listing(p_gold_bar_id uuid, p_price numeric) returns uuid
language plpgsql security definer as $$
declare
  v_bar gold_bars%rowtype;
  v_min numeric; v_max numeric;
  v_id uuid;
begin
  select * into v_bar from gold_bars where id = p_gold_bar_id and owner_client_id = auth.uid() and status = 'in_vault';
  if v_bar is null then raise exception 'Lingot indisponible pour la revente'; end if;

  v_min := coalesce(get_setting_numeric('gold_listing_min_price'), 0);
  v_max := coalesce(get_setting_numeric('gold_listing_max_price'), 999999999);
  if p_price < v_min or p_price > v_max then
    raise exception 'Le prix doit être compris entre % $ et % $', v_min, v_max;
  end if;

  insert into gold_market_listings (seller_client_id, gold_bar_id, listed_price)
  values (auth.uid(), p_gold_bar_id, p_price)
  returning id into v_id;

  update gold_bars set status = 'listed' where id = p_gold_bar_id;
  return v_id;
end;
$$;

create or replace function submit_market_purchase(p_listing_id uuid) returns uuid
language plpgsql security definer as $$
declare
  v_id uuid;
begin
  if not exists (select 1 from gold_market_listings where id = p_listing_id and status = 'active') then
    raise exception 'Annonce indisponible';
  end if;
  insert into gold_market_purchase_requests (listing_id, buyer_client_id)
  values (p_listing_id, auth.uid())
  returning id into v_id;
  perform notify_all_staff('gold_market_request', 'Nouvelle transaction marché de revente', null, '/employee/operations/gold');
  return v_id;
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
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into r from gold_market_purchase_requests where id = p_request_id for update;
  if r is null or r.status not in ('pending','processing') then raise exception 'Demande introuvable'; end if;
  select * into l from gold_market_listings where id = r.listing_id;

  if not p_approve then
    update gold_market_purchase_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now() where id = p_request_id;
    perform notify(r.buyer_client_id, 'gold_market_rejected', 'Achat marché refusé', p_note, '/client/gold/market');
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
  update gold_market_purchase_requests set status = 'validated', decided_by = auth.uid(), decided_at = now(), resulting_transaction_id = v_tx_id where id = p_request_id;

  perform notify(r.buyer_client_id, 'gold_market_validated', 'Achat marché validé', l.listed_price || ' $', '/client/gold/market');
  perform notify(l.seller_client_id, 'gold_market_sold', 'Votre lingot a été vendu', (l.listed_price - v_fee) || ' $', '/client/gold/market');
end;
$$;

-- ============================================================================
-- COFFRES-FORTS
-- ============================================================================

create or replace function submit_safe_request() returns uuid
language plpgsql security definer as $$
declare
  v_id uuid;
begin
  insert into safe_rental_requests (client_id) values (auth.uid()) returning id into v_id;
  perform notify_all_staff('safe_request', 'Nouvelle demande de coffre-fort', null, '/employee/operations/safes');
  return v_id;
end;
$$;

create or replace function claim_safe_request(p_request_id uuid, p_safe_box_id uuid, p_appointment_at timestamptz, p_appointment_location text) returns void
language plpgsql security definer as $$
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
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into r from safe_rental_requests where id = p_request_id and status = 'processing' for update;
  if r is null then raise exception 'Demande introuvable'; end if;
  select * into b from safe_deposit_boxes where id = r.safe_box_id;

  select id into v_account from accounts where client_id = r.client_id and status='active' order by is_bank_treasury, opened_at limit 1;
  v_bank_account := bank_treasury_account_id();

  perform _adjust_balance(v_account, -b.annual_fee);
  perform _adjust_balance(v_bank_account, b.annual_fee);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, related_request_type, related_request_id, created_by)
  values ('safe_rental', 'validated', v_account, v_bank_account, b.annual_fee, 'Location coffre ' || b.code, 'safe_rental_requests', r.id, auth.uid())
  returning id into v_tx_id;

  update safe_deposit_boxes set status = 'rented', client_id = r.client_id, rented_since = current_date where id = b.id;
  update safe_rental_requests set status = 'validated', confirmed_by = auth.uid(), confirmed_at = now(), resulting_transaction_id = v_tx_id where id = p_request_id;

  perform notify(r.client_id, 'safe_validated', 'Location de coffre confirmée', b.code, '/client/safes');
end;
$$;

-- ============================================================================
-- PRÊTS PROFESSIONNELS
-- ============================================================================

create or replace function submit_loan_request(p_amount numeric, p_purpose text, p_term_months int) returns uuid
language plpgsql security definer as $$
declare
  v_cap numeric;
  v_id uuid;
begin
  v_cap := coalesce(get_setting_numeric('loan_cap', auth.uid()), 50000000);
  if p_amount > v_cap then raise exception 'Le montant dépasse le plafond de prêt autorisé (% $)', v_cap; end if;
  insert into loans (client_id, requested_amount, purpose, term_months)
  values (auth.uid(), p_amount, p_purpose, p_term_months)
  returning id into v_id;
  perform notify_all_staff('loan_request', 'Nouvelle demande de prêt', p_amount || ' $', '/admin/operations/loans', true);
  return v_id;
end;
$$;

create or replace function employee_review_loan(p_loan_id uuid, p_note text default null) returns void
language plpgsql security definer as $$
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  update loans set status = 'processing', employee_reviewed_by = auth.uid(), employee_reviewed_at = now(), decision_note = p_note
  where id = p_loan_id and status = 'pending';
  if not found then raise exception 'Prêt introuvable'; end if;
end;
$$;

create or replace function admin_decide_loan(p_loan_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer as $$
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
end;
$$;

create or replace function repay_loan_installment_now(p_schedule_id uuid) returns void
language plpgsql security definer as $$
declare
  s loan_schedules%rowtype;
  l loans%rowtype;
  v_client_account uuid;
  v_bank_account uuid;
  v_tx_id uuid;
  v_penalty_rate numeric;
  v_penalty numeric := 0;
  v_amount numeric;
begin
  select * into s from loan_schedules where id = p_schedule_id and status = 'pending' for update;
  if s is null then raise exception 'Échéance introuvable'; end if;
  select * into l from loans where id = s.loan_id;

  select id into v_client_account from accounts where client_id = l.client_id and status='active' order by is_bank_treasury, opened_at limit 1;
  v_bank_account := bank_treasury_account_id();

  if s.due_date < current_date then
    v_penalty_rate := coalesce(get_setting_numeric('loan_late_penalty_rate', l.client_id), 5) / 100;
    v_penalty := round(s.amount_due * v_penalty_rate, 2);
  end if;
  v_amount := s.amount_due + v_penalty;

  -- Le prélèvement s'effectue même à découvert (jamais bloqué)
  perform _adjust_balance(v_client_account, -v_amount);
  perform _adjust_balance(v_bank_account, v_amount);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, related_request_type, related_request_id, created_by)
  values ('loan_repayment', 'validated', v_client_account, v_bank_account, v_amount,
    'Échéance prêt #' || s.installment_number || case when v_penalty > 0 then ' (+ pénalité de retard)' else '' end,
    'loan_schedules', s.id, null)
  returning id into v_tx_id;

  update loan_schedules set status = case when v_penalty > 0 then 'late' else 'paid' end, penalty_applied = v_penalty, paid_at = now(), resulting_transaction_id = v_tx_id
  where id = p_schedule_id;

  update loans set outstanding_balance = greatest(0, outstanding_balance - s.principal) where id = l.id;

  if v_penalty > 0 then
    perform adjust_trust_score(l.client_id, -5);
    perform notify(l.client_id, 'loan_late', 'Échéance de prêt impayée — pénalité appliquée', v_amount || ' $', '/client/loans');
    perform notify_all_staff('loan_late', 'Échéance de prêt impayée', l.client_id::text, '/employee/clients');
  else
    perform adjust_trust_score(l.client_id, 1);
    perform notify(l.client_id, 'loan_installment_paid', 'Échéance de prêt prélevée', v_amount || ' $', '/client/loans');
  end if;

  if (select count(*) from accounts where id = v_client_account and balance < 0) > 0 then
    perform notify(l.client_id, 'account_negative', 'Votre compte est passé en négatif', null, '/client/accounts');
    perform notify_all_staff('account_negative', 'Compte client passé en négatif', l.client_id::text, '/employee/clients');
  end if;
end;
$$;

create or replace function repay_loan_early(p_loan_id uuid) returns void
language plpgsql security definer as $$
declare
  l loans%rowtype;
  v_client_account uuid;
  v_bank_account uuid;
  v_remaining numeric;
  v_tx_id uuid;
begin
  select * into l from loans where id = p_loan_id and client_id = auth.uid() and status = 'active' for update;
  if l is null then raise exception 'Prêt introuvable'; end if;

  select coalesce(sum(amount_due),0) into v_remaining from loan_schedules where loan_id = p_loan_id and status = 'pending';
  if v_remaining <= 0 then raise exception 'Aucune échéance restante'; end if;

  select id into v_client_account from accounts where client_id = l.client_id and status='active' order by is_bank_treasury, opened_at limit 1;
  v_bank_account := bank_treasury_account_id();

  perform _adjust_balance(v_client_account, -v_remaining);
  perform _adjust_balance(v_bank_account, v_remaining);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, related_request_type, related_request_id, created_by)
  values ('loan_repayment', 'validated', v_client_account, v_bank_account, v_remaining, 'Remboursement anticipé', 'loans', l.id, auth.uid())
  returning id into v_tx_id;

  update loan_schedules set status = 'paid', paid_at = now(), resulting_transaction_id = v_tx_id where loan_id = p_loan_id and status = 'pending';
  update loans set status = 'closed', outstanding_balance = 0, closed_at = now() where id = p_loan_id;

  perform adjust_trust_score(l.client_id, 3);
  perform notify(l.client_id, 'loan_closed', 'Prêt remboursé par anticipation', v_remaining || ' $', '/client/loans');
end;
$$;

-- ============================================================================
-- ADHÉSION & OUVERTURE DE COMPTE
-- ============================================================================

create or replace function claim_membership_request(p_request_id uuid) returns void
language plpgsql security definer as $$
declare v_applicant uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  update membership_requests set status = 'processing', processing_by = auth.uid(), processing_at = now()
  where id = p_request_id and status = 'pending'
  returning applicant_id into v_applicant;
  if not found then raise exception 'Demande introuvable'; end if;
  perform notify(v_applicant, 'membership_processing', 'Votre demande est en cours de traitement', null, null);
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
    update membership_requests set status = 'pending', requires_admin_override = true where id = p_request_id;
    perform notify_all_staff('membership_needs_admin', 'Adhésion sous le solde minimum — autorisation admin requise', m.applicant_id::text, '/admin/clients/membership', true);
    raise exception 'Le dépôt initial est sous le solde minimum requis (%). Autorisation admin nécessaire.', v_min_balance;
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

  update membership_requests set status = 'validated', decided_by = auth.uid(), decided_at = now(), created_account_id = v_account_id where id = p_request_id;

  perform notify(m.applicant_id, 'membership_approved', 'Bienvenue chez Newman Bank', 'Votre compte client est actif.', '/client');
  perform log_audit('approve_membership', 'membership_requests', p_request_id, '{}');
end;
$$;

create or replace function generate_iban() returns text
language sql as $$
  select 'BNW' || to_char(now(), 'YY') || lpad(floor(random()*100000000)::text, 8, '0');
$$;

-- Ouverture directe au guichet : le profil (et l'utilisateur auth) sont créés
-- côté Edge Function (service role), qui appelle ensuite cette fonction avec
-- l'id du profil déjà créé pour finaliser le compte.
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
    raise exception 'Le dépôt initial est sous le solde minimum requis (%). Autorisation admin nécessaire.', v_min_balance;
  end if;

  insert into accounts (client_id, account_type, iban, balance, opened_by)
  values (p_client_profile_id, o.account_type, generate_iban(), o.initial_deposit, auth.uid())
  returning id into v_account_id;

  if o.initial_deposit > 0 then
    insert into transactions (tx_type, status, to_account_id, amount, description, created_by)
    values ('cash_deposit', 'validated', v_account_id, o.initial_deposit, 'Dépôt initial à l''ouverture (guichet)', auth.uid());
  end if;

  update manual_account_openings set status = 'validated', client_id = p_client_profile_id, created_account_id = v_account_id, decided_at = now()
  where id = p_opening_id;

  return v_account_id;
end;
$$;

-- ============================================================================
-- FRAIS, INTÉRÊTS, RAPPORT DE CAISSE (appelés par les jobs planifiés — 0005)
-- ============================================================================

create or replace function charge_account_fees() returns void
language plpgsql security definer as $$
declare
  acc record;
  v_fee numeric;
  v_bank_account uuid;
  v_tx_id uuid;
begin
  v_fee := coalesce(get_setting_numeric('account_fee_amount'), 0);
  if v_fee <= 0 then return; end if;
  v_bank_account := bank_treasury_account_id();

  for acc in select * from accounts where status = 'active' and is_bank_treasury = false loop
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
  v_amount numeric;
  v_bank_account uuid;
begin
  if coalesce((get_setting('savings_interest_enabled')->>'enabled')::boolean, false) is not true then return; end if;
  v_rate := coalesce(get_setting_numeric('savings_rate'), 0) / 100;
  if v_rate <= 0 then return; end if;
  v_bank_account := bank_treasury_account_id();

  for acc in select * from accounts where status = 'active' and account_type = 'epargne' loop
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

create or replace function process_due_loan_installments() returns void
language plpgsql security definer as $$
declare s record;
begin
  for s in select id from loan_schedules where status = 'pending' and due_date <= current_date loop
    perform repay_loan_installment_now(s.id);
  end loop;
end;
$$;

create or replace function generate_daily_cashier_report() returns void
language plpgsql security definer as $$
declare
  v_bank_account uuid;
  v_prev_closing numeric;
  v_in numeric;
  v_out numeric;
  v_closing numeric;
begin
  v_bank_account := bank_treasury_account_id();
  select closing_balance into v_prev_closing from cashier_reports where report_date = current_date - 1;
  if v_prev_closing is null then
    select balance into v_prev_closing from accounts where id = v_bank_account;
  end if;

  select coalesce(sum(case when to_account_id = v_bank_account then amount + fee_amount else 0 end), 0),
         coalesce(sum(case when from_account_id = v_bank_account then amount else 0 end), 0)
  into v_in, v_out
  from transactions
  where created_at::date = current_date and (from_account_id = v_bank_account or to_account_id = v_bank_account);

  v_closing := v_prev_closing + v_in - v_out;

  insert into cashier_reports (report_date, opening_balance, total_in, total_out, closing_balance)
  values (current_date, v_prev_closing, v_in, v_out, v_closing)
  on conflict (report_date) do update set total_in = excluded.total_in, total_out = excluded.total_out, closing_balance = excluded.closing_balance, generated_at = now();
end;
$$;

create or replace function admin_adjust_cashier_report(p_report_id uuid, p_amount numeric, p_note text) returns void
language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'Réservé à l''admin'; end if;
  update cashier_reports set
    adjustment_amount = adjustment_amount + p_amount,
    closing_balance = closing_balance + p_amount,
    adjusted_by = auth.uid(), adjusted_at = now(),
    adjustment_note = coalesce(adjustment_note || E'\n', '') || p_note
  where id = p_report_id;
  perform log_audit('adjust_cashier_report', 'cashier_reports', p_report_id, jsonb_build_object('amount', p_amount, 'note', p_note));
end;
$$;

-- ============================================================================
-- NOTIFICATIONS — marquer comme lues
-- ============================================================================

create or replace function mark_notifications_read(p_ids uuid[]) returns void
language sql security definer as $$
  update notifications set is_read = true where id = any(p_ids) and recipient_id = auth.uid();
$$;

create or replace function mark_all_notifications_read() returns void
language sql security definer as $$
  update notifications set is_read = true where recipient_id = auth.uid() and is_read = false;
$$;

-- ============================================================================
-- CONNEXION — journal + détection fraude sur échecs répétés
-- ============================================================================

create or replace function record_login_attempt(p_username text, p_success boolean) returns void
language plpgsql security definer as $$
declare
  v_profile_id uuid;
  v_recent_failures int;
  v_threshold int;
begin
  select id into v_profile_id from profiles where username = p_username;
  insert into login_log (profile_id, username_attempted, success) values (v_profile_id, p_username, p_success);

  if not p_success then
    select count(*) into v_recent_failures from login_log
    where username_attempted = p_username and success = false and created_at > now() - interval '15 minutes';

    v_threshold := coalesce((get_setting('fraud_failed_login_threshold')->>'amount')::int, 5);
    if v_recent_failures >= v_threshold then
      perform create_fraud_alert('auto', 'failed_login_attempts', 'high', v_profile_id, null, null,
        'Tentatives de connexion échouées répétées pour ' || p_username);
    end if;
  end if;
end;
$$;

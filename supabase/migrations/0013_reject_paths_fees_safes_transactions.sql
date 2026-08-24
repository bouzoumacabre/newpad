-- ============================================================================
-- NEWPAD — Migration 0013
-- ============================================================================
-- Lot de correctifs/évolutions demandé (2ème gros lot) :
--
-- 1. Refus avec motif pour TOUTES les demandes client qui n'en disposaient pas
--    encore : coffres-forts (safe_rental_requests) et consulting premium
--    (consulting_requests). Les autres types de demandes (virements, achats
--    de lingots banque/marché, prêts, adhésions) avaient déjà cette capacité.
--
-- 2. Frais de dossier configurables (nouveau paramètre économique), prélevés
--    au décaissement d'un prêt validé — cas d'usage RP le plus courant pour
--    ce type de frais dans une banque privée.
--
-- 3. Coffres-forts : passage d'une facturation annuelle figée à une
--    facturation hebdomadaire configurable par coffre, avec une nouvelle
--    tâche planifiée pour le prélèvement récurrent, et de nouvelles fonctions
--    admin pour créer/modifier les coffres et leur tarif.
--
-- 4. Combler deux trous de journalisation (log_audit) sur des actions qui
--    n'étaient pas tracées : la prise en charge d'un virement et la prise en
--    charge d'une demande de coffre (les décisions finales l'étaient déjà).
--
-- 5. Nouvelle fonction staff_list_transactions() : historique des
--    transactions côté personnel (employé/admin), avec recherche texte,
--    filtre par type de service (tx_type) et filtre par catégorie de
--    clientèle (client_categories) — jusqu'ici seul le rôle IRS disposait
--    d'un tel registre (irs_list_transactions), les rôles employé/admin
--    n'avaient aucun écran d'historique des transactions.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1a. Coffres-forts — refus avec motif
-- ----------------------------------------------------------------------------

alter table safe_rental_requests
  add column if not exists decision_note text,
  add column if not exists decided_by uuid references profiles(id),
  add column if not exists decided_at timestamptz;

create or replace function reject_safe_request(p_request_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  r safe_rental_requests%rowtype;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into r from safe_rental_requests where id = p_request_id and status in ('pending','processing') for update;
  if r is null then raise exception 'Demande introuvable ou déjà décidée'; end if;

  -- Si un coffre avait déjà été réservé pour cette demande (statut 'processing'),
  -- on le libère pour qu'il redevienne disponible.
  if r.safe_box_id is not null then
    update safe_deposit_boxes set status = 'available' where id = r.safe_box_id and status = 'reserved';
  end if;

  update safe_rental_requests set status = 'rejected', decision_note = p_note, decided_by = auth.uid(), decided_at = now()
  where id = p_request_id;

  perform notify(r.client_id, 'safe_rejected', 'Demande de coffre-fort refusée', p_note, '/client/safes');
  perform log_audit('reject_safe_request', 'safe_rental_requests', p_request_id, jsonb_build_object(
    'client', (select display_name from profiles where id = r.client_id), 'note', p_note));
end;
$$;

-- ----------------------------------------------------------------------------
-- 1b. Consulting premium — refus avec motif
-- ----------------------------------------------------------------------------

alter table consulting_requests drop constraint if exists consulting_requests_status_check;
alter table consulting_requests add constraint consulting_requests_status_check
  check (status in ('pending','assigned','closed','rejected'));

alter table consulting_requests
  add column if not exists decision_note text,
  add column if not exists decided_by uuid references profiles(id),
  add column if not exists decided_at timestamptz;

create or replace function reject_consulting_request(p_id uuid, p_note text default null) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_client uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  update consulting_requests set status = 'rejected', decision_note = p_note, decided_by = auth.uid(), decided_at = now()
  where id = p_id and status in ('pending','assigned')
  returning client_id into v_client;
  if not found then raise exception 'Demande introuvable ou déjà décidée'; end if;

  perform notify(v_client, 'consulting_rejected', 'Demande de consulting refusée', p_note, '/client/consulting');
  perform log_audit('reject_consulting_request', 'consulting_requests', p_id, jsonb_build_object(
    'client', (select display_name from profiles where id = v_client), 'note', p_note));
end;
$$;

-- ----------------------------------------------------------------------------
-- 2. Frais de dossier (prêts) — nouveau paramètre + prélèvement au décaissement
-- ----------------------------------------------------------------------------

insert into economic_settings (key, label, value, value_type, category)
values ('loan_processing_fee', 'Frais de dossier (prélevés au décaissement d''un prêt)', '{"amount": 5000}', 'money', 'frais')
on conflict (key) do nothing;

create or replace function admin_decide_loan(p_loan_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  l loans%rowtype;
  v_rate numeric;
  v_bank_account uuid;
  v_client_account uuid;
  v_tx_id uuid;
  v_fee_tx_id uuid;
  v_processing_fee numeric;
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

  -- Frais de dossier : prélevés séparément juste après le décaissement, pour
  -- que le montant décaissé (visible côté client) corresponde exactement au
  -- montant demandé, et que les frais restent visibles comme une ligne
  -- distincte dans l'historique des transactions.
  v_processing_fee := coalesce(get_setting_numeric('loan_processing_fee'), 0);
  if v_processing_fee > 0 then
    perform _adjust_balance(v_client_account, -v_processing_fee);
    perform _adjust_balance(v_bank_account, v_processing_fee);
    insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, related_request_type, related_request_id, created_by)
    values ('loan_processing_fee', 'validated', v_client_account, v_bank_account, v_processing_fee, 'Frais de dossier — prêt', 'loans', l.id, auth.uid())
    returning id into v_fee_tx_id;
  end if;

  update loans set status = 'active', interest_rate = v_rate, outstanding_balance = l.requested_amount,
    admin_decided_by = auth.uid(), admin_decided_at = now(), decision_note = p_note,
    disbursed_at = now(), disbursement_account_id = v_client_account, disbursement_transaction_id = v_tx_id
  where id = p_loan_id;

  v_balance := l.requested_amount;
  for i in 1..l.term_months loop
    v_interest := round(v_balance * v_rate / 12, 2);
    v_principal := round(l.requested_amount / l.term_months, 2);
    insert into loan_schedules (loan_id, installment_number, due_date, amount_due, principal, interest)
    values (l.id, i, (current_date + (i || ' months')::interval)::date, v_principal + v_interest, v_principal, v_interest);
    v_balance := v_balance - v_principal;
  end loop;

  perform notify(l.client_id, 'loan_approved', 'Prêt validé et décaissé', l.requested_amount || ' $', '/client/loans');
  if v_processing_fee > 0 then
    perform notify(l.client_id, 'loan_fee_charged', 'Frais de dossier prélevés', v_processing_fee || ' $', '/client/loans');
  end if;
  perform log_audit('approve_loan', 'loans', p_loan_id, jsonb_build_object(
    'client', (select display_name from profiles where id = l.client_id), 'amount', l.requested_amount, 'rate', v_rate,
    'term_months', l.term_months, 'processing_fee', v_processing_fee));
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. Coffres-forts — tarification hebdomadaire + gestion admin du parc
-- ----------------------------------------------------------------------------

alter table safe_deposit_boxes rename column annual_fee to weekly_fee;
comment on column safe_deposit_boxes.weekly_fee is 'Loyer hebdomadaire du coffre, prélevé à la confirmation puis chaque semaine tant que le coffre est loué (voir charge_safe_weekly_fees).';

-- Ré-estimation grossière des tarifs existants (les montants exacts restent
-- modifiables ensuite depuis /admin/safes) : ancien tarif annuel / 52.
update safe_deposit_boxes set weekly_fee = round(weekly_fee / 52, 2);

create or replace function admin_create_safe_box(p_code text, p_branch text, p_weekly_fee numeric) returns uuid
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_id uuid;
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  if p_weekly_fee < 0 then raise exception 'Le tarif hebdomadaire ne peut pas être négatif'; end if;
  insert into safe_deposit_boxes (code, branch, weekly_fee) values (p_code, coalesce(p_branch, 'Agence centrale'), p_weekly_fee)
  returning id into v_id;
  perform log_audit('admin_create_safe_box', 'safe_deposit_boxes', v_id, jsonb_build_object('code', p_code, 'branch', p_branch, 'weekly_fee', p_weekly_fee));
  return v_id;
end;
$$;

create or replace function admin_update_safe_box(p_box_id uuid, p_weekly_fee numeric default null, p_branch text default null, p_status safe_status default null) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  if p_weekly_fee is not null and p_weekly_fee < 0 then raise exception 'Le tarif hebdomadaire ne peut pas être négatif'; end if;
  update safe_deposit_boxes set
    weekly_fee = coalesce(p_weekly_fee, weekly_fee),
    branch = coalesce(p_branch, branch),
    status = coalesce(p_status, status)
  where id = p_box_id;
  if not found then raise exception 'Coffre introuvable'; end if;
  perform log_audit('admin_update_safe_box', 'safe_deposit_boxes', p_box_id, jsonb_build_object('weekly_fee', p_weekly_fee, 'branch', p_branch, 'status', p_status));
end;
$$;

-- confirm_safe_rental : facture désormais la 1ère semaine (weekly_fee) plutôt
-- que l'ancien forfait annuel. Le reste de la logique (vérification du solde
-- minimum, transaction, activation du coffre) est inchangé.
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
  v_new_total := client_total_balance(r.client_id) - b.weekly_fee;
  if v_new_total < v_min_balance and not is_admin() then
    perform notify_all_staff('safe_needs_admin', 'Location de coffre sous le solde minimum — autorisation admin requise', b.code, '/admin/safes', true);
    return;
  end if;

  select id into v_account from accounts where client_id = r.client_id and status='active' order by is_bank_treasury, opened_at limit 1;
  v_bank_account := bank_treasury_account_id();

  perform _adjust_balance(v_account, -b.weekly_fee);
  perform _adjust_balance(v_bank_account, b.weekly_fee);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, related_request_type, related_request_id, created_by)
  values ('safe_rental', 'validated', v_account, v_bank_account, b.weekly_fee, 'Location coffre ' || b.code || ' (1 semaine)', 'safe_rental_requests', r.id, auth.uid())
  returning id into v_tx_id;

  update safe_deposit_boxes set status = 'rented', client_id = r.client_id, rented_since = current_date where id = b.id;
  update safe_rental_requests set status = 'validated', confirmed_by = auth.uid(), confirmed_at = now(), resulting_transaction_id = v_tx_id
  where id = p_request_id;

  perform notify(r.client_id, 'safe_validated', 'Location de coffre confirmée', b.code, '/client/safes');
  perform log_audit('confirm_safe_rental', 'safe_rental_requests', p_request_id, jsonb_build_object(
    'client', (select display_name from profiles where id = r.client_id), 'safe_code', b.code, 'weekly_fee', b.weekly_fee));
end;
$$;

-- Prélèvement hebdomadaire récurrent, tant que le coffre reste loué (mirroring
-- de charge_account_fees, mais à montant fixe et fréquence fixe 7 jours).
create or replace function charge_safe_weekly_fees() returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  box record;
  v_account uuid;
  v_bank_account uuid;
  v_tx_id uuid;
  v_last_charged timestamptz;
begin
  v_bank_account := bank_treasury_account_id();

  for box in select * from safe_deposit_boxes where status = 'rented' and client_id is not null loop
    select max(created_at) into v_last_charged from transactions
    where tx_type = 'safe_rental' and description like 'Location coffre ' || box.code || '%'
      and to_account_id = v_bank_account;

    if v_last_charged is not null and v_last_charged > now() - interval '7 days' then
      continue;
    end if;

    if box.weekly_fee <= 0 then continue; end if;

    select id into v_account from accounts where client_id = box.client_id and status='active' order by is_bank_treasury, opened_at limit 1;
    if v_account is null then continue; end if;

    perform _adjust_balance(v_account, -box.weekly_fee);
    perform _adjust_balance(v_bank_account, box.weekly_fee);

    insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
    values ('safe_rental', 'validated', v_account, v_bank_account, box.weekly_fee, 'Location coffre ' || box.code || ' (renouvellement hebdomadaire)', null)
    returning id into v_tx_id;

    perform notify(box.client_id, 'safe_fee_charged', 'Loyer hebdomadaire du coffre prélevé', box.weekly_fee || ' $ — coffre ' || box.code, '/client/safes');

    if (select balance from accounts where id = v_account) < 0 then
      perform notify_all_staff('account_negative', 'Compte client passé en négatif suite au loyer d''un coffre', box.client_id::text, '/employee/clients');
    end if;
  end loop;
end;
$$;

select cron.schedule('newpad-safe-weekly-fees', '20 3 * * *', $$select charge_safe_weekly_fees();$$);

-- ----------------------------------------------------------------------------
-- 4. Journalisation manquante sur deux actions de prise en charge
-- ----------------------------------------------------------------------------

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
  perform log_audit('claim_safe_request', 'safe_rental_requests', p_request_id, jsonb_build_object('client', (select display_name from profiles where id = v_client)));
end;
$$;

-- ----------------------------------------------------------------------------
-- 5. Historique des transactions côté personnel (employé/admin), avec filtres
-- ----------------------------------------------------------------------------

create or replace function staff_list_transactions(
  p_search text default null,
  p_tx_type text default null,
  p_category_id uuid default null,
  p_limit int default 300
) returns table(
  id uuid, tx_type text, status request_status, amount numeric, fee_amount numeric,
  from_label text, to_label text, from_client_id uuid, to_client_id uuid,
  description text, created_at timestamptz
)
language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  return query
  select t.id, t.tx_type, t.status, t.amount, t.fee_amount,
    coalesce(pf.display_name, case when af.is_bank_treasury then 'Newman Bank (trésorerie)' else null end, 'Externe'),
    coalesce(pt.display_name, case when at_.is_bank_treasury then 'Newman Bank (trésorerie)' else null end, 'Externe'),
    af.client_id, at_.client_id,
    t.description, t.created_at
  from transactions t
  left join accounts af on af.id = t.from_account_id
  left join accounts at_ on at_.id = t.to_account_id
  left join profiles pf on pf.id = af.client_id
  left join profiles pt on pt.id = at_.client_id
  where (p_search is null or p_search = '' or t.description ilike '%'||p_search||'%' or pf.display_name ilike '%'||p_search||'%' or pt.display_name ilike '%'||p_search||'%')
    and (p_tx_type is null or t.tx_type = p_tx_type)
    and (p_category_id is null or exists (
      select 1 from client_category_links ccl
      where ccl.category_id = p_category_id and ccl.client_id in (af.client_id, at_.client_id)
    ))
  order by t.created_at desc
  limit p_limit;
end;
$$;

create or replace function list_distinct_tx_types() returns table(tx_type text)
language sql stable security definer set search_path to 'public', 'pg_temp' as $$
  select distinct t.tx_type from transactions t where is_staff() order by 1;
$$;

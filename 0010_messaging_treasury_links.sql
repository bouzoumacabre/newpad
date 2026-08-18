-- ============================================================================
-- NEWPAD — Migration 0010
-- 1) Messagerie inter-rôles (tickets 1:1 entre IRS/Client/Employé/Admin, sauf
--    client <-> client, interdit).
-- 2) Trésorerie : le dépôt initial d'un nouveau compte débite désormais le
--    compte de trésorerie de la banque (au lieu d'être créé depuis rien),
--    et une fonction admin_treasury_stats() expose fonds propres / actif en
--    gestion / solde total.
-- 3) Correction de tous les liens de notification cassés (segments
--    '/operations/' et '/admin/clients/...' inexistants) afin qu'un clic sur
--    une notification redirige bien vers l'écran attendu.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) MESSAGERIE INTER-RÔLES
-- ----------------------------------------------------------------------------

create table if not exists message_threads (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  created_by uuid not null references profiles(id),
  participant_a uuid not null references profiles(id),
  participant_a_role user_role not null,
  participant_b uuid not null references profiles(id),
  participant_b_role user_role not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  participant_a_last_read_at timestamptz not null default now(),
  participant_b_last_read_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint message_threads_distinct_participants check (participant_a != participant_b)
);

create index if not exists idx_message_threads_participant_a on message_threads(participant_a);
create index if not exists idx_message_threads_participant_b on message_threads(participant_b);

create table if not exists thread_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references message_threads(id) on delete cascade,
  author_id uuid not null references profiles(id),
  author_role user_role not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_thread_messages_thread_id on thread_messages(thread_id, created_at);

alter table message_threads enable row level security;
alter table thread_messages enable row level security;

drop policy if exists message_threads_select on message_threads;
create policy message_threads_select on message_threads
  for select using (participant_a = auth.uid() or participant_b = auth.uid());

drop policy if exists thread_messages_select on thread_messages;
create policy thread_messages_select on thread_messages
  for select using (
    exists (
      select 1 from message_threads t
      where t.id = thread_messages.thread_id
        and (t.participant_a = auth.uid() or t.participant_b = auth.uid())
    )
  );

-- Aucune policy INSERT/UPDATE/DELETE : toutes les écritures passent par les
-- fonctions SECURITY DEFINER ci-dessous (même convention que support_tickets).

create or replace function public.list_messageable_contacts(p_search text default null)
 returns table (id uuid, display_name text, username text, role user_role, employee_title text)
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare v_caller_role user_role;
begin
  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null then raise exception 'Accès refusé'; end if;

  return query
  select p.id, p.display_name, p.username, p.role, p.employee_title
  from profiles p
  where p.id != auth.uid()
    and p.status = 'active'
    and p.role in ('client', 'employee', 'admin', 'irs')
    and (v_caller_role != 'client' or p.role != 'client')
    and (p_search is null or trim(p_search) = '' or p.display_name ilike '%' || p_search || '%' or p.username ilike '%' || p_search || '%')
  order by p.role, p.display_name
  limit 50;
end;
$function$;

create or replace function public.create_message_thread(p_recipient_id uuid, p_subject text, p_body text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_caller_role user_role;
  v_recipient_role user_role;
  v_recipient_status text;
  v_thread_id uuid;
begin
  if p_recipient_id = auth.uid() then
    raise exception 'Vous ne pouvez pas vous envoyer un message à vous-même';
  end if;

  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role not in ('client', 'employee', 'admin', 'irs') then
    raise exception 'Accès refusé';
  end if;

  select role, status into v_recipient_role, v_recipient_status from profiles where id = p_recipient_id;
  if v_recipient_role is null then
    raise exception 'Destinataire introuvable';
  end if;
  if v_recipient_status != 'active' then
    raise exception 'Ce destinataire n''est pas disponible';
  end if;
  if v_recipient_role not in ('client', 'employee', 'admin', 'irs') then
    raise exception 'Destinataire invalide';
  end if;
  if v_caller_role = 'client' and v_recipient_role = 'client' then
    raise exception 'Les clients ne peuvent pas se contacter entre eux';
  end if;
  if p_subject is null or trim(p_subject) = '' then
    raise exception 'Le sujet est requis';
  end if;
  if p_body is null or trim(p_body) = '' then
    raise exception 'Le message ne peut pas être vide';
  end if;

  insert into message_threads (created_by, participant_a, participant_a_role, participant_b, participant_b_role, subject)
  values (auth.uid(), auth.uid(), v_caller_role, p_recipient_id, v_recipient_role, p_subject)
  returning id into v_thread_id;

  insert into thread_messages (thread_id, author_id, author_role, body)
  values (v_thread_id, auth.uid(), v_caller_role, p_body);

  perform notify(p_recipient_id, 'new_message_thread', 'Nouveau message : ' || p_subject, left(p_body, 140), '/' || v_recipient_role || '/messages/' || v_thread_id);

  return v_thread_id;
end;
$function$;

create or replace function public.send_thread_message(p_thread_id uuid, p_body text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  th message_threads%rowtype;
  v_caller_role user_role;
  v_other_id uuid;
  v_other_role user_role;
  v_id uuid;
begin
  select * into th from message_threads where id = p_thread_id;
  if th is null then raise exception 'Conversation introuvable'; end if;
  if auth.uid() != th.participant_a and auth.uid() != th.participant_b then
    raise exception 'Accès refusé';
  end if;
  if th.status = 'closed' then
    raise exception 'Cette conversation est clôturée';
  end if;
  if p_body is null or trim(p_body) = '' then
    raise exception 'Le message ne peut pas être vide';
  end if;

  select role into v_caller_role from profiles where id = auth.uid();

  if auth.uid() = th.participant_a then
    v_other_id := th.participant_b;
  else
    v_other_id := th.participant_a;
  end if;
  select role into v_other_role from profiles where id = v_other_id;

  insert into thread_messages (thread_id, author_id, author_role, body)
  values (p_thread_id, auth.uid(), v_caller_role, p_body)
  returning id into v_id;

  update message_threads set last_message_at = now(), status = 'open' where id = p_thread_id;

  perform notify(v_other_id, 'new_message', 'Nouveau message : ' || th.subject, left(p_body, 140), '/' || coalesce(v_other_role::text, 'client') || '/messages/' || p_thread_id);

  return v_id;
end;
$function$;

create or replace function public.mark_thread_read(p_thread_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare th message_threads%rowtype;
begin
  select * into th from message_threads where id = p_thread_id;
  if th is null then return; end if;
  if th.participant_a = auth.uid() then
    update message_threads set participant_a_last_read_at = now() where id = p_thread_id;
  elsif th.participant_b = auth.uid() then
    update message_threads set participant_b_last_read_at = now() where id = p_thread_id;
  end if;
end;
$function$;

create or replace function public.close_message_thread(p_thread_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare th message_threads%rowtype;
begin
  select * into th from message_threads where id = p_thread_id;
  if th is null then raise exception 'Conversation introuvable'; end if;
  if auth.uid() != th.participant_a and auth.uid() != th.participant_b then
    raise exception 'Accès refusé';
  end if;
  update message_threads set status = 'closed' where id = p_thread_id;
end;
$function$;

create or replace function public.list_my_message_threads()
 returns table (
   id uuid,
   subject text,
   status text,
   last_message_at timestamptz,
   created_at timestamptz,
   other_id uuid,
   other_display_name text,
   other_role user_role,
   unread boolean
 )
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  return query
  select
    t.id, t.subject, t.status, t.last_message_at, t.created_at,
    (case when t.participant_a = auth.uid() then t.participant_b else t.participant_a end) as other_id,
    p.display_name as other_display_name,
    (case when t.participant_a = auth.uid() then t.participant_b_role else t.participant_a_role end) as other_role,
    (t.last_message_at > (case when t.participant_a = auth.uid() then t.participant_a_last_read_at else t.participant_b_last_read_at end)) as unread
  from message_threads t
  join profiles p on p.id = (case when t.participant_a = auth.uid() then t.participant_b else t.participant_a end)
  where t.participant_a = auth.uid() or t.participant_b = auth.uid()
  order by t.last_message_at desc;
end;
$function$;

-- Realtime : nécessaire pour que la messagerie se mette à jour en direct
-- (ces deux tables n'étaient pas encore dans la publication).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'message_threads'
  ) then
    alter publication supabase_realtime add table message_threads;
  end if;
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'thread_messages'
  ) then
    alter publication supabase_realtime add table thread_messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table notifications;
  end if;
end $$;

-- ----------------------------------------------------------------------------
-- 2) TRÉSORERIE — dissociation fonds propres / actif en gestion
-- ----------------------------------------------------------------------------

create or replace function public.admin_treasury_stats()
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_fonds_propres numeric;
  v_actif_gestion numeric;
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  select coalesce(balance, 0) into v_fonds_propres from accounts where is_bank_treasury = true limit 1;
  select coalesce(sum(balance), 0) into v_actif_gestion from accounts where client_id is not null and status != 'closed';
  return jsonb_build_object(
    'fonds_propres', coalesce(v_fonds_propres, 0),
    'actif_gestion', coalesce(v_actif_gestion, 0),
    'solde_total', coalesce(v_fonds_propres, 0) + coalesce(v_actif_gestion, 0)
  );
end;
$function$;

-- decide_membership_request : le dépôt initial débite désormais la trésorerie
-- de la banque (au lieu d'être crédité depuis rien) + liens de notification
-- corrigés ('/admin/clients/membership' et '/admin/clients/openings'
-- n'existaient pas en tant que routes).
CREATE OR REPLACE FUNCTION public.decide_membership_request(p_request_id uuid, p_approve boolean, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  m membership_requests%rowtype;
  v_min_balance numeric;
  v_account_id uuid;
  v_bank_account uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into m from membership_requests where id = p_request_id and status in ('pending','processing') for update;
  if m is null then raise exception 'Demande introuvable'; end if;

  if not p_approve then
    update membership_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now() where id = p_request_id;
    perform notify(m.applicant_id, 'membership_rejected', 'Votre demande d''adhésion a été refusée', p_note, '/prospect');
    perform log_audit('reject_membership', 'membership_requests', p_request_id, jsonb_build_object(
      'applicant', (select display_name from profiles where id = m.applicant_id), 'note', p_note));
    return;
  end if;

  v_min_balance := coalesce(get_setting_numeric('min_client_balance', m.applicant_id), 1000000);
  if m.initial_deposit < v_min_balance and not is_admin() then
    update membership_requests set status = 'pending', requires_admin_override = true, processing_by = auth.uid(), processing_at = now()
    where id = p_request_id;
    perform notify_all_staff('membership_needs_admin', 'Adhésion sous le solde minimum — autorisation admin requise', m.applicant_id::text, '/admin/membership', true);
    return;
  end if;

  v_bank_account := bank_treasury_account_id();

  insert into accounts (client_id, account_type, iban, balance, opened_by)
  values (m.applicant_id, coalesce(m.requested_account_type, 'courant'), generate_iban(), m.initial_deposit, auth.uid())
  returning id into v_account_id;

  perform _bypass_profile_guard();
  update profiles set role = 'client', client_since = current_date where id = m.applicant_id;

  if m.initial_deposit > 0 then
    perform _adjust_balance(v_bank_account, -m.initial_deposit);
    insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
    values ('cash_deposit', 'validated', v_bank_account, v_account_id, m.initial_deposit, 'Dépôt initial à l''ouverture', auth.uid());
  end if;

  update membership_requests set status = 'validated', decided_by = auth.uid(), decided_at = now(),
    created_account_id = v_account_id, admin_authorized_by = case when is_admin() and m.initial_deposit < v_min_balance then auth.uid() else null end
  where id = p_request_id;

  perform notify(m.applicant_id, 'membership_approved', 'Bienvenue chez Newman Bank', 'Votre compte client est actif.', '/client');
  perform log_audit('approve_membership', 'membership_requests', p_request_id, jsonb_build_object(
    'applicant', (select display_name from profiles where id = m.applicant_id), 'initial_deposit', m.initial_deposit));
end;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_manual_account_opening(p_opening_id uuid, p_client_profile_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  o manual_account_openings%rowtype;
  v_min_balance numeric;
  v_account_id uuid;
  v_bank_account uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into o from manual_account_openings where id = p_opening_id for update;
  if o is null then raise exception 'Ouverture introuvable'; end if;

  v_min_balance := coalesce(get_setting_numeric('min_client_balance', p_client_profile_id), 1000000);
  if o.initial_deposit < v_min_balance and not is_admin() then
    update manual_account_openings set requires_admin_override = true where id = p_opening_id;
    perform notify_all_staff('account_opening_needs_admin', 'Ouverture de compte sous le solde minimum — autorisation admin requise', o.display_name, '/admin/account-opening', true);
    raise exception 'Le dépôt initial est sous le solde minimum requis (%). Autorisation admin nécessaire — demande enregistrée en attente.', v_min_balance;
  end if;

  v_bank_account := bank_treasury_account_id();

  insert into accounts (client_id, account_type, iban, balance, opened_by)
  values (p_client_profile_id, o.account_type, generate_iban(), o.initial_deposit, auth.uid())
  returning id into v_account_id;

  if o.initial_deposit > 0 then
    perform _adjust_balance(v_bank_account, -o.initial_deposit);
    insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
    values ('cash_deposit', 'validated', v_bank_account, v_account_id, o.initial_deposit, 'Dépôt initial à l''ouverture (guichet)', auth.uid());
  end if;

  update manual_account_openings set status = 'validated', client_id = p_client_profile_id, created_account_id = v_account_id, decided_at = now(),
    admin_authorized_by = case when is_admin() and o.initial_deposit < v_min_balance then auth.uid() else null end
  where id = p_opening_id;

  return v_account_id;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 3) LIENS DE NOTIFICATION CASSÉS — reste des correctifs
--    (segments '/operations/...' et '/admin/clients/...' qui ne correspondent
--    à aucune route réelle de src/main.js).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_transfer(p_sender_account_id uuid, p_recipient_account_id uuid, p_amount numeric, p_motif text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  perform notify_all_staff('transfer_request', 'Nouveau virement à traiter', p_amount || ' $', '/employee/transfers');

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.decide_transfer(p_transfer_id uuid, p_approve boolean, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
      perform notify_all_staff('transfer_needs_admin', 'Virement sous le solde minimum — autorisation admin requise', t.amount || ' $', '/admin/transfers', true);
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
$function$;

CREATE OR REPLACE FUNCTION public.submit_gold_bank_purchase(p_gold_bar_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  perform notify_all_staff('gold_bank_purchase_request', 'Nouvelle demande d''achat de lingot', v_price || ' $', '/employee/gold');
  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.submit_market_purchase(p_listing_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id uuid;
begin
  if not exists (select 1 from gold_market_listings where id = p_listing_id and status = 'active') then
    raise exception 'Annonce indisponible';
  end if;
  insert into gold_market_purchase_requests (listing_id, buyer_client_id)
  values (p_listing_id, auth.uid())
  returning id into v_id;
  perform notify_all_staff('gold_market_request', 'Nouvelle transaction marché de revente', null, '/employee/gold');
  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.decide_gold_bank_purchase(p_request_id uuid, p_approve boolean, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    perform notify_all_staff('gold_purchase_needs_admin', 'Achat de lingot sous le solde minimum — autorisation admin requise', r.price || ' $', '/admin/gold', true);
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
$function$;

CREATE OR REPLACE FUNCTION public.decide_market_purchase(p_request_id uuid, p_approve boolean, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    perform notify_all_staff('gold_market_needs_admin', 'Achat marché sous le solde minimum — autorisation admin requise', l.listed_price || ' $', '/admin/gold', true);
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
$function$;

CREATE OR REPLACE FUNCTION public.submit_safe_request()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id uuid;
begin
  insert into safe_rental_requests (client_id) values (auth.uid()) returning id into v_id;
  perform notify_all_staff('safe_request', 'Nouvelle demande de coffre-fort', null, '/employee/safes');
  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.confirm_safe_rental(p_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    perform notify_all_staff('safe_needs_admin', 'Location de coffre sous le solde minimum — autorisation admin requise', b.code, '/admin/safes', true);
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
$function$;

CREATE OR REPLACE FUNCTION public.submit_loan_request(p_amount numeric, p_purpose text, p_term_months integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_cap numeric;
  v_id uuid;
begin
  v_cap := coalesce(get_setting_numeric('loan_cap', auth.uid()), 50000000);
  if p_amount > v_cap then raise exception 'Le montant dépasse le plafond de prêt autorisé (% $)', v_cap; end if;
  insert into loans (client_id, requested_amount, purpose, term_months)
  values (auth.uid(), p_amount, p_purpose, p_term_months)
  returning id into v_id;
  perform notify_all_staff('loan_request', 'Nouvelle demande de prêt', p_amount || ' $', '/admin/loans', true);
  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.claim_membership_request(p_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_applicant uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  update membership_requests set status = 'processing', processing_by = auth.uid(), processing_at = now()
  where id = p_request_id and status = 'pending'
  returning applicant_id into v_applicant;
  if not found then raise exception 'Demande introuvable'; end if;
  perform notify(v_applicant, 'membership_processing', 'Votre demande est en cours de traitement', null, '/prospect');
end;
$function$;

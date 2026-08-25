-- ============================================================================
-- NEWPAD — Migration 0014 (3ème gros lot de correctifs/évolutions)
-- ============================================================================
-- 1. economic_settings : lecture publique (nécessaire pour que le mode
--    maintenance / la bannière d'annonce puissent s'afficher sur l'accueil
--    public, consulté par des visiteurs non connectés).
-- 2. profiles.phone_number : numéro de téléphone RP, sur le même principe que
--    discord_id (collecté à l'inscription, éditable en Paramètres, visible du
--    personnel sur la fiche client — pour que les clients soient joignables).
-- 3. admin_adjust_account_balance / admin_delete_account : ajustement manuel
--    direct du solde d'un compte + suppression définitive (encadrée) d'un
--    compte — tx_type 'admin_adjustment' était déjà prévu dans le schéma
--    (0001) mais jamais implémenté.
-- 4. admin_update_transaction_description : édition limitée à la description
--    d'une transaction (jamais le montant/comptes/statut — intégrité
--    comptable).
-- 5. staff_decide_safe_request : décision simple (autoriser/refuser) en une
--    étape pour une demande de coffre-fort, en plus du flux existant
--    (programmer un rendez-vous → confirmer).
-- 6. client_info_notes + get_client_info/upsert_client_info : nouvel onglet
--    "Infos" côté client (lecture seule), éditable par l'admin, l'employé ET
--    l'IRS — exception d'écriture ciblée pour l'IRS, qui n'a par ailleurs
--    aucune policy RLS d'écriture nulle part.
-- 7. _adjust_balance : alerte fraude automatique dès qu'un compte client
--    (hors trésorerie banque) passe en négatif.
-- 8. list_messageable_contacts / create_message_thread : matrice de
--    messagerie resserrée — Client → Employé/Admin uniquement (pas IRS),
--    IRS → Employé/Admin uniquement (pas les clients, pas d'autres IRS),
--    Admin/Employé → tout le monde (inchangé).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Lecture publique de economic_settings (mode maintenance / bannière)
-- ----------------------------------------------------------------------------

drop policy if exists economic_settings_select on economic_settings;
create policy economic_settings_select on economic_settings for select using (true);

-- ----------------------------------------------------------------------------
-- 2. Numéro de téléphone
-- ----------------------------------------------------------------------------

alter table profiles add column if not exists phone_number text;

create or replace function public.handle_new_auth_user()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if coalesce(new.raw_user_meta_data->>'honeypot', '') != '' then
    raise exception 'Inscription refusée';
  end if;

  insert into profiles (id, username, role, display_name, discord_id, phone_number)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'prospect'),
    coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    nullif(new.raw_user_meta_data->>'discord_id', ''),
    nullif(new.raw_user_meta_data->>'phone_number', '')
  );
  return new;
end;
$function$;

-- Numéros du banquier (Salomon Newman / newman1.618) — demande explicite.
update profiles set phone_number = '555394399' where username = 'newman1.618' and phone_number is null;

-- ----------------------------------------------------------------------------
-- 3. Ajustement manuel de solde + suppression de compte
-- ----------------------------------------------------------------------------

create or replace function admin_adjust_account_balance(p_account_id uuid, p_amount numeric, p_note text default null) returns uuid
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_bank_account uuid;
  v_tx_id uuid;
  v_client uuid;
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'Le montant ne peut pas être nul'; end if;

  select client_id into v_client from accounts where id = p_account_id;
  if v_client is null then raise exception 'Compte introuvable'; end if;

  v_bank_account := bank_treasury_account_id();
  if p_account_id = v_bank_account then
    raise exception 'Utilisez les écrans dédiés (pilotage économique / caisse) pour ajuster la trésorerie de la banque';
  end if;

  perform _adjust_balance(p_account_id, p_amount);
  perform _adjust_balance(v_bank_account, -p_amount);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
  values (
    'admin_adjustment', 'validated',
    case when p_amount < 0 then p_account_id else v_bank_account end,
    case when p_amount < 0 then v_bank_account else p_account_id end,
    abs(p_amount),
    coalesce('Ajustement manuel admin — ' || p_note, 'Ajustement manuel admin'),
    auth.uid()
  ) returning id into v_tx_id;

  perform notify(v_client, 'admin_adjustment', 'Ajustement de solde par la banque', p_note, '/client/accounts');
  perform log_audit('admin_adjust_account_balance', 'accounts', p_account_id, jsonb_build_object('amount', p_amount, 'note', p_note));
  return v_tx_id;
end;
$$;

create or replace function admin_delete_account(p_account_id uuid) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_account accounts%rowtype;
  v_tx_count int;
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  select * into v_account from accounts where id = p_account_id for update;
  if v_account is null then raise exception 'Compte introuvable'; end if;
  if v_account.is_bank_treasury then raise exception 'Le compte de trésorerie de la banque ne peut pas être supprimé'; end if;
  if v_account.balance <> 0 then
    raise exception 'Le solde du compte doit être à 0 avant suppression (actuellement %). Utilisez plutôt le statut "closed" si le compte a un historique.', v_account.balance;
  end if;
  select count(*) into v_tx_count from transactions where from_account_id = p_account_id or to_account_id = p_account_id;
  if v_tx_count > 0 then
    raise exception 'Ce compte a un historique de % transaction(s) — suppression impossible pour préserver la comptabilité. Utilisez le statut "closed" à la place.', v_tx_count;
  end if;
  perform log_audit('admin_delete_account', 'accounts', p_account_id, jsonb_build_object('client', (select display_name from profiles where id = v_account.client_id), 'iban', v_account.iban));
  delete from accounts where id = p_account_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4. Édition (description uniquement) d'une transaction
-- ----------------------------------------------------------------------------

create or replace function admin_update_transaction_description(p_transaction_id uuid, p_description text) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  update transactions set description = p_description where id = p_transaction_id;
  if not found then raise exception 'Transaction introuvable'; end if;
  perform log_audit('admin_update_transaction_description', 'transactions', p_transaction_id, jsonb_build_object('description', p_description));
end;
$$;

-- ----------------------------------------------------------------------------
-- 5. Coffres-forts : décision simple en une étape
-- ----------------------------------------------------------------------------

create or replace function staff_decide_safe_request(p_request_id uuid, p_approve boolean, p_safe_box_id uuid default null, p_note text default null) returns void
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
  select * into r from safe_rental_requests where id = p_request_id and status in ('pending', 'processing') for update;
  if r is null then raise exception 'Demande introuvable ou déjà décidée'; end if;

  if not p_approve then
    if r.safe_box_id is not null then
      update safe_deposit_boxes set status = 'available' where id = r.safe_box_id and status = 'reserved';
    end if;
    update safe_rental_requests set status = 'rejected', decision_note = p_note, decided_by = auth.uid(), decided_at = now()
    where id = p_request_id;
    perform notify(r.client_id, 'safe_rejected', 'Demande de coffre-fort refusée', p_note, '/client/safes');
    perform notify_all_staff('safe_decided', 'Demande de coffre-fort refusée', (select display_name from profiles where id = r.client_id), '/employee/safes');
    perform log_audit('staff_decide_safe_request', 'safe_rental_requests', p_request_id, jsonb_build_object('approved', false, 'note', p_note));
    return;
  end if;

  -- Choix automatique du 1er coffre disponible si aucun n'est précisé —
  -- c'est le coeur de la simplification demandée ("autoriser ou non de
  -- manière simple") : plus besoin de programmer un rendez-vous au préalable.
  if p_safe_box_id is null then
    select id into p_safe_box_id from safe_deposit_boxes where status = 'available' order by branch, code limit 1;
    if p_safe_box_id is null then raise exception 'Aucun coffre disponible actuellement'; end if;
  end if;
  select * into b from safe_deposit_boxes where id = p_safe_box_id and status = 'available';
  if b is null then raise exception 'Ce coffre n''est plus disponible'; end if;

  v_min_balance := coalesce(get_setting_numeric('min_client_balance', r.client_id), 1000000);
  v_new_total := client_total_balance(r.client_id) - b.weekly_fee;
  if v_new_total < v_min_balance and not is_admin() then
    update safe_rental_requests set status = 'processing', safe_box_id = b.id, processing_by = auth.uid(), processing_at = now() where id = p_request_id;
    update safe_deposit_boxes set status = 'reserved' where id = b.id;
    perform notify_all_staff('safe_needs_admin', 'Location de coffre sous le solde minimum — autorisation admin requise', b.code, '/admin/safes', true);
    return;
  end if;

  select id into v_account from accounts where client_id = r.client_id and status = 'active' order by is_bank_treasury, opened_at limit 1;
  v_bank_account := bank_treasury_account_id();

  perform _adjust_balance(v_account, -b.weekly_fee);
  perform _adjust_balance(v_bank_account, b.weekly_fee);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, related_request_type, related_request_id, created_by)
  values ('safe_rental', 'validated', v_account, v_bank_account, b.weekly_fee, 'Location coffre ' || b.code || ' (1 semaine)', 'safe_rental_requests', r.id, auth.uid())
  returning id into v_tx_id;

  update safe_deposit_boxes set status = 'rented', client_id = r.client_id, rented_since = current_date where id = b.id;
  update safe_rental_requests set status = 'validated', safe_box_id = b.id, decision_note = p_note, decided_by = auth.uid(), decided_at = now(),
    confirmed_by = auth.uid(), confirmed_at = now(), resulting_transaction_id = v_tx_id
  where id = p_request_id;

  perform notify(r.client_id, 'safe_validated', 'Location de coffre autorisée — coffre ' || b.code, now()::text, '/client/safes');
  perform notify_all_staff('safe_decided', 'Location de coffre autorisée — ' || b.code, (select display_name from profiles where id = r.client_id), '/employee/safes');
  perform log_audit('staff_decide_safe_request', 'safe_rental_requests', p_request_id, jsonb_build_object(
    'approved', true, 'client', (select display_name from profiles where id = r.client_id), 'safe_code', b.code));
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. Onglet "Infos" client — lecture client, écriture admin/employé/IRS
-- ----------------------------------------------------------------------------

create table if not exists client_info_notes (
  client_id uuid primary key references profiles(id) on delete cascade,
  content text,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);

alter table client_info_notes enable row level security;

drop policy if exists client_info_notes_select on client_info_notes;
create policy client_info_notes_select on client_info_notes for select
  using (client_id = auth.uid() or is_staff() or is_irs());
-- Pas de policy d'écriture directe : toute modification passe par
-- upsert_client_info() (SECURITY DEFINER) ci-dessous, seul moyen d'accorder
-- à l'IRS une exception d'écriture ciblée sans lui donner de policy RLS
-- générale (qu'il n'a nulle part ailleurs, par conception).

create or replace function get_client_info(p_client_id uuid) returns table(content text, updated_at timestamptz, updated_by_name text)
language plpgsql stable security definer set search_path to 'public', 'pg_temp' as $$
begin
  if p_client_id != auth.uid() and not is_staff() and not is_irs() then
    raise exception 'Accès refusé';
  end if;
  return query
  select n.content, n.updated_at, p.display_name
  from client_info_notes n
  left join profiles p on p.id = n.updated_by
  where n.client_id = p_client_id;
end;
$$;

create or replace function upsert_client_info(p_client_id uuid, p_content text) returns void
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
begin
  if not is_staff() and not is_irs() then
    raise exception 'Réservé au personnel (employé, admin) et à l''IRS';
  end if;
  if not exists (select 1 from profiles where id = p_client_id and role = 'client') then
    raise exception 'Client introuvable';
  end if;
  insert into client_info_notes (client_id, content, updated_by, updated_at)
  values (p_client_id, p_content, auth.uid(), now())
  on conflict (client_id) do update set content = excluded.content, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform log_audit('upsert_client_info', 'client_info_notes', p_client_id, jsonb_build_object('client', (select display_name from profiles where id = p_client_id)));
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. Alerte fraude automatique dès qu'un compte passe en négatif
-- ----------------------------------------------------------------------------

create or replace function _adjust_balance(p_account_id uuid, p_delta numeric) returns numeric
language plpgsql security definer set search_path to 'public', 'pg_temp' as $$
declare
  v_old numeric;
  v_new numeric;
  v_client uuid;
  v_is_treasury boolean;
  v_iban text;
begin
  select balance into v_old from accounts where id = p_account_id;
  if v_old is null then
    raise exception 'Compte introuvable: %', p_account_id;
  end if;

  update accounts set balance = balance + p_delta where id = p_account_id
  returning balance, client_id, is_bank_treasury, iban into v_new, v_client, v_is_treasury, v_iban;

  -- Une seule alerte au moment précis où le compte bascule sous zéro — pas à
  -- chaque nouvelle opération tant qu'il le reste (évite le spam d'alertes).
  if v_new < 0 and v_old >= 0 and not coalesce(v_is_treasury, false) then
    perform create_fraud_alert('auto', 'negative_balance', 'medium', v_client, p_account_id, null,
      'Compte ' || coalesce(v_iban, p_account_id::text) || ' passé en négatif (' || v_new || ' $)');
  end if;

  return v_new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 8. Matrice de messagerie resserrée
-- ----------------------------------------------------------------------------

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
    and (
      v_caller_role in ('admin', 'employee')
      or (v_caller_role = 'client' and p.role in ('employee', 'admin'))
      or (v_caller_role = 'irs' and p.role in ('employee', 'admin'))
    )
    and (p_search is null or trim(p_search) = '' or p.display_name ilike '%' || p_search || '%' or p.username ilike '%' || p_search || '%')
  order by p.role, p.display_name
  limit 50;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 9. Enregistrement des écrans ajoutés lors des lots précédents/celui-ci dans
--    le registre de fonctionnalités, pour qu'ils soient activables/
--    désactivables comme le reste (/admin/permissions).
-- ----------------------------------------------------------------------------

insert into feature_registry (key, label, description, area, category, default_roles, enabled, is_core) values
  ('employee.transactions.view', 'Historique des transactions', 'Vue 360 de tous les mouvements d''argent (virements, frais, prêts, lingots, coffres...)', 'employee', 'Opérations', '{employee,admin}', true, false),
  ('admin.transactions.view', 'Historique des transactions', 'Vue 360 de tous les mouvements d''argent, avec édition de la description', 'admin', 'Opérations', '{admin}', true, false),
  ('client.info.view', 'Onglet Infos', 'Informations communiquées par la banque au client (lecture seule pour lui)', 'client', 'Services', '{client}', true, false)
on conflict (key) do nothing;

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
  -- Matrice : Client -> Employé/Admin uniquement ; IRS -> Employé/Admin
  -- uniquement ; Admin/Employé -> tout le monde.
  if not (
    v_caller_role in ('admin', 'employee')
    or (v_caller_role = 'client' and v_recipient_role in ('employee', 'admin'))
    or (v_caller_role = 'irs' and v_recipient_role in ('employee', 'admin'))
  ) then
    raise exception 'Vous ne pouvez pas contacter ce type de profil';
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

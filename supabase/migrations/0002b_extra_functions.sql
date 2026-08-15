-- ============================================================================
-- NEWPAD — Migration 0002b : fonctions complémentaires (visibilité, support)
-- ============================================================================

-- Lecture "publique" de profil (id/username/display_name/role uniquement) —
-- utilisée pour afficher des noms sans exposer pin_hash / trust_score / etc.
create or replace function profile_public_lookup(p_id uuid) returns table(id uuid, username text, display_name text, role user_role)
language sql stable security definer as $$
  select id, username, display_name, role from profiles where id = p_id;
$$;

-- Visibilité d'un compte/transaction pour le rôle courant, selon le masquage
-- générique par interface (visibility_masks).
create or replace function visible_for_current_role(p_type visibility_target, p_id uuid) returns boolean
language sql stable security definer as $$
  select case current_role_name()
    when 'admin' then not is_masked_for(p_type, p_id, 'admin')
    when 'employee' then not is_masked_for(p_type, p_id, 'employee')
    when 'client' then not is_masked_for(p_type, p_id, 'client')
    when 'irs' then not is_masked_for(p_type, p_id, 'irs')
    else true
  end;
$$;

create or replace function admin_set_visibility_mask(p_type visibility_target, p_id uuid, p_hidden_from app_interface[], p_reason text default null) returns void
language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'Réservé à l''admin'; end if;
  insert into visibility_masks (target_type, target_id, hidden_from_interfaces, reason, created_by)
  values (p_type, p_id, p_hidden_from, p_reason, auth.uid())
  on conflict (target_type, target_id) do update set hidden_from_interfaces = excluded.hidden_from_interfaces, reason = excluded.reason, created_by = excluded.created_by, created_at = now();
  perform log_audit('set_visibility_mask', p_type::text, p_id, jsonb_build_object('hidden_from', p_hidden_from));
end;
$$;

-- ----------------------------------------------------------------------------
-- SUPPORT — ticket = fil de discussion
-- ----------------------------------------------------------------------------

create or replace function create_support_ticket(p_subject text, p_category text, p_first_message text) returns uuid
language plpgsql security definer as $$
declare v_id uuid;
begin
  insert into support_tickets (client_id, subject, category) values (auth.uid(), p_subject, p_category) returning id into v_id;
  insert into support_messages (ticket_id, author_id, author_role, body) values (v_id, auth.uid(), 'client', p_first_message);
  perform notify_all_staff('support_new_ticket', 'Nouveau ticket de support', p_subject, '/employee/support');
  return v_id;
end;
$$;

create or replace function post_support_message(p_ticket_id uuid, p_body text) returns uuid
language plpgsql security definer as $$
declare
  v_id uuid;
  t support_tickets%rowtype;
  v_role user_role;
begin
  select * into t from support_tickets where id = p_ticket_id;
  if t is null then raise exception 'Ticket introuvable'; end if;
  v_role := current_role_name();
  if v_role = 'client' and t.client_id != auth.uid() then raise exception 'Accès refusé'; end if;
  if v_role not in ('client','employee','admin') then raise exception 'Accès refusé'; end if;

  insert into support_messages (ticket_id, author_id, author_role, body) values (p_ticket_id, auth.uid(), v_role, p_body) returning id into v_id;
  update support_tickets set updated_at = now(), status = case when status = 'resolved' then 'open' else status end,
    assigned_to = case when v_role in ('employee','admin') and assigned_to is null then auth.uid() else assigned_to end
  where id = p_ticket_id;

  if v_role = 'client' then
    perform notify_all_staff('support_new_message', 'Nouveau message sur un ticket', t.subject, '/employee/support');
  else
    perform notify(t.client_id, 'support_new_message', 'Nouveau message sur votre ticket', t.subject, '/client/support');
  end if;
  return v_id;
end;
$$;

create or replace function resolve_support_ticket(p_ticket_id uuid) returns void
language plpgsql security definer as $$
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  update support_tickets set status = 'resolved', resolved_at = now() where id = p_ticket_id;
end;
$$;

-- ----------------------------------------------------------------------------
-- CONSULTING PREMIUM
-- ----------------------------------------------------------------------------

create or replace function assign_consulting_request(p_id uuid, p_advisor_id uuid) returns void
language plpgsql security definer as $$
declare v_client uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  update consulting_requests set status = 'assigned', assigned_advisor_id = p_advisor_id where id = p_id returning client_id into v_client;
  perform notify(v_client, 'consulting_assigned', 'Un conseiller vous a été attribué', null, '/client/consulting');
end;
$$;

-- ----------------------------------------------------------------------------
-- COMPTES — actions admin directes (statut uniquement, jamais le solde)
-- ----------------------------------------------------------------------------

create or replace function admin_set_account_status(p_account_id uuid, p_status account_status) returns void
language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'Réservé à l''admin'; end if;
  update accounts set status = p_status, closed_at = case when p_status = 'closed' then now() else null end where id = p_account_id;
  perform log_audit('admin_set_account_status', 'accounts', p_account_id, jsonb_build_object('status', p_status));
end;
$$;

create or replace function admin_set_profile_status(p_profile_id uuid, p_status text) returns void
language plpgsql security definer as $$
begin
  if not is_admin() then raise exception 'Réservé à l''admin'; end if;
  if p_status not in ('active','suspended','frozen') then raise exception 'Statut invalide'; end if;
  update profiles set status = p_status where id = p_profile_id;
  perform log_audit('admin_set_profile_status', 'profiles', p_profile_id, jsonb_build_object('status', p_status));
end;
$$;

-- ----------------------------------------------------------------------------
-- Auto-création du profil à l'inscription Supabase Auth
-- ----------------------------------------------------------------------------
-- Le frontend crée l'utilisateur via supabase.auth.signUp() avec
-- email = "<identifiant>@newpad.local" et passe username/display_name dans
-- les user_metadata ; ce trigger crée automatiquement la ligne `profiles`
-- correspondante avec le rôle 'prospect'.

create or replace function handle_new_auth_user() returns trigger
language plpgsql security definer as $$
begin
  insert into profiles (id, username, role, display_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'prospect'),
    coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'username', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger trg_new_auth_user
  after insert on auth.users
  for each row execute function handle_new_auth_user();

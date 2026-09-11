-- ############################################################################
-- 0046 — NEWMAIL : LA MESSAGERIE INTERNE (§40)
-- ############################################################################
-- À ne pas confondre avec `message_threads`/`thread_messages`, qui restent la
-- messagerie de SERVICE de Newman Bank : un client qui écrit à son conseiller,
-- un employé qui écrit à l'admin. Celle-ci est la messagerie de la ville —
-- n'importe qui écrit à n'importe qui, avec objet, pièces jointes et dossiers.
-- Fusionner les deux ferait cohabiter les demandes bancaires et les échanges
-- privés dans la même boîte, et casserait la matrice de contacts resserrée que
-- la banque s'est donnée (lot du 24/08).
--
-- Les pièces jointes ne sont pas des fichiers envoyés : ce sont des documents
-- de NewFiles autorisés aux destinataires (§17). Retirer l'autorisation coupe
-- l'accès, même sur un message déjà reçu.
--
-- Note de déploiement : appliquée en production en deux passes (le socle, puis
-- les deux fonctions de lecture). Ce fichier réunit les deux.
-- ############################################################################

create table if not exists mail_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references profiles(id) on delete cascade,
  subject text not null,
  body text not null,
  sender_folder text not null default 'sent',
  created_at timestamptz not null default now(),
  constraint mail_subject_len check (length(trim(subject)) between 1 and 150),
  constraint mail_body_len check (length(body) between 1 and 10000),
  constraint mail_sender_folder_check check (sender_folder in ('sent','trash'))
);

create table if not exists mail_recipients (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references mail_messages(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  folder text not null default 'inbox',
  is_read boolean not null default false,
  read_at timestamptz,
  unique (message_id, profile_id),
  constraint mail_folder_check check (folder in ('inbox','archive','trash'))
);

create table if not exists mail_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references mail_messages(id) on delete cascade,
  file_id uuid not null references files(id) on delete cascade,
  unique (message_id, file_id)
);

create table if not exists mail_drafts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  to_profile_id uuid references profiles(id) on delete set null,
  subject text not null default '',
  body text not null default '',
  updated_at timestamptz not null default now()
);

create index if not exists idx_mail_recipients_profile on mail_recipients(profile_id, folder);
create index if not exists idx_mail_messages_sender on mail_messages(sender_id, sender_folder);
create index if not exists idx_mail_drafts_owner on mail_drafts(owner_id);

-- ----------------------------------------------------------------------------
-- Lecture
-- ----------------------------------------------------------------------------
-- Même précaution que pour NewFiles : la fonction est citée par une policy,
-- donc son nom ne porte PAS de souligné — une fonction interne serait refusée à
-- l'exécution pour l'utilisateur qui interroge, et la table deviendrait
-- illisible sans que rien ne le laisse voir (défaut corrigé en 0043).
create or replace function can_read_mail(p_message_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from mail_messages m where m.id = p_message_id and m.sender_id = auth.uid()
  ) or exists (
    select 1 from mail_recipients r where r.message_id = p_message_id and r.profile_id = auth.uid()
  );
$function$;

alter table mail_messages enable row level security;
alter table mail_recipients enable row level security;
alter table mail_attachments enable row level security;
alter table mail_drafts enable row level security;

drop policy if exists mail_messages_select on mail_messages;
create policy mail_messages_select on mail_messages
  for select to authenticated using (can_read_mail(id));

-- Un destinataire voit qu'il y avait d'autres destinataires : c'est le
-- fonctionnement normal d'un courrier. Il ne voit en revanche aucune ligne des
-- messages auxquels il n'a pas part.
drop policy if exists mail_recipients_select on mail_recipients;
create policy mail_recipients_select on mail_recipients
  for select to authenticated using (can_read_mail(message_id));

drop policy if exists mail_attachments_select on mail_attachments;
create policy mail_attachments_select on mail_attachments
  for select to authenticated using (can_read_mail(message_id));

-- Les brouillons sont la seule table de l'application où l'écriture directe est
-- autorisée : un brouillon n'engage rien, n'est visible de personne d'autre, et
-- passer par une fonction à chaque frappe n'apporterait aucune garantie.
drop policy if exists mail_drafts_all on mail_drafts;
create policy mail_drafts_all on mail_drafts
  for all to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- ----------------------------------------------------------------------------
-- Envoi
-- ----------------------------------------------------------------------------
create or replace function mail_send(
  p_to uuid[],
  p_subject text,
  p_body text,
  p_file_ids uuid[] default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid; v_dest uuid; v_file uuid; v_nom text; v_nb int;
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  perform require_active_profile();

  if p_to is null or array_length(p_to, 1) is null then
    raise exception 'Indiquez au moins un destinataire';
  end if;
  if array_length(p_to, 1) > 20 then
    -- Une limite existe pour que la messagerie ne devienne pas un outil de
    -- diffusion de masse : les annonces à toute la ville ont leur application.
    raise exception 'Vingt destinataires au maximum par message';
  end if;
  if coalesce(trim(p_subject), '') = '' then raise exception 'L''objet est obligatoire'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'Le message est vide'; end if;

  insert into mail_messages (sender_id, subject, body)
  values (auth.uid(), trim(p_subject), p_body)
  returning id into v_id;

  select display_name into v_nom from profiles where id = auth.uid();

  foreach v_dest in array p_to loop
    if v_dest = auth.uid() then continue; end if;
    if not exists (select 1 from profiles where id = v_dest and status = 'active') then
      raise exception 'Destinataire introuvable ou inactif';
    end if;
    insert into mail_recipients (message_id, profile_id)
    values (v_id, v_dest) on conflict (message_id, profile_id) do nothing;
    perform notify(v_dest, 'mail', 'Nouveau message', v_nom || ' — ' || trim(p_subject), '/mail');
  end loop;

  select count(*) into v_nb from mail_recipients where message_id = v_id;
  if v_nb = 0 then raise exception 'Aucun destinataire valide'; end if;

  -- Pièces jointes : on n'envoie pas de copie, on AUTORISE. Le document reste
  -- dans le coffre de l'expéditeur ; retirer l'autorisation depuis NewFiles
  -- coupe l'accès, y compris sur un message déjà reçu.
  if p_file_ids is not null then
    foreach v_file in array p_file_ids loop
      if file_owner_id(v_file) is distinct from auth.uid() then
        raise exception 'Vous ne pouvez joindre que vos propres documents';
      end if;
      insert into mail_attachments (message_id, file_id)
      values (v_id, v_file) on conflict do nothing;

      insert into file_permissions (file_id, grantee_type, grantee_id, permission, granted_by, note)
      select v_file, 'profile', r.profile_id, 'view', auth.uid(), 'Pièce jointe — ' || trim(p_subject)
      from mail_recipients r where r.message_id = v_id
      on conflict (file_id, grantee_type, grantee_id) do nothing;
    end loop;
  end if;

  return v_id;
end;
$function$;

create or replace function mail_set_folder(p_message_id uuid, p_folder text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if p_folder not in ('inbox', 'archive', 'trash', 'sent') then
    raise exception 'Dossier invalide';
  end if;
  -- Le même message vit dans deux dossiers à la fois : celui de l'expéditeur et
  -- celui de chaque destinataire. Ranger de son côté ne touche pas les autres.
  if p_folder = 'sent' or p_folder = 'trash' then
    update mail_messages set sender_folder = case when p_folder = 'sent' then 'sent' else 'trash' end
    where id = p_message_id and sender_id = auth.uid();
  end if;
  if p_folder in ('inbox', 'archive', 'trash') then
    update mail_recipients set folder = p_folder
    where message_id = p_message_id and profile_id = auth.uid();
  end if;
end;
$function$;

create or replace function mail_mark_read(p_message_id uuid, p_read boolean default true)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  update mail_recipients
  set is_read = coalesce(p_read, true),
      read_at = case when coalesce(p_read, true) then now() else null end
  where message_id = p_message_id and profile_id = auth.uid();
end;
$function$;

create or replace function mail_unread_count()
returns integer
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select count(*)::int from mail_recipients
  where profile_id = auth.uid() and folder = 'inbox' and not is_read;
$function$;

-- ----------------------------------------------------------------------------
-- Lecture en un appel
-- ----------------------------------------------------------------------------
-- Un message affiche le NOM de son expéditeur et de ses destinataires. Or un
-- joueur n'a pas le droit de parcourir les profils des autres — et il ne doit
-- pas l'avoir. Sans ces fonctions, l'interface devrait demander chaque nom
-- séparément, ce qui échouerait sur les policies ; en élargissant la lecture
-- des profils pour y remédier, on ouvrirait un annuaire de toute la ville pour
-- afficher trois noms. Elles ne révèlent donc que les noms des personnes déjà
-- parties au message : la plus petite ouverture qui fasse le travail.

create or replace function mail_list(p_folder text default 'inbox')
returns table (
  id uuid, subject text, extrait text, created_at timestamptz,
  sender_id uuid, sender_name text, is_read boolean, dossier text,
  nb_pieces int, destinataires text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  if p_folder not in ('inbox', 'archive', 'trash', 'sent') then
    raise exception 'Dossier invalide';
  end if;

  if p_folder = 'sent' then
    return query
      select m.id, m.subject, left(m.body, 140), m.created_at,
             m.sender_id, p.display_name, true, 'sent'::text,
             (select count(*)::int from mail_attachments a where a.message_id = m.id),
             (select string_agg(pr.display_name, ', ' order by pr.display_name)
                from mail_recipients r join profiles pr on pr.id = r.profile_id
               where r.message_id = m.id)
      from mail_messages m
      join profiles p on p.id = m.sender_id
      where m.sender_id = auth.uid() and m.sender_folder = 'sent'
      order by m.created_at desc limit 200;
  else
    return query
      select m.id, m.subject, left(m.body, 140), m.created_at,
             m.sender_id, p.display_name, r.is_read, r.folder,
             (select count(*)::int from mail_attachments a where a.message_id = m.id),
             (select string_agg(pr.display_name, ', ' order by pr.display_name)
                from mail_recipients r2 join profiles pr on pr.id = r2.profile_id
               where r2.message_id = m.id)
      from mail_recipients r
      join mail_messages m on m.id = r.message_id
      join profiles p on p.id = m.sender_id
      where r.profile_id = auth.uid() and r.folder = p_folder
      order by m.created_at desc limit 200;
  end if;
end;
$function$;

create or replace function mail_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_res jsonb;
begin
  if not can_read_mail(p_id) then raise exception 'Message introuvable'; end if;

  select jsonb_build_object(
    'id', m.id, 'subject', m.subject, 'body', m.body, 'created_at', m.created_at,
    'sender_id', m.sender_id, 'sender_name', p.display_name,
    'destinataires', coalesce((
      select jsonb_agg(jsonb_build_object('id', pr.id, 'nom', pr.display_name) order by pr.display_name)
      from mail_recipients r join profiles pr on pr.id = r.profile_id
      where r.message_id = m.id), '[]'::jsonb),
    'pieces', coalesce((
      select jsonb_agg(jsonb_build_object(
        'file_id', f.id, 'nom', f.name, 'categorie', f.category,
        'storage_path', f.storage_path, 'accessible', can_read_file(f.id)))
      from mail_attachments a join files f on f.id = a.file_id
      where a.message_id = m.id), '[]'::jsonb)
  ) into v_res
  from mail_messages m
  join profiles p on p.id = m.sender_id
  where m.id = p_id;

  return v_res;
end;
$function$;

update app_registry set status = 'live', admin_route = null where slug = 'mail';

do $verif$
declare v_mauvaises text;
begin
  select string_agg(policyname || ' (' || tablename || ')', ', ')
    into v_mauvaises
  from pg_policies
  where schemaname = 'public'
    and (coalesce(qual, '') || coalesce(with_check, '')) ~ '[^a-zA-Z0-9_]_[a-z][a-z_]*\(';
  if v_mauvaises is not null then
    raise exception 'Policies appelant une fonction interne : %', v_mauvaises;
  end if;
end
$verif$;


-- Permissions (règle de balayage, voir 0038/0039).
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

grant execute on function record_login_attempt(text, boolean) to anon;
grant execute on function gold_price_snapshot() to anon;
grant execute on function can_open_app(text) to anon;

do $do$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace and left(p.proname, 1) = '_'
  loop
    execute format('revoke execute on function %s from authenticated', f.sig);
  end loop;
end
$do$;

revoke execute on function revoke_user_sessions(uuid) from authenticated;
revoke execute on function notify(uuid, text, text, text, text, jsonb) from authenticated;
revoke execute on function notify_all_staff(text, text, text, text, boolean) from authenticated;
revoke execute on function purge_old_notifications() from authenticated;
revoke execute on function log_audit(text, text, uuid, jsonb) from authenticated;
revoke execute on function generate_iban() from authenticated;

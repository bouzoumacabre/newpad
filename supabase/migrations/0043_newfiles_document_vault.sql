-- ############################################################################
-- 0043 — NEWFILES : LE COFFRE DOCUMENTAIRE CENTRAL (§16, §17)
-- ############################################################################
-- Règle fondamentale du §13 : une donnée qui existe déjà quelque part dans
-- Newpad ne doit pas être recréée ailleurs. Un document déposé ici est
-- utilisable par NewWork, NewGov, NewDoc, SACEM ou NewInsurance — sans jamais
-- être dupliqué : ces applications reçoivent une AUTORISATION de consultation,
-- pas une copie (§17). Une copie divergerait de l'original au premier
-- remplacement, et surtout resterait lisible après la révocation du partage.
--
-- Note de déploiement : appliquée en production en deux passes (le coffre, puis
-- un correctif de privilège sur une fonction appelée depuis une policy —
-- voir le commentaire de `file_owner_id`). Ce fichier est la version corrigée.
-- ############################################################################

create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  organization_id uuid references organizations(id) on delete set null,
  name text not null,
  category text not null default 'other',
  mime_type text,
  size_bytes bigint,
  storage_path text not null unique,
  description text,
  source_app text,
  is_official boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint files_name_len check (length(trim(name)) between 1 and 120),
  constraint files_category_check check (category in (
    'identity','bank','work','legal','medical','vehicle','property',
    'insurance','music','business','other'
  )),
  constraint files_size_check check (size_bytes is null or size_bytes between 0 and 26214400)
);
comment on table files is
  'Coffre documentaire central de Newpad. Un document y est stocké une seule fois ; les autres applications y accèdent par autorisation, jamais par copie.';

create index if not exists idx_files_owner on files(owner_id) where deleted_at is null;
create index if not exists idx_files_org on files(organization_id) where deleted_at is null;

create table if not exists file_permissions (
  id uuid primary key default gen_random_uuid(),
  file_id uuid not null references files(id) on delete cascade,
  grantee_type text not null,
  grantee_id uuid not null,
  permission text not null default 'view',
  granted_by uuid not null references profiles(id) on delete cascade,
  note text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (file_id, grantee_type, grantee_id),
  constraint file_permissions_grantee_check check (grantee_type in ('profile','organization')),
  constraint file_permissions_perm_check check (permission in ('view','download'))
);
comment on table file_permissions is
  'Autorisation de consultation d''un document, accordée à un profil ou à une organisation. Révocable et expirable : c''est ce qui remplace la duplication du fichier.';

create index if not exists idx_file_perms_grantee on file_permissions(grantee_type, grantee_id);

drop trigger if exists trg_files_touch on files;
create trigger trg_files_touch before update on files
  for each row execute function _touch_updated_at();


-- ############################################################################
-- QUI A LE DROIT DE VOIR QUOI
-- ############################################################################
-- Ces deux fonctions DOIVENT être `security definer` : la policy de `files`
-- interroge `file_permissions` et celle de `file_permissions` interroge
-- `files`. En sous-requêtes directes, chaque policy se réapplique à sa propre
-- sous-requête et PostgreSQL s'arrête sur une récursion infinie — défaut déjà
-- rencontré et corrigé sur les organisations (0040).
--
-- Et surtout : aucune des deux ne porte de nom préfixé d'un souligné. La
-- convention du projet (0038) retire aux utilisateurs le droit d'exécuter les
-- fonctions ainsi nommées — or une expression de policy s'évalue avec les
-- privilèges de CELUI QUI INTERROGE. Une fonction citée par une policy fait
-- donc partie de la surface appelable, quoi qu'elle fasse. La première version
-- s'appelait `_file_owner` : toute lecture de `file_permissions` échouait sur
-- « permission denied for function _file_owner », et le partage de documents
-- était entièrement mort. Une vérification automatique est posée plus bas pour
-- que ce piège ne se retende jamais.

create or replace function file_owner_id(p_file_id uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select owner_id from files where id = p_file_id;
$function$;

create or replace function can_read_file(p_file_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from files f where f.id = p_file_id and f.owner_id = auth.uid()
  ) or exists (
    select 1 from file_permissions p
    where p.file_id = p_file_id
      and (p.expires_at is null or p.expires_at > now())
      and (
        (p.grantee_type = 'profile' and p.grantee_id = auth.uid())
        or (p.grantee_type = 'organization' and is_org_member(p.grantee_id))
      )
  );
$function$;

alter table files enable row level security;
alter table file_permissions enable row level security;

-- Volontairement, NI le personnel de la banque NI l'administrateur Newpad ne
-- figurent ici. Un coffre documentaire contient des certificats médicaux (§49)
-- et des pièces d'identité : un accès administrateur transversal en ferait un
-- dossier consultable sur toute la ville. L'administration gère les
-- applications, pas le contenu des coffres.
drop policy if exists files_select on files;
create policy files_select on files
  for select to authenticated
  using (deleted_at is null and can_read_file(id));

drop policy if exists file_permissions_select on file_permissions;
create policy file_permissions_select on file_permissions
  for select to authenticated
  using (
    file_owner_id(file_id) = auth.uid()
    or (grantee_type = 'profile' and grantee_id = auth.uid())
    or (grantee_type = 'organization' and is_org_member(grantee_id))
  );


-- ############################################################################
-- ÉCRITURE — exclusivement par fonctions
-- ############################################################################

create or replace function newfiles_register(
  p_name text,
  p_storage_path text,
  p_category text default 'other',
  p_mime_type text default null,
  p_size_bytes bigint default null,
  p_description text default null,
  p_organization_id uuid default null,
  p_source_app text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  perform require_active_profile();
  if coalesce(trim(p_name), '') = '' then raise exception 'Le nom du document est obligatoire'; end if;

  -- Le chemin de stockage commence par l'identifiant du propriétaire : c'est ce
  -- que vérifient aussi les policies du bucket. Sans ce contrôle ici, on
  -- pourrait enregistrer une ligne pointant vers le fichier d'un autre joueur
  -- et se l'attribuer.
  if p_storage_path is null or split_part(p_storage_path, '/', 1) <> auth.uid()::text then
    raise exception 'Chemin de stockage invalide';
  end if;

  if p_organization_id is not null and not is_org_member(p_organization_id) then
    raise exception 'Vous n''êtes pas membre de cette organisation';
  end if;

  insert into files (owner_id, organization_id, name, category, mime_type, size_bytes,
                     storage_path, description, source_app)
  values (auth.uid(), p_organization_id, trim(p_name), coalesce(p_category, 'other'),
          p_mime_type, p_size_bytes, p_storage_path,
          nullif(trim(coalesce(p_description, '')), ''), nullif(trim(coalesce(p_source_app, '')), ''))
  returning id into v_id;

  return v_id;
end;
$function$;

create or replace function newfiles_update(
  p_id uuid,
  p_name text,
  p_category text default null,
  p_description text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if file_owner_id(p_id) is distinct from auth.uid() then
    raise exception 'Ce document ne vous appartient pas';
  end if;
  update files set
    name = trim(p_name),
    category = coalesce(p_category, category),
    description = nullif(trim(coalesce(p_description, '')), '')
  where id = p_id and deleted_at is null;
end;
$function$;

create or replace function newfiles_delete(p_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_path text;
begin
  if file_owner_id(p_id) is distinct from auth.uid() then
    raise exception 'Ce document ne vous appartient pas';
  end if;
  select storage_path into v_path from files where id = p_id;
  -- Les autorisations partent avec le document : laisser des lignes orphelines
  -- ferait croire à un partage encore actif.
  delete from file_permissions where file_id = p_id;
  update files set deleted_at = now() where id = p_id;
  return v_path;
end;
$function$;

create or replace function newfiles_share(
  p_file_id uuid,
  p_grantee_type text,
  p_grantee_id uuid,
  p_permission text default 'view',
  p_expires_at timestamptz default null,
  p_note text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_nom text;
  v_proprietaire text;
begin
  if file_owner_id(p_file_id) is distinct from auth.uid() then
    raise exception 'Ce document ne vous appartient pas';
  end if;
  if p_grantee_type not in ('profile', 'organization') then
    raise exception 'Destinataire invalide';
  end if;
  if p_permission not in ('view', 'download') then
    raise exception 'Permission invalide';
  end if;
  if p_grantee_type = 'profile' and p_grantee_id = auth.uid() then
    raise exception 'Ce document est déjà le vôtre';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'La date d''expiration doit être dans le futur';
  end if;

  insert into file_permissions (file_id, grantee_type, grantee_id, permission, granted_by, note, expires_at)
  values (p_file_id, p_grantee_type, p_grantee_id, p_permission, auth.uid(),
          nullif(trim(coalesce(p_note, '')), ''), p_expires_at)
  on conflict (file_id, grantee_type, grantee_id)
  do update set permission = excluded.permission, expires_at = excluded.expires_at,
                note = excluded.note, granted_by = excluded.granted_by;

  select name into v_nom from files where id = p_file_id;
  select display_name into v_proprietaire from profiles where id = auth.uid();

  if p_grantee_type = 'profile' then
    perform notify(p_grantee_id, 'file_shared', 'Document partagé avec vous',
      v_proprietaire || ' vous donne accès à « ' || v_nom || ' »', '/files');
  end if;
end;
$function$;

create or replace function newfiles_revoke(p_file_id uuid, p_grantee_type text, p_grantee_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if file_owner_id(p_file_id) is distinct from auth.uid() then
    raise exception 'Ce document ne vous appartient pas';
  end if;
  delete from file_permissions
  where file_id = p_file_id and grantee_type = p_grantee_type and grantee_id = p_grantee_id;
end;
$function$;

-- Recherche d'un destinataire pour le partage. Volontairement limitée : on
-- cherche par identifiant exact ou par nom, et on ne renvoie jamais plus de
-- quelques résultats — un annuaire complet des joueurs n'a pas à sortir d'ici.
create or replace function newfiles_search_recipients(p_query text)
returns table (id uuid, username text, display_name text)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_q text;
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  v_q := lower(trim(coalesce(p_query, '')));
  if length(v_q) < 2 then return; end if;
  return query
    select p.id, p.username, p.display_name
    from profiles p
    where p.id <> auth.uid()
      and p.status = 'active'
      and (lower(p.username) like v_q || '%' or lower(p.display_name) like '%' || v_q || '%')
    order by p.display_name
    limit 10;
end;
$function$;


-- ############################################################################
-- STOCKAGE
-- ############################################################################
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('newpad-files', 'newpad-files', false, 26214400, null)
on conflict (id) do update set public = false, file_size_limit = 26214400;

-- Le bucket est privé : la lecture passe par une URL signée, et cette URL n'est
-- délivrée qu'à qui la policy ci-dessous autorise. Un bucket public aurait rendu
-- chaque document accessible à quiconque devine son chemin.
drop policy if exists newfiles_objects_read on storage.objects;
create policy newfiles_objects_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'newpad-files'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from files f
        where f.storage_path = storage.objects.name
          and f.deleted_at is null
          and can_read_file(f.id)
      )
    )
  );

drop policy if exists newfiles_objects_write on storage.objects;
create policy newfiles_objects_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'newpad-files' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists newfiles_objects_delete on storage.objects;
create policy newfiles_objects_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'newpad-files' and (storage.foldername(name))[1] = auth.uid()::text);

update app_registry set status = 'live' where slug = 'files';


-- ############################################################################
-- GARDE-FOU PERMANENT
-- ############################################################################
-- Aucune policy ne doit citer une fonction interne : elle serait refusée à
-- l'exécution pour l'utilisateur qui interroge, et la table deviendrait
-- illisible sans que rien dans le code ne le laisse voir.
do $verif$
declare v_mauvaises text;
begin
  select string_agg(policyname || ' (' || tablename || ')', ', ')
    into v_mauvaises
  from pg_policies
  where schemaname = 'public'
    and (coalesce(qual, '') || coalesce(with_check, '')) ~ '[^a-zA-Z0-9_]_[a-z][a-z_]*\(';
  if v_mauvaises is not null then
    raise exception 'Policies appelant une fonction interne (non exécutable par authenticated) : %', v_mauvaises;
  end if;
end
$verif$;


-- ----------------------------------------------------------------------------
-- Permissions (règle de balayage, voir 0038/0039).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

grant execute on function record_login_attempt(text, boolean) to anon;
grant execute on function gold_price_snapshot() to anon;

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

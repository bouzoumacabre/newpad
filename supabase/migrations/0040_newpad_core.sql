-- ############################################################################
-- 0040 — NOYAU NEWPAD
-- ############################################################################
-- Première migration qui sort du périmètre strictement bancaire : elle pose les
-- trois entités transverses dont TOUTES les applications Newpad dépendront
-- (registre d'applications, organisations, appartenance aux organisations), plus
-- l'identité Newpad ajoutée au profil déjà existant.
--
-- Note de déploiement : cette migration a été appliquée en production en deux
-- passes (le noyau, puis un correctif de récursion sur les policies des
-- organisations, découvert en la testant). Le fichier ci-dessous est la version
-- corrigée, celle à rejouer pour toute reconstruction depuis zéro.
--
-- Principe directeur : ne rien dupliquer. `profiles` reste l'identité unique
-- (§11 du cahier des charges) ; on lui ajoute seulement ce qui manquait
-- (avatar, bio, rôle Newpad). Aucune table bancaire n'est modifiée.
-- ############################################################################


-- ############################################################################
-- PARTIE A — IDENTITÉ NEWPAD SUR LE PROFIL EXISTANT
-- ############################################################################

alter table profiles add column if not exists avatar_url text;
alter table profiles add column if not exists bio text;
alter table profiles add column if not exists newpad_role text not null default 'user';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_newpad_role_check') then
    alter table profiles add constraint profiles_newpad_role_check
      check (newpad_role in ('user', 'admin'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_bio_len_check') then
    alter table profiles add constraint profiles_bio_len_check
      check (bio is null or length(bio) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_avatar_url_check') then
    alter table profiles add constraint profiles_avatar_url_check
      check (avatar_url is null or avatar_url ~ '^https?://' and length(avatar_url) <= 500);
  end if;
end $$;

-- L'admin de la banque est aussi l'administrateur global Newpad : c'est la même
-- personne (le propriétaire du serveur). La séparation reste possible plus tard
-- puisque la colonne est indépendante du rôle bancaire.
update profiles set newpad_role = 'admin' where role = 'admin' and newpad_role <> 'admin';

-- ----------------------------------------------------------------------------
-- SÉCURITÉ — le garde d'auto-modification doit couvrir la nouvelle colonne.
-- Sans cela, n'importe quel joueur pourrait se promouvoir administrateur global
-- d'un simple update sur son propre profil : c'est exactement l'escalade de
-- privilèges corrigée à l'étape 1 (migration 0019), qu'il ne faut pas rouvrir
-- en ajoutant une colonne de rôle à une table que l'utilisateur peut écrire.
-- ----------------------------------------------------------------------------
create or replace function enforce_profile_self_update()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if is_admin() or auth.uid() is null or coalesce(current_setting('app.bypass_profile_guard', true), '') = 'true' then
    return new;
  end if;
  if new.role is distinct from old.role
     or new.newpad_role is distinct from old.newpad_role
     or new.status is distinct from old.status
     or new.trust_score is distinct from old.trust_score
     or new.min_balance_override is distinct from old.min_balance_override
     or new.min_transfer_override is distinct from old.min_transfer_override
     or new.username is distinct from old.username
     or new.client_since is distinct from old.client_since
     or new.employee_title is distinct from old.employee_title
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     or new.id is distinct from old.id then
    raise exception 'Modification non autorisée sur ce champ de profil';
  end if;
  return new;
end;
$function$;

create or replace function is_newpad_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from profiles
    where id = auth.uid()
      and status = 'active'
      and (newpad_role = 'admin' or role = 'admin')
  );
$function$;


-- ############################################################################
-- PARTIE B — ORGANISATIONS (§12)
-- ############################################################################
-- Entité centrale unique : entreprise, gouvernement, média, label, concession,
-- bijouterie, assurance, hôpital. Les applications s'y rattachent au lieu de
-- recréer chacune sa propre notion d'entreprise.

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  kind text not null default 'company',
  description text,
  logo_url text,
  banner_url text,
  owner_id uuid references profiles(id) on delete set null,
  contact_email text,
  contact_phone text,
  location text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_slug_format check (slug ~ '^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])$'),
  constraint organizations_name_len check (length(trim(name)) between 2 and 80),
  constraint organizations_kind_check check (kind in (
    'company','government','media','label','dealership','jewelry',
    'insurance','hospital','realestate','association','other'
  )),
  constraint organizations_status_check check (status in ('active','suspended','closed'))
);
comment on table organizations is
  'Entité centrale Newpad : toute personne morale RP (entreprise, gouvernement, média, label...). Les applications la référencent au lieu de recréer leurs propres entreprises.';

create table if not exists organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  member_role text not null default 'member',
  grade_label text,
  created_at timestamptz not null default now(),
  unique (organization_id, profile_id),
  constraint organization_members_role_check check (member_role in ('owner','manager','member'))
);
comment on table organization_members is
  'Appartenance d''un profil à une organisation. Un utilisateur peut appartenir à plusieurs organisations (§12).';

create index if not exists idx_org_members_profile on organization_members(profile_id);
create index if not exists idx_org_members_org on organization_members(organization_id);


-- ############################################################################
-- PARTIE C — REGISTRE DES APPLICATIONS (§7)
-- ############################################################################
-- L'écran d'accueil de la tablette est GÉNÉRÉ depuis cette table. Aucune
-- application n'est codée en dur dans le composant d'accueil : ajouter,
-- déplacer, renommer ou désactiver une application se fait sans toucher au code.

create table if not exists app_registry (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  short_name text,
  description text,
  icon_key text,
  icon_url text,
  logo_url text,
  accent_color text,
  route text not null,
  page integer not null default 1,
  position integer not null default 1,
  owner_organization_id uuid references organizations(id) on delete set null,
  is_enabled boolean not null default true,
  is_system_app boolean not null default false,
  status text not null default 'soon',
  visibility text not null default 'public',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_registry_slug_format check (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])$'),
  constraint app_registry_name_len check (length(trim(name)) between 1 and 40),
  constraint app_registry_route_format check (route ~ '^/[a-zA-Z0-9/_:-]{0,80}$'),
  constraint app_registry_page_check check (page between 1 and 50),
  constraint app_registry_position_check check (position between 1 and 100),
  constraint app_registry_status_check check (status in ('live','soon','maintenance')),
  constraint app_registry_visibility_check check (visibility in ('public','private','restricted')),
  constraint app_registry_accent_check check (accent_color is null or accent_color ~ '^#[0-9a-fA-F]{6}$'),
  constraint app_registry_icon_url_check check (icon_url is null or icon_url ~ '^https?://'),
  constraint app_registry_logo_url_check check (logo_url is null or logo_url ~ '^https?://')
);
comment on table app_registry is
  'Registre dynamique des applications de la tablette Newpad (§7). L''écran d''accueil est généré depuis cette table ; l''admin y déplace/renomme/désactive une application sans modification de code.';

-- Contrainte d'unicité de l'emplacement, DÉFERRABLE : une réorganisation
-- (glisser-déposer) passe forcément par des états intermédiaires où deux
-- applications occupent brièvement le même emplacement. Une contrainte
-- déferrable les autorise à l'intérieur d'une transaction et vérifie seulement
-- à la validation — un index unique classique, lui, rendrait toute
-- réorganisation impossible sans passer par des positions bidon.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_registry_slot_unique') then
    alter table app_registry add constraint app_registry_slot_unique
      unique (page, position) deferrable initially immediate;
  end if;
end $$;
create index if not exists idx_app_registry_enabled on app_registry(is_enabled, page, position);


-- ----------------------------------------------------------------------------
-- updated_at automatique sur les trois nouvelles tables
-- ----------------------------------------------------------------------------
create or replace function _touch_updated_at()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  new.updated_at := now();
  return new;
end;
$function$;

drop trigger if exists trg_app_registry_touch on app_registry;
create trigger trg_app_registry_touch before update on app_registry
  for each row execute function _touch_updated_at();

drop trigger if exists trg_organizations_touch on organizations;
create trigger trg_organizations_touch before update on organizations
  for each row execute function _touch_updated_at();


-- ############################################################################
-- PARTIE C bis — QUI APPARTIENT À QUOI
-- ############################################################################
-- Ces deux questions sont posées par les policies de `organizations`,
-- `organization_members` ET `app_registry`. Elles DOIVENT passer par une
-- fonction `security definer` : une policy sur `organization_members` qui
-- interroge `organization_members` se réapplique à sa propre sous-requête et
-- PostgreSQL s'arrête sur « infinite recursion detected in policy ». La table
-- devient alors illisible, et avec elle tout ce qui la consulte — c'est-à-dire
-- la tablette entière dès qu'une application privée d'entreprise existe.
-- Vérifié en conditions réelles : c'est bien ce qui se produisait.

create or replace function is_org_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from organization_members m
    where m.organization_id = p_org and m.profile_id = auth.uid()
  );
$function$;

create or replace function is_org_manager(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from organization_members m
    where m.organization_id = p_org and m.profile_id = auth.uid()
      and m.member_role in ('owner', 'manager')
  );
$function$;


-- ############################################################################
-- PARTIE D — RLS
-- ############################################################################
-- Même doctrine que tout le reste du projet : lecture par policy, écriture
-- exclusivement par fonction `security definer`. Aucune policy d'insertion,
-- de mise à jour ou de suppression n'est posée sur ces trois tables.

alter table organizations enable row level security;
alter table organization_members enable row level security;
alter table app_registry enable row level security;

-- Organisations : annuaire public à l'intérieur de Newpad (NewPage en dépend).
-- Une organisation fermée reste visible de ses membres et de l'administration.
drop policy if exists organizations_select on organizations;
create policy organizations_select on organizations
  for select to authenticated
  using (
    status <> 'closed'
    or is_newpad_admin()
    or is_staff()
    or is_org_member(organizations.id)
  );

-- Appartenances : visibles des membres de la même organisation, du personnel
-- de la banque et de l'administration. Un joueur ne peut pas cartographier
-- l'ensemble des effectifs de la ville.
drop policy if exists organization_members_select on organization_members;
create policy organization_members_select on organization_members
  for select to authenticated
  using (
    profile_id = auth.uid()
    or is_newpad_admin()
    or is_staff()
    or is_org_member(organization_members.organization_id)
  );

-- Registre des applications : c'est ce que lit l'écran d'accueil de la
-- tablette. Une application désactivée disparaît pour tout le monde sauf
-- l'administration, qui doit pouvoir la réactiver.
drop policy if exists app_registry_select on app_registry;
create policy app_registry_select on app_registry
  for select to authenticated
  using (
    is_newpad_admin()
    or (
      is_enabled
      and (
        visibility = 'public'
        or (owner_organization_id is not null and is_org_member(owner_organization_id))
      )
    )
  );


-- ############################################################################
-- PARTIE E — FONCTIONS D'ADMINISTRATION DU REGISTRE (§8, §10)
-- ############################################################################

-- Renumérote les positions de chaque page en 1..n sans trou, en conservant
-- l'ordre existant. Appelée après toute opération qui peut laisser un trou
-- (suppression, déplacement entre pages).
create or replace function _compact_app_pages()
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  set constraints app_registry_slot_unique deferred;
  with ordered as (
    select id, page, row_number() over (partition by page order by position, created_at) as rn
    from app_registry
  )
  update app_registry a
     set position = o.rn
    from ordered o
   where a.id = o.id and a.position is distinct from o.rn;
end;
$function$;

-- Création / modification d'une application. `p_id` nul = création.
-- Une création sans position explicite se pose à la fin de sa page.
create or replace function newpad_upsert_app(
  p_id uuid,
  p_slug text,
  p_name text,
  p_route text,
  p_short_name text default null,
  p_description text default null,
  p_icon_key text default null,
  p_icon_url text default null,
  p_logo_url text default null,
  p_accent_color text default null,
  p_page integer default 1,
  p_position integer default null,
  p_owner_organization_id uuid default null,
  p_is_enabled boolean default true,
  p_status text default 'soon',
  p_visibility text default 'public'
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
  v_pos integer;
  v_page integer := coalesce(p_page, 1);
begin
  if not is_newpad_admin() then
    raise exception 'Réservé à l''administrateur Newpad';
  end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Le nom est obligatoire'; end if;
  if coalesce(trim(p_route), '') = '' then raise exception 'La route est obligatoire'; end if;

  set constraints app_registry_slot_unique deferred;

  if p_id is null then
    select coalesce(max(position), 0) + 1 into v_pos from app_registry where page = v_page;
    if p_position is not null then
      v_pos := least(greatest(p_position, 1), v_pos);
      update app_registry set position = position + 1 where page = v_page and position >= v_pos;
    end if;

    insert into app_registry (
      slug, name, short_name, description, icon_key, icon_url, logo_url,
      accent_color, route, page, position, owner_organization_id,
      is_enabled, status, visibility
    ) values (
      lower(trim(p_slug)), trim(p_name), nullif(trim(coalesce(p_short_name, '')), ''),
      nullif(trim(coalesce(p_description, '')), ''), nullif(trim(coalesce(p_icon_key, '')), ''),
      nullif(trim(coalesce(p_icon_url, '')), ''), nullif(trim(coalesce(p_logo_url, '')), ''),
      nullif(trim(coalesce(p_accent_color, '')), ''), trim(p_route), v_page, v_pos,
      p_owner_organization_id, coalesce(p_is_enabled, true),
      coalesce(p_status, 'soon'), coalesce(p_visibility, 'public')
    )
    returning id into v_id;

    perform log_audit('newpad_create_app', 'app_registry', v_id,
      jsonb_build_object('slug', p_slug, 'name', p_name, 'route', p_route, 'page', v_page, 'position', v_pos));
  else
    update app_registry set
      slug = lower(trim(p_slug)),
      name = trim(p_name),
      short_name = nullif(trim(coalesce(p_short_name, '')), ''),
      description = nullif(trim(coalesce(p_description, '')), ''),
      icon_key = nullif(trim(coalesce(p_icon_key, '')), ''),
      icon_url = nullif(trim(coalesce(p_icon_url, '')), ''),
      logo_url = nullif(trim(coalesce(p_logo_url, '')), ''),
      accent_color = nullif(trim(coalesce(p_accent_color, '')), ''),
      route = trim(p_route),
      owner_organization_id = p_owner_organization_id,
      is_enabled = coalesce(p_is_enabled, true),
      status = coalesce(p_status, status),
      visibility = coalesce(p_visibility, visibility)
    where id = p_id
    returning id into v_id;

    if v_id is null then raise exception 'Application introuvable'; end if;

    perform log_audit('newpad_update_app', 'app_registry', v_id,
      jsonb_build_object('slug', p_slug, 'name', p_name, 'route', p_route,
                         'is_enabled', p_is_enabled, 'status', p_status, 'visibility', p_visibility));
  end if;

  perform _compact_app_pages();
  return v_id;
end;
$function$;

-- Enregistre une disposition complète après un glisser-déposer.
-- L'interface envoie l'agencement entier ([{id, page, position}]) plutôt qu'un
-- déplacement isolé : c'est ce qu'elle connaît réellement après un glissement,
-- et cela évite toute divergence entre ce que voit l'admin et ce qui est écrit.
create or replace function newpad_set_layout(p_items jsonb)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_count integer;
begin
  if not is_newpad_admin() then
    raise exception 'Réservé à l''administrateur Newpad';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Disposition invalide';
  end if;

  set constraints app_registry_slot_unique deferred;

  with items as (
    select (e->>'id')::uuid as id,
           (e->>'page')::int as page,
           (e->>'position')::int as position
    from jsonb_array_elements(p_items) e
  )
  update app_registry a
     set page = i.page, position = i.position
    from items i
   where a.id = i.id;

  get diagnostics v_count = row_count;

  perform _compact_app_pages();
  perform log_audit('newpad_set_layout', 'app_registry', null,
    jsonb_build_object('applications_deplacees', v_count));
end;
$function$;

create or replace function newpad_delete_app(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_app app_registry%rowtype;
begin
  if not is_newpad_admin() then
    raise exception 'Réservé à l''administrateur Newpad';
  end if;
  select * into v_app from app_registry where id = p_id;
  if v_app.id is null then raise exception 'Application introuvable'; end if;
  if v_app.is_system_app then
    raise exception 'Cette application fait partie du socle Newpad : elle peut être désactivée, pas supprimée.';
  end if;

  delete from app_registry where id = p_id;
  perform _compact_app_pages();
  perform log_audit('newpad_delete_app', 'app_registry', p_id,
    jsonb_build_object('slug', v_app.slug, 'name', v_app.name));
end;
$function$;


-- ############################################################################
-- PARTIE F — FONCTIONS ORGANISATIONS
-- ############################################################################

create or replace function newpad_upsert_organization(
  p_id uuid,
  p_name text,
  p_slug text,
  p_kind text default 'company',
  p_description text default null,
  p_logo_url text default null,
  p_owner_id uuid default null,
  p_contact_email text default null,
  p_contact_phone text default null,
  p_location text default null,
  p_status text default 'active'
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;

  if not (is_newpad_admin() or (p_id is not null and is_org_manager(p_id))) then
    raise exception 'Réservé à l''administration Newpad ou à la direction de l''organisation';
  end if;

  if p_id is null then
    insert into organizations (name, slug, kind, description, logo_url, owner_id,
                               contact_email, contact_phone, location, status)
    values (trim(p_name), lower(trim(p_slug)), coalesce(p_kind, 'company'),
            nullif(trim(coalesce(p_description, '')), ''), nullif(trim(coalesce(p_logo_url, '')), ''),
            coalesce(p_owner_id, auth.uid()), nullif(trim(coalesce(p_contact_email, '')), ''),
            nullif(trim(coalesce(p_contact_phone, '')), ''), nullif(trim(coalesce(p_location, '')), ''),
            coalesce(p_status, 'active'))
    returning id into v_id;

    insert into organization_members (organization_id, profile_id, member_role)
    values (v_id, coalesce(p_owner_id, auth.uid()), 'owner')
    on conflict (organization_id, profile_id) do nothing;

    perform log_audit('newpad_create_organization', 'organizations', v_id,
      jsonb_build_object('name', p_name, 'kind', p_kind));
  else
    update organizations set
      name = trim(p_name),
      slug = lower(trim(p_slug)),
      kind = coalesce(p_kind, kind),
      description = nullif(trim(coalesce(p_description, '')), ''),
      logo_url = nullif(trim(coalesce(p_logo_url, '')), ''),
      owner_id = coalesce(p_owner_id, owner_id),
      contact_email = nullif(trim(coalesce(p_contact_email, '')), ''),
      contact_phone = nullif(trim(coalesce(p_contact_phone, '')), ''),
      location = nullif(trim(coalesce(p_location, '')), ''),
      status = case when is_newpad_admin() then coalesce(p_status, status) else status end
    where id = p_id
    returning id into v_id;

    if v_id is null then raise exception 'Organisation introuvable'; end if;
    perform log_audit('newpad_update_organization', 'organizations', v_id,
      jsonb_build_object('name', p_name));
  end if;

  return v_id;
end;
$function$;

create or replace function newpad_set_org_member(
  p_organization_id uuid,
  p_profile_id uuid,
  p_member_role text default 'member',
  p_grade_label text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  if not (is_newpad_admin() or is_org_manager(p_organization_id)) then
    raise exception 'Réservé à la direction de l''organisation';
  end if;
  if p_member_role not in ('owner', 'manager', 'member') then
    raise exception 'Rôle invalide';
  end if;
  if not exists (select 1 from profiles where id = p_profile_id) then
    raise exception 'Profil introuvable';
  end if;

  insert into organization_members (organization_id, profile_id, member_role, grade_label)
  values (p_organization_id, p_profile_id, p_member_role, nullif(trim(coalesce(p_grade_label, '')), ''))
  on conflict (organization_id, profile_id)
  do update set member_role = excluded.member_role, grade_label = excluded.grade_label;

  perform log_audit('newpad_set_org_member', 'organization_members', p_organization_id,
    jsonb_build_object('profile_id', p_profile_id, 'member_role', p_member_role));
end;
$function$;

create or replace function newpad_remove_org_member(p_organization_id uuid, p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_remaining integer;
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  if not (is_newpad_admin() or is_org_manager(p_organization_id)) then
    raise exception 'Réservé à la direction de l''organisation';
  end if;

  -- Une organisation sans propriétaire ne serait plus administrable par
  -- personne d'autre que l'admin global : on refuse de retirer le dernier.
  select count(*) into v_remaining
  from organization_members
  where organization_id = p_organization_id and member_role = 'owner' and profile_id <> p_profile_id;

  if v_remaining = 0 and exists (
    select 1 from organization_members
    where organization_id = p_organization_id and profile_id = p_profile_id and member_role = 'owner'
  ) then
    raise exception 'Impossible de retirer le dernier propriétaire de l''organisation';
  end if;

  delete from organization_members
  where organization_id = p_organization_id and profile_id = p_profile_id;

  perform log_audit('newpad_remove_org_member', 'organization_members', p_organization_id,
    jsonb_build_object('profile_id', p_profile_id));
end;
$function$;


-- ############################################################################
-- PARTIE G — AMORÇAGE DES 23 APPLICATIONS (§6)
-- ############################################################################
-- Dix par page (§4), donc trois pages. `status = 'soon'` pour tout ce qui n'est
-- pas encore construit : l'icône est visible et cliquable, elle mène à un écran
-- qui annonce l'application au lieu d'un bouton mort (§95).

insert into app_registry (slug, name, short_name, description, icon_key, accent_color, route, page, position, is_system_app, status)
values
  ('bank',      'Newman Bank',          'Bank',       'Banque privée de la ville',                  'bank',       '#c9a227', '/bank',      1,  1, true,  'live'),
  ('news',      'News24',               'News24',     'Le média de la ville',                       'news',       '#e05a4a', '/news',      1,  2, false, 'soon'),
  ('youtube',   'NewTube',              'NewTube',    'Plateforme vidéo',                           'video',      '#d94f4f', '/youtube',   1,  3, false, 'soon'),
  ('page',      'NewPage',              'NewPage',    'Annuaire des entreprises',                   'directory',  '#4a7fd9', '/page',      1,  4, false, 'soon'),
  ('market',    'NewMarket',            'NewMarket',  'Petites annonces',                           'market',     '#3fa08a', '/market',    1,  5, false, 'soon'),
  ('pro',       'NewPro',               'NewPro',     'Back-office entreprise',                     'briefcase',  '#5b6ec4', '/pro',       1,  6, false, 'soon'),
  ('work',      'NewWork',              'NewWork',    'Réseau professionnel et emploi',             'work',       '#3f7fb8', '/work',      1,  7, false, 'soon'),
  ('mail',      'NewMail',              'NewMail',    'Messagerie',                                 'mail',       '#c9a227', '/mail',      1,  8, false, 'soon'),
  ('life',      'NewLife',              'NewLife',    'Réseau social',                              'social',     '#c25fa0', '/life',      1,  9, false, 'soon'),
  ('league',    'NewLeague',            'NewLeague',  'Compétitions',                               'trophy',     '#d18f2e', '/league',    1, 10, false, 'soon'),

  ('dark',      'NewDark',              'NewDark',    'Espace clandestin',                          'mask',       '#8e2b2b', '/dark',      2,  1, false, 'soon'),
  ('events',    'NewEvent',             'NewEvent',   'Agenda des événements',                      'calendar',   '#b8763f', '/events',    2,  2, false, 'soon'),
  ('gov',       'NewGov',               'NewGov',     'Portail gouvernemental',                     'government', '#3f5f9e', '/gov',       2,  3, false, 'soon'),
  ('ads',       'NewAds',               'NewAds',     'Régie publicitaire',                         'megaphone',  '#d97b2e', '/ads',       2,  4, false, 'soon'),
  ('dynasty',   'Dynasty',              'Dynasty',    'Immobilier de prestige',                     'home',       '#a58a4e', '/dynasty',   2,  5, false, 'soon'),
  ('luxury',    'Concess Luxury',       'Luxury',     'Concession automobile',                      'car',        '#8f8f9c', '/luxury',    2,  6, false, 'soon'),
  ('vangelico', 'Bijouterie Vangelico', 'Vangelico',  'Joaillerie',                                 'gem',        '#c9a227', '/vangelico', 2,  7, false, 'soon'),
  ('doc',       'NewDoc',               'NewDoc',     'Portail médical',                            'medical',    '#3fa0a0', '/doc',       2,  8, false, 'soon'),
  ('files',     'NewFiles',             'NewFiles',   'Coffre documentaire',                        'folder',     '#5f7fa8', '/files',     2,  9, true,  'soon'),
  ('sacem',     'SACEM',                'SACEM',      'Industrie musicale',                         'music',      '#9b5fc4', '/sacem',     2, 10, false, 'soon'),

  ('ai',        'NEW AI',               'NEW AI',     'Assistant intelligent',                      'ai',         '#7b5fd9', '/ai',        3,  1, false, 'soon'),
  ('insurance', 'NewInsurance',         'Insurance',  'Assurances',                                 'shield',     '#2e7f8f', '/insurance', 3,  2, false, 'soon'),
  ('create-app','Créer votre App',      'Créer',      'Demander une application pour votre entreprise', 'plus',   '#8b93ab', '/create-app',3,  3, true,  'soon')
on conflict (slug) do nothing;


-- ############################################################################
-- PARTIE H — STOCKAGE DES ICÔNES ET LOGOS (§9)
-- ############################################################################

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('newpad-app-icons', 'newpad-app-icons', true, 2097152,
        array['image/png', 'image/webp', 'image/svg+xml', 'image/jpeg'])
on conflict (id) do update
  set public = true,
      file_size_limit = 2097152,
      allowed_mime_types = array['image/png', 'image/webp', 'image/svg+xml', 'image/jpeg'];

drop policy if exists newpad_icons_public_read on storage.objects;
create policy newpad_icons_public_read on storage.objects
  for select using (bucket_id = 'newpad-app-icons');

drop policy if exists newpad_icons_admin_write on storage.objects;
create policy newpad_icons_admin_write on storage.objects
  for insert to authenticated
  with check (bucket_id = 'newpad-app-icons' and is_newpad_admin());

drop policy if exists newpad_icons_admin_update on storage.objects;
create policy newpad_icons_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'newpad-app-icons' and is_newpad_admin())
  with check (bucket_id = 'newpad-app-icons' and is_newpad_admin());

drop policy if exists newpad_icons_admin_delete on storage.objects;
create policy newpad_icons_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'newpad-app-icons' and is_newpad_admin());


-- ############################################################################
-- PARTIE I — TEMPS RÉEL (§9, §79)
-- ############################################################################
-- Un changement d'icône, de nom ou de position doit apparaître immédiatement
-- sur la tablette de chaque joueur connecté, sans rechargement.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'app_registry'
  ) then
    alter publication supabase_realtime add table app_registry;
  end if;
end $$;


-- ############################################################################
-- PARTIE J — PERMISSIONS (règle de balayage, voir 0038/0039)
-- ############################################################################

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

-- ############################################################################
-- 0045 — NIVEAUX D'ACCÈS AUX APPLICATIONS
-- ############################################################################
-- Trois niveaux, portés par le registre plutôt que codés en dur — pour la même
-- raison que tout le reste : l'admin doit pouvoir déplacer une application d'un
-- niveau à l'autre sans déploiement.
--
--   guest      — ouverte à tous, y compris sans compte. Ce sont les
--                applications qui ont besoin d'une AUDIENCE pour exister :
--                un média sans lecteurs, une plateforme vidéo sans spectateurs,
--                un réseau social sans passants ne fonctionnent pas. La vitrine
--                de la banque en fait partie, sans quoi personne ne pourrait
--                demander à devenir client.
--   client     — réservée aux clients de Newman Bank (et au personnel).
--   restricted — accordée nommément, une personne à la fois, par
--                l'administration. C'est le régime de NewDark.
-- ############################################################################

alter table app_registry add column if not exists access_level text not null default 'client';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_registry_access_level_check') then
    alter table app_registry add constraint app_registry_access_level_check
      check (access_level in ('guest', 'client', 'restricted'));
  end if;
end $$;

comment on column app_registry.access_level is
  'guest = ouverte à tous (applications à audience) ; client = client Newman Bank ; restricted = autorisation nominative.';

update app_registry set access_level = 'guest'
  where slug in ('bank', 'news', 'youtube', 'life', 'page', 'events');
update app_registry set access_level = 'restricted' where slug = 'dark';

-- ----------------------------------------------------------------------------
-- Autorisations nominatives (NewDark et toute application restreinte à venir)
-- ----------------------------------------------------------------------------
create table if not exists app_access_grants (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references app_registry(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  granted_by uuid references profiles(id) on delete set null,
  note text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  unique (app_id, profile_id)
);
comment on table app_access_grants is
  'Autorisation nominative d''accès à une application restreinte. Sans ligne ici, l''icône n''apparaît pas et la route est refusée.';

create index if not exists idx_app_grants_profile on app_access_grants(profile_id);

alter table app_access_grants enable row level security;

-- Un joueur voit ses propres autorisations — savoir à quoi on a droit fait
-- partie du minimum. Il ne voit pas celles des autres : la liste des personnes
-- admises dans un espace clandestin est précisément ce qui doit rester secret.
drop policy if exists app_access_grants_select on app_access_grants;
create policy app_access_grants_select on app_access_grants
  for select to authenticated
  using (profile_id = auth.uid() or is_newpad_admin());

-- ----------------------------------------------------------------------------
-- La question unique : ai-je le droit d'ouvrir cette application ?
-- ----------------------------------------------------------------------------
-- Posée au même endroit pour l'écran d'accueil (quelles icônes afficher) et
-- pour le routeur (laisser entrer ou non). Deux réponses écrites séparément
-- finiraient par diverger, et c'est toujours l'affichage qui gagnerait —
-- c'est-à-dire la version qui ne protège rien.
create or replace function can_open_app(p_slug text)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_app app_registry%rowtype;
  v_role user_role;
  v_statut text;
begin
  select * into v_app from app_registry where slug = p_slug;
  if v_app.id is null or not v_app.is_enabled then return false; end if;

  if v_app.access_level = 'guest' then return true; end if;

  if auth.uid() is null then return false; end if;
  select role, status into v_role, v_statut from profiles where id = auth.uid();
  if v_statut is distinct from 'active' then return false; end if;

  if is_newpad_admin() then return true; end if;

  if v_app.access_level = 'restricted' then
    return exists (
      select 1 from app_access_grants g
      where g.app_id = v_app.id and g.profile_id = auth.uid()
        and (g.expires_at is null or g.expires_at > now())
    );
  end if;

  -- Niveau « client » : être client de Newman Bank, ou faire partie de son
  -- personnel. Un prospect dont la demande d'adhésion est encore à l'étude n'y
  -- a pas encore droit — c'est exactement ce que l'adhésion sert à ouvrir.
  return v_role in ('client', 'employee', 'admin', 'irs');
end;
$function$;

-- ----------------------------------------------------------------------------
-- Mode invité : lecture du registre sans session
-- ----------------------------------------------------------------------------
-- Un visiteur sans compte doit voir la tablette et ses applications ouvertes.
-- Il ne voit RIEN d'autre : la policy ne laisse passer que les applications de
-- niveau invité, actives et publiques.
drop policy if exists app_registry_select_guest on app_registry;
create policy app_registry_select_guest on app_registry
  for select to anon
  using (is_enabled and visibility = 'public' and access_level = 'guest');

-- ----------------------------------------------------------------------------
-- Le niveau « client » et le niveau « restricted » ne se cachent pas de la même
-- façon, et la différence est délibérée :
--
--   client     — l'icône RESTE visible, verrouillée. C'est une invitation à
--                devenir client de Newman Bank ; la masquer priverait la
--                tablette de la moitié de son contenu pour un nouveau joueur,
--                et lui cacherait ce qu'il gagne à ouvrir un compte.
--   restricted — l'icône DISPARAÎT. Pour NewDark, l'existence même de l'accès
--                fait partie de ce qui est restreint : une icône cadenassée
--                annoncerait à toute la ville qu'un espace clandestin existe
--                et que d'autres y sont admis.
-- ----------------------------------------------------------------------------
drop policy if exists app_registry_select on app_registry;
create policy app_registry_select on app_registry
  for select to authenticated
  using (
    is_newpad_admin()
    or (
      is_enabled
      and (access_level <> 'restricted' or can_open_app(slug))
      and (
        visibility = 'public'
        or (owner_organization_id is not null and is_org_member(owner_organization_id))
      )
    )
  );

-- ----------------------------------------------------------------------------
-- Administration des autorisations nominatives
-- ----------------------------------------------------------------------------
create or replace function newpad_grant_app_access(
  p_app_id uuid,
  p_profile_id uuid,
  p_note text default null,
  p_expires_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_nom text;
begin
  if not is_newpad_admin() then raise exception 'Réservé à l''administrateur Newpad'; end if;
  if not exists (select 1 from profiles where id = p_profile_id) then
    raise exception 'Profil introuvable';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'La date d''expiration doit être dans le futur';
  end if;

  insert into app_access_grants (app_id, profile_id, granted_by, note, expires_at)
  values (p_app_id, p_profile_id, auth.uid(), nullif(trim(coalesce(p_note, '')), ''), p_expires_at)
  on conflict (app_id, profile_id)
  do update set note = excluded.note, expires_at = excluded.expires_at, granted_by = excluded.granted_by;

  select name into v_nom from app_registry where id = p_app_id;
  perform notify(p_profile_id, 'app_access', 'Accès accordé',
    'Vous avez désormais accès à ' || coalesce(v_nom, 'une application') || '.', '/');
  perform log_audit('newpad_grant_app_access', 'app_access_grants', p_app_id,
    jsonb_build_object('profile_id', p_profile_id, 'application', v_nom));
end;
$function$;

create or replace function newpad_revoke_app_access(p_app_id uuid, p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_newpad_admin() then raise exception 'Réservé à l''administrateur Newpad'; end if;
  delete from app_access_grants where app_id = p_app_id and profile_id = p_profile_id;
  perform log_audit('newpad_revoke_app_access', 'app_access_grants', p_app_id,
    jsonb_build_object('profile_id', p_profile_id));
end;
$function$;

-- Liste des personnes autorisées sur une application, avec leur nom.
-- Réservée à l'administration : le nom des membres d'un espace restreint ne
-- doit pas être lisible par les autres membres.
create or replace function newpad_list_app_access(p_app_id uuid)
returns table (profile_id uuid, username text, display_name text, note text, expires_at timestamptz, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_newpad_admin() then raise exception 'Réservé à l''administrateur Newpad'; end if;
  return query
    select g.profile_id, p.username, p.display_name, g.note, g.expires_at, g.created_at
    from app_access_grants g
    join profiles p on p.id = g.profile_id
    where g.app_id = p_app_id
    order by p.display_name;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Le registre expose le niveau d'accès à l'administration
-- ----------------------------------------------------------------------------
drop function if exists newpad_upsert_app(uuid, text, text, text, text, text, text, text, text, text, integer, integer, uuid, boolean, text, text, text);

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
  p_visibility text default 'public',
  p_admin_route text default null,
  p_access_level text default 'client'
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
      accent_color, route, admin_route, page, position, owner_organization_id,
      is_enabled, status, visibility, access_level
    ) values (
      lower(trim(p_slug)), trim(p_name), nullif(trim(coalesce(p_short_name, '')), ''),
      nullif(trim(coalesce(p_description, '')), ''), nullif(trim(coalesce(p_icon_key, '')), ''),
      nullif(trim(coalesce(p_icon_url, '')), ''), nullif(trim(coalesce(p_logo_url, '')), ''),
      nullif(trim(coalesce(p_accent_color, '')), ''), trim(p_route),
      nullif(trim(coalesce(p_admin_route, '')), ''), v_page, v_pos,
      p_owner_organization_id, coalesce(p_is_enabled, true),
      coalesce(p_status, 'soon'), coalesce(p_visibility, 'public'),
      coalesce(p_access_level, 'client')
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
      admin_route = nullif(trim(coalesce(p_admin_route, '')), ''),
      owner_organization_id = p_owner_organization_id,
      is_enabled = coalesce(p_is_enabled, true),
      status = coalesce(p_status, status),
      visibility = coalesce(p_visibility, visibility),
      access_level = coalesce(p_access_level, access_level)
    where id = p_id
    returning id into v_id;

    if v_id is null then raise exception 'Application introuvable'; end if;

    perform log_audit('newpad_update_app', 'app_registry', v_id,
      jsonb_build_object('slug', p_slug, 'name', p_name, 'route', p_route,
                         'access_level', p_access_level, 'is_enabled', p_is_enabled,
                         'status', p_status, 'visibility', p_visibility));
  end if;

  perform _compact_app_pages();
  return v_id;
end;
$function$;

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
-- Le mode invité interroge lui aussi ses droits : sans ce grant, un visiteur
-- sans compte ne pourrait pas savoir qu'il a le droit d'ouvrir NewTube.
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

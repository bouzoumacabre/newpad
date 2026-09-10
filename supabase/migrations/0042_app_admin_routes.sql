-- ############################################################################
-- 0042 — CHAQUE APPLICATION DÉCLARE SON PROPRE ESPACE D'ADMINISTRATION
-- ############################################################################
-- La console d'administration générale (§84) ne doit pas contenir une liste
-- d'applications codée en dur : ce serait exactement le défaut que le registre
-- dynamique existe pour éviter. Chaque application déclare donc elle-même la
-- route de son back-office, et la console se contente de lire le registre.
-- ############################################################################

alter table app_registry add column if not exists admin_route text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_registry_admin_route_check') then
    alter table app_registry add constraint app_registry_admin_route_check
      check (admin_route is null or admin_route ~ '^/[a-zA-Z0-9/_:-]{0,80}$');
  end if;
end $$;

comment on column app_registry.admin_route is
  'Route du back-office de cette application, s''il existe. La console d''administration générale est générée à partir de cette colonne.';

update app_registry set admin_route = '/admin' where slug = 'bank' and admin_route is null;

-- Remplacement de la fonction : un `create or replace` avec un paramètre de
-- plus créerait une SURCHARGE, pas un remplacement, et PostgREST ne saurait
-- plus laquelle appeler.
drop function if exists newpad_upsert_app(uuid, text, text, text, text, text, text, text, text, text, integer, integer, uuid, boolean, text, text);

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
  p_admin_route text default null
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
      is_enabled, status, visibility
    ) values (
      lower(trim(p_slug)), trim(p_name), nullif(trim(coalesce(p_short_name, '')), ''),
      nullif(trim(coalesce(p_description, '')), ''), nullif(trim(coalesce(p_icon_key, '')), ''),
      nullif(trim(coalesce(p_icon_url, '')), ''), nullif(trim(coalesce(p_logo_url, '')), ''),
      nullif(trim(coalesce(p_accent_color, '')), ''), trim(p_route),
      nullif(trim(coalesce(p_admin_route, '')), ''), v_page, v_pos,
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
      admin_route = nullif(trim(coalesce(p_admin_route, '')), ''),
      owner_organization_id = p_owner_organization_id,
      is_enabled = coalesce(p_is_enabled, true),
      status = coalesce(p_status, status),
      visibility = coalesce(p_visibility, visibility)
    where id = p_id
    returning id into v_id;

    if v_id is null then raise exception 'Application introuvable'; end if;

    perform log_audit('newpad_update_app', 'app_registry', v_id,
      jsonb_build_object('slug', p_slug, 'name', p_name, 'route', p_route,
                         'admin_route', p_admin_route, 'is_enabled', p_is_enabled,
                         'status', p_status, 'visibility', p_visibility));
  end if;

  perform _compact_app_pages();
  return v_id;
end;
$function$;


-- Permissions (règle de balayage, voir 0038/0039).
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

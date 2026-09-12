-- ############################################################################
-- 0053 — LE SOCLE DES VITRINES : Dynasty, Concess Luxury, Vangelico
-- ############################################################################
-- Trois applications au cahier des charges, un seul moteur. Une agence
-- immobilière de prestige, une concession automobile et une joaillerie font
-- exactement la même chose : une organisation expose un catalogue, un client
-- demande une visite, un essai ou une estimation, l'entreprise répond et fixe
-- un rendez-vous. Ce qui change tient dans le vocabulaire et les catégories.
--
-- Écrire trois fois la même table aurait coûté trois fois la maintenance et,
-- surtout, aurait interdit ce qui suit : `app_registry.is_showcase`. Un
-- administrateur peut transformer n'importe quelle application du registre en
-- vitrine, lui donner ses propres catégories depuis l'administration, et
-- Concess Luxury a un petit frère sans une ligne de code (§7, Principe 1).
--
-- §90 : aucun mouvement de fonds. Le prix est affiché, le rendez-vous est pris,
-- et l'affaire se conclut en jeu — par Newman Bank s'il faut virer l'argent.
-- ############################################################################

alter table app_registry add column if not exists is_showcase boolean not null default false;

-- ----------------------------------------------------------------------------
-- Catégories, par vitrine et modifiables depuis l'administration : une villa
-- n'est pas une berline, et la liste n'a rien à faire dans le code.
-- ----------------------------------------------------------------------------
create table if not exists catalog_subtypes (
  app_slug text not null references app_registry(slug) on update cascade on delete cascade,
  code text not null,
  label text not null,
  sort_order int not null default 10,
  primary key (app_slug, code),
  constraint catalog_subtype_code_format check (code ~ '^[a-z0-9]([a-z0-9_-]{0,28}[a-z0-9])$'),
  constraint catalog_subtype_label_len check (length(trim(label)) between 1 and 40)
);

alter table catalog_subtypes enable row level security;

drop policy if exists catalog_subtypes_select on catalog_subtypes;
create policy catalog_subtypes_select on catalog_subtypes
  for select to authenticated using (true);

-- ----------------------------------------------------------------------------
-- Le catalogue
-- ----------------------------------------------------------------------------
create table if not exists catalog_items (
  id uuid primary key default gen_random_uuid(),
  app_slug text not null references app_registry(slug) on update cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  created_by uuid not null references profiles(id) on delete cascade,
  title text not null,
  description text not null,
  subtype text,
  price numeric(14,2),
  price_label text,
  location text,
  photos text[] not null default '{}',
  -- Caractéristiques libres : m², chevaux, carats. Chaque vitrine a les
  -- siennes, aucune colonne ne peut les prévoir toutes.
  specs jsonb not null default '{}'::jsonb,
  status text not null default 'available',
  is_featured boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_title_len check (length(trim(title)) between 3 and 140),
  constraint catalog_desc_len check (length(description) between 1 and 8000),
  constraint catalog_price_check check (price is null or (price >= 0 and price <= 100000000000)),
  constraint catalog_price_label_len check (price_label is null or length(price_label) <= 40),
  constraint catalog_location_len check (location is null or length(location) <= 120),
  constraint catalog_photos_len check (array_length(photos, 1) is null or array_length(photos, 1) <= 10),
  constraint catalog_specs_object check (jsonb_typeof(specs) = 'object'),
  constraint catalog_specs_size check (length(specs::text) <= 4000),
  constraint catalog_status_check check (status in ('draft','available','reserved','sold','archived'))
);

create index if not exists idx_catalog_vitrine on catalog_items(app_slug, status, is_featured desc, created_at desc);
create index if not exists idx_catalog_org on catalog_items(organization_id, created_at desc);

drop trigger if exists trg_catalog_touch on catalog_items;
create trigger trg_catalog_touch before update on catalog_items
  for each row execute function _touch_updated_at();

alter table catalog_items enable row level security;

drop policy if exists catalog_select_public on catalog_items;
create policy catalog_select_public on catalog_items
  for select to authenticated using (status in ('available','reserved','sold'));

drop policy if exists catalog_select_org on catalog_items;
create policy catalog_select_org on catalog_items
  for select to authenticated using (is_org_member(organization_id));

-- ----------------------------------------------------------------------------
-- Les demandes : visite, essai, estimation. Un rendez-vous, pas une commande.
-- ----------------------------------------------------------------------------
create table if not exists catalog_requests (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references catalog_items(id) on delete cascade,
  requester_id uuid not null references profiles(id) on delete cascade,
  kind text not null default 'visit',
  message text,
  preferred_at timestamptz,
  scheduled_at timestamptz,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint catalog_req_kind check (kind in ('visit','test','info','reserve','estimate')),
  constraint catalog_req_status check (status in ('pending','accepted','declined','done','cancelled')),
  constraint catalog_req_msg_len check (message is null or length(message) <= 1000)
);

create index if not exists idx_catalog_req_item on catalog_requests(item_id, created_at desc);
create index if not exists idx_catalog_req_user on catalog_requests(requester_id, created_at desc);

alter table catalog_requests enable row level security;

-- Fonction citée par une policy : sans préfixe interne (leçon de 0043).
create or replace function catalog_item_org(p_item_id uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select organization_id from catalog_items where id = p_item_id;
$function$;

drop policy if exists catalog_requests_select on catalog_requests;
create policy catalog_requests_select on catalog_requests
  for select to authenticated
  using (requester_id = auth.uid() or is_org_member(catalog_item_org(item_id)));

-- ----------------------------------------------------------------------------
-- Administration des vitrines et de leurs catégories
-- ----------------------------------------------------------------------------
create or replace function catalog_set_showcase(p_app_slug text, p_is_showcase boolean)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_newpad_admin() then raise exception 'Réservé à l''administrateur Newpad'; end if;
  update app_registry set is_showcase = coalesce(p_is_showcase, false) where slug = p_app_slug;
  if not found then raise exception 'Application introuvable'; end if;
end;
$function$;

create or replace function catalog_upsert_subtype(
  p_app_slug text, p_code text, p_label text, p_sort_order int default 10
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_newpad_admin() then raise exception 'Réservé à l''administrateur Newpad'; end if;
  insert into catalog_subtypes (app_slug, code, label, sort_order)
  values (p_app_slug, lower(trim(p_code)), trim(p_label), coalesce(p_sort_order, 10))
  on conflict (app_slug, code) do update
    set label = excluded.label, sort_order = excluded.sort_order;
end;
$function$;

create or replace function catalog_delete_subtype(p_app_slug text, p_code text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_newpad_admin() then raise exception 'Réservé à l''administrateur Newpad'; end if;
  delete from catalog_subtypes where app_slug = p_app_slug and code = p_code;
end;
$function$;

create or replace function catalog_subtypes_list(p_app_slug text)
returns table (code text, label text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select code, label from catalog_subtypes
   where app_slug = p_app_slug
   order by sort_order, label;
$function$;

-- ----------------------------------------------------------------------------
-- Le catalogue — écritures (réservées aux membres de l'entreprise)
-- ----------------------------------------------------------------------------
create or replace function catalog_save_item(
  p_app_slug text, p_organization_id uuid, p_title text, p_description text,
  p_id uuid default null, p_subtype text default null,
  p_price numeric default null, p_price_label text default null,
  p_location text default null, p_photos text[] default null,
  p_specs jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_org uuid; v_vitrine boolean;
begin
  perform require_active_profile();

  select is_showcase into v_vitrine from app_registry where slug = p_app_slug;
  if v_vitrine is null then raise exception 'Application introuvable'; end if;
  if not v_vitrine then raise exception 'Cette application n''est pas une vitrine'; end if;

  if not is_org_member(p_organization_id) then
    raise exception 'Vous ne faites pas partie de cette entreprise';
  end if;

  if p_subtype is not null and p_subtype <> ''
     and not exists (select 1 from catalog_subtypes
                      where app_slug = p_app_slug and code = p_subtype) then
    raise exception 'Catégorie inconnue pour cette vitrine';
  end if;

  if p_id is null then
    insert into catalog_items (app_slug, organization_id, created_by, title, description,
                               subtype, price, price_label, location, photos, specs)
    values (p_app_slug, p_organization_id, auth.uid(), trim(p_title), p_description,
            nullif(trim(coalesce(p_subtype, '')), ''), p_price,
            nullif(trim(coalesce(p_price_label, '')), ''),
            nullif(trim(coalesce(p_location, '')), ''),
            coalesce(p_photos, '{}'), coalesce(p_specs, '{}'::jsonb))
    returning id into v_id;
  else
    select organization_id into v_org from catalog_items where id = p_id;
    if v_org is null then raise exception 'Fiche introuvable'; end if;
    -- On vérifie l'appartenance à l'entreprise PROPRIÉTAIRE de la fiche, pas à
    -- celle envoyée par le client : sinon il suffirait de désigner la sienne.
    if not is_org_member(v_org) then raise exception 'Cette fiche n''est pas la vôtre'; end if;

    update catalog_items set
      title = trim(p_title),
      description = p_description,
      subtype = nullif(trim(coalesce(p_subtype, '')), ''),
      price = p_price,
      price_label = nullif(trim(coalesce(p_price_label, '')), ''),
      location = nullif(trim(coalesce(p_location, '')), ''),
      photos = coalesce(p_photos, photos),
      specs = coalesce(p_specs, specs)
    where id = p_id
    returning id into v_id;
  end if;
  return v_id;
end;
$function$;

create or replace function catalog_set_status(
  p_id uuid, p_status text, p_featured boolean default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_org uuid;
begin
  perform require_active_profile();
  if p_status not in ('draft','available','reserved','sold','archived') then
    raise exception 'Statut invalide';
  end if;
  select organization_id into v_org from catalog_items where id = p_id;
  if v_org is null then raise exception 'Fiche introuvable'; end if;
  if not is_org_member(v_org) and not is_newpad_admin() then
    raise exception 'Cette fiche n''est pas la vôtre';
  end if;
  -- La mise en avant d'une fiche dans la vitrine relève de la direction de
  -- l'entreprise, pas de n'importe quel vendeur.
  if p_featured is not null and not is_org_manager(v_org) and not is_newpad_admin() then
    raise exception 'La mise en avant relève de la direction';
  end if;

  update catalog_items
     set status = p_status,
         is_featured = coalesce(p_featured, is_featured)
   where id = p_id;

  if p_status in ('sold','archived') then
    update catalog_requests set status = 'cancelled', decided_at = now()
     where item_id = p_id and status = 'pending';
  end if;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Le catalogue — lectures
-- ----------------------------------------------------------------------------
create or replace function catalog_feed(
  p_app_slug text, p_subtype text default null, p_search text default null,
  p_organization_id uuid default null, p_limit int default 40
)
returns table (id uuid, title text, subtype text, subtype_label text, price numeric,
               price_label text, location text, photo text, status text, is_featured boolean,
               organization_id uuid, org_name text, specs jsonb, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  return query
    select i.id, i.title, i.subtype, s.label, i.price, i.price_label, i.location,
           case when array_length(i.photos, 1) is null then null else i.photos[1] end,
           i.status, i.is_featured, i.organization_id, o.name, i.specs, i.created_at
    from catalog_items i
    join organizations o on o.id = i.organization_id
    left join catalog_subtypes s on s.app_slug = i.app_slug and s.code = i.subtype
    where i.app_slug = p_app_slug
      and i.status in ('available','reserved')
      and (p_subtype is null or p_subtype = '' or i.subtype = p_subtype)
      and (p_organization_id is null or i.organization_id = p_organization_id)
      and (p_search is null or trim(p_search) = ''
           or i.title ilike '%' || trim(p_search) || '%'
           or i.description ilike '%' || trim(p_search) || '%')
    order by i.is_featured desc, i.created_at desc
    limit least(coalesce(p_limit, 40), 100);
end;
$function$;

create or replace function catalog_item(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_res jsonb;
begin
  select jsonb_build_object(
    'id', i.id, 'app_slug', i.app_slug, 'title', i.title, 'description', i.description,
    'subtype', i.subtype, 'subtype_label', s.label, 'price', i.price,
    'price_label', i.price_label, 'location', i.location, 'photos', i.photos,
    'specs', i.specs, 'status', i.status, 'is_featured', i.is_featured,
    'organization_id', i.organization_id, 'org_name', o.name,
    'org_phone', o.contact_phone, 'created_at', i.created_at,
    'can_edit', is_org_member(i.organization_id),
    'my_request', (select jsonb_build_object('id', r.id, 'status', r.status, 'kind', r.kind,
                                             'scheduled_at', r.scheduled_at)
                     from catalog_requests r
                    where r.item_id = i.id and r.requester_id = auth.uid()
                    order by r.created_at desc limit 1)
  ) into v_res
  from catalog_items i
  join organizations o on o.id = i.organization_id
  left join catalog_subtypes s on s.app_slug = i.app_slug and s.code = i.subtype
  where i.id = p_id
    and (i.status in ('available','reserved','sold') or is_org_member(i.organization_id));

  if v_res is null then raise exception 'Fiche introuvable'; end if;
  return v_res;
end;
$function$;

-- Les enseignes présentes dans une vitrine : une concession n'est pas seule au
-- monde, et le client doit pouvoir filtrer par maison.
create or replace function catalog_houses(p_app_slug text)
returns table (organization_id uuid, name text, logo_url text, nb bigint)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select o.id, o.name, o.logo_url, count(i.id)
  from catalog_items i
  join organizations o on o.id = i.organization_id
  where i.app_slug = p_app_slug and i.status in ('available','reserved')
  group by o.id, o.name, o.logo_url
  order by count(i.id) desc, o.name;
$function$;

create or replace function catalog_org_items(p_app_slug text, p_organization_id uuid)
returns table (id uuid, title text, subtype text, price numeric, status text,
               is_featured boolean, requests_pending bigint, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_org_member(p_organization_id) then
    raise exception 'Réservé à l''entreprise';
  end if;
  return query
    select i.id, i.title, i.subtype, i.price, i.status, i.is_featured,
           (select count(*) from catalog_requests r
             where r.item_id = i.id and r.status = 'pending'),
           i.created_at
    from catalog_items i
    where i.app_slug = p_app_slug and i.organization_id = p_organization_id
    order by i.created_at desc
    limit 300;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Les demandes
-- ----------------------------------------------------------------------------
create or replace function catalog_request(
  p_item_id uuid, p_kind text default 'visit',
  p_message text default null, p_preferred_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_item record; v_nom text; v_membre record; v_route text;
begin
  perform require_active_profile();
  if p_kind not in ('visit','test','info','reserve','estimate') then
    raise exception 'Type de demande invalide';
  end if;

  select i.id, i.title, i.status, i.organization_id, i.app_slug into v_item
    from catalog_items i where i.id = p_item_id;
  if v_item.id is null then raise exception 'Fiche introuvable'; end if;
  if v_item.status <> 'available' then raise exception 'Ce bien n''est plus disponible'; end if;
  if is_org_member(v_item.organization_id) then
    raise exception 'Vous faites partie de cette entreprise';
  end if;

  if exists (select 1 from catalog_requests
              where item_id = p_item_id and requester_id = auth.uid() and status = 'pending') then
    raise exception 'Vous avez déjà une demande en attente sur ce bien';
  end if;

  insert into catalog_requests (item_id, requester_id, kind, message, preferred_at)
  values (p_item_id, auth.uid(), p_kind, nullif(trim(coalesce(p_message, '')), ''), p_preferred_at)
  returning id into v_id;

  select display_name into v_nom from profiles where id = auth.uid();
  -- Le lien de la notification vient du registre : si l'administrateur change
  -- la route d'une vitrine, les notifications suivent (§7).
  select route into v_route from app_registry where slug = v_item.app_slug;
  for v_membre in select profile_id from organization_members
                   where organization_id = v_item.organization_id loop
    perform notify(v_membre.profile_id, 'catalog_request', 'Nouvelle demande client',
                   coalesce(v_nom, 'Un client') || ' — ' || v_item.title, coalesce(v_route, '/newpad'));
  end loop;
  return v_id;
end;
$function$;

create or replace function catalog_decide_request(
  p_request_id uuid, p_decision text, p_scheduled_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_req record; v_libelle text; v_route text;
begin
  perform require_active_profile();
  if p_decision not in ('accepted','declined','done','cancelled') then
    raise exception 'Décision invalide';
  end if;

  select r.*, i.organization_id as org_id, i.title as item_title, i.app_slug as app_slug into v_req
    from catalog_requests r join catalog_items i on i.id = r.item_id
   where r.id = p_request_id;
  if v_req.id is null then raise exception 'Demande introuvable'; end if;

  -- Annuler sa demande appartient au client ; tout le reste à l'entreprise.
  if p_decision = 'cancelled' then
    if v_req.requester_id <> auth.uid() then raise exception 'Cette demande n''est pas la vôtre'; end if;
  else
    if not is_org_member(v_req.org_id) then raise exception 'Réservé à l''entreprise'; end if;
  end if;
  if v_req.status not in ('pending','accepted') then raise exception 'Demande déjà close'; end if;

  update catalog_requests
     set status = p_decision,
         scheduled_at = coalesce(p_scheduled_at, scheduled_at),
         decided_at = now()
   where id = p_request_id;

  -- Un rendez-vous accepté réserve le bien : deux clients ne visitent pas la
  -- même villa en croyant chacun l'avoir.
  if p_decision = 'accepted' and v_req.kind = 'reserve' then
    update catalog_items set status = 'reserved' where id = v_req.item_id;
  end if;

  v_libelle := case p_decision when 'accepted' then 'Demande acceptée'
                               when 'declined' then 'Demande refusée'
                               when 'done' then 'Rendez-vous clôturé'
                               else null end;
  if v_libelle is not null then
    select route into v_route from app_registry where slug = v_req.app_slug;
    perform notify(v_req.requester_id, 'catalog_request', v_libelle, v_req.item_title,
                   coalesce(v_route, '/newpad'));
  end if;
end;
$function$;

create or replace function catalog_org_requests(p_app_slug text, p_organization_id uuid)
returns table (id uuid, item_id uuid, item_title text, requester_id uuid, requester_name text,
               kind text, message text, preferred_at timestamptz, scheduled_at timestamptz,
               status text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_org_member(p_organization_id) then
    raise exception 'Réservé à l''entreprise';
  end if;
  return query
    select r.id, r.item_id, i.title, r.requester_id, p.display_name, r.kind, r.message,
           r.preferred_at, r.scheduled_at, r.status, r.created_at
    from catalog_requests r
    join catalog_items i on i.id = r.item_id
    join profiles p on p.id = r.requester_id
    where i.app_slug = p_app_slug and i.organization_id = p_organization_id
    order by case r.status when 'pending' then 0 when 'accepted' then 1 else 2 end,
             r.created_at desc
    limit 200;
end;
$function$;

create or replace function catalog_my_requests(p_app_slug text default null)
returns table (id uuid, item_id uuid, item_title text, app_slug text, org_name text,
               kind text, status text, scheduled_at timestamptz, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  return query
    select r.id, r.item_id, i.title, i.app_slug, o.name, r.kind, r.status,
           r.scheduled_at, r.created_at
    from catalog_requests r
    join catalog_items i on i.id = r.item_id
    join organizations o on o.id = i.organization_id
    where r.requester_id = auth.uid()
      and (p_app_slug is null or i.app_slug = p_app_slug)
    order by r.created_at desc
    limit 100;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Les trois vitrines du cahier des charges et leurs catégories de départ.
-- Tout est modifiable depuis l'administration ensuite.
-- ----------------------------------------------------------------------------
update app_registry set is_showcase = true, status = 'live'
 where slug in ('dynasty', 'luxury', 'vangelico');

insert into catalog_subtypes (app_slug, code, label, sort_order) values
  ('dynasty', 'villa', 'Villa', 10),
  ('dynasty', 'appartement', 'Appartement', 20),
  ('dynasty', 'penthouse', 'Penthouse', 30),
  ('dynasty', 'terrain', 'Terrain', 40),
  ('dynasty', 'commerce', 'Local commercial', 50),
  ('dynasty', 'entrepot', 'Entrepôt', 60),
  ('luxury', 'sportive', 'Sportive', 10),
  ('luxury', 'berline', 'Berline', 20),
  ('luxury', 'suv', 'SUV', 30),
  ('luxury', 'cabriolet', 'Cabriolet', 40),
  ('luxury', 'moto', 'Moto', 50),
  ('luxury', 'utilitaire', 'Utilitaire', 60),
  ('luxury', 'collection', 'Collection', 70),
  ('vangelico', 'bague', 'Bague', 10),
  ('vangelico', 'collier', 'Collier', 20),
  ('vangelico', 'bracelet', 'Bracelet', 30),
  ('vangelico', 'montre', 'Montre', 40),
  ('vangelico', 'boucles', 'Boucles d''oreilles', 50),
  ('vangelico', 'pierre', 'Pierre précieuse', 60)
on conflict (app_slug, code) do nothing;

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
grant execute on function track_event(text, text, uuid, text, jsonb) to anon;
grant execute on function content_stats(text, uuid[]) to anon;
grant execute on function list_comments(text, uuid) to anon;
grant execute on function news_feed(text, text, int) to anon;
grant execute on function news_article(uuid) to anon;
grant execute on function tube_feed(text, uuid) to anon;
grant execute on function tube_channel_info(uuid) to anon;
grant execute on function channel_owner(uuid) to anon;
grant execute on function life_feed(text, text, uuid) to anon;
grant execute on function life_profile_info(uuid) to anon;
grant execute on function event_feed(text, text, int) to anon;
grant execute on function event_detail(uuid) to anon;

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

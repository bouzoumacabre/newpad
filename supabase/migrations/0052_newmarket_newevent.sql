-- ############################################################################
-- 0052 — NEWMARKET (petites annonces) + NEWEVENT (agenda de la ville)
-- ############################################################################
-- Deux applications, une même logique : un contenu posté par un citoyen ou par
-- une organisation, une audience qui réagit, et une mise en relation qui se
-- termine EN JEU. Aucune de ces deux applications ne déplace le moindre fonds :
--
--   * §90 — aucune gestion de monnaie H$, jamais, nulle part.
--   * Le prix d'une annonce et le tarif d'un événement sont des ANNONCES DE
--     PRIX, du texte affiché. La poignée de main se fait en roleplay, et si
--     elle passe par un virement, elle passe par Newman Bank, qui a déjà tout
--     ce qu'il faut pour ça. NewMarket n'est pas une caisse.
--
-- Les vues, les « j'aime » et les commentaires réutilisent le socle
-- d'engagement (0049) : aucune table de compteurs n'est créée ici.
-- ############################################################################

-- ============================================================================
-- NEWMARKET — les petites annonces
-- ============================================================================

create table if not exists market_listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references profiles(id) on delete cascade,
  organization_id uuid references organizations(id) on delete set null,
  title text not null,
  description text not null,
  category text not null default 'divers',
  condition text not null default 'bon',
  price numeric(14,2),
  price_label text,
  location text,
  photos text[] not null default '{}',
  status text not null default 'active',
  bumped_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint market_title_len check (length(trim(title)) between 3 and 120),
  constraint market_desc_len check (length(description) between 1 and 6000),
  constraint market_price_positive check (price is null or (price >= 0 and price <= 1000000000)),
  constraint market_price_label_len check (price_label is null or length(price_label) <= 40),
  constraint market_location_len check (location is null or length(location) <= 80),
  constraint market_photos_len check (array_length(photos, 1) is null or array_length(photos, 1) <= 6),
  constraint market_status_check check (status in ('draft','active','reserved','sold','archived')),
  constraint market_condition_check check (condition in ('neuf','bon','usage','pieces','service')),
  constraint market_category_check check (category in (
    'vehicule','immobilier','materiel','vetement','bijou','arme','service',
    'emploi','alimentaire','collection','divers'
  ))
);

create index if not exists idx_market_active on market_listings(status, bumped_at desc);
create index if not exists idx_market_seller on market_listings(seller_id, created_at desc);
create index if not exists idx_market_category on market_listings(category, status, bumped_at desc);

drop trigger if exists trg_market_touch on market_listings;
create trigger trg_market_touch before update on market_listings
  for each row execute function _touch_updated_at();

alter table market_listings enable row level security;

-- Une annonce active est lisible par tout titulaire d'un compte : NewMarket est
-- une application « client », la vitrine de la ville reste NewPage.
drop policy if exists market_select_active on market_listings;
create policy market_select_active on market_listings
  for select to authenticated using (status in ('active','reserved','sold'));

drop policy if exists market_select_own on market_listings;
create policy market_select_own on market_listings
  for select to authenticated using (seller_id = auth.uid());

-- Les offres. Une offre n'est pas un paiement : c'est un message chiffré
-- (« je te la prends à tant ») que le vendeur accepte ou décline.
create table if not exists market_offers (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references market_listings(id) on delete cascade,
  buyer_id uuid not null references profiles(id) on delete cascade,
  message text,
  proposed_price numeric(14,2),
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint market_offer_msg_len check (message is null or length(message) <= 1000),
  constraint market_offer_price check (proposed_price is null or (proposed_price >= 0 and proposed_price <= 1000000000)),
  constraint market_offer_status check (status in ('pending','accepted','declined','withdrawn'))
);

create index if not exists idx_market_offers_listing on market_offers(listing_id, created_at desc);
create index if not exists idx_market_offers_buyer on market_offers(buyer_id, created_at desc);

alter table market_offers enable row level security;

-- Fonction citée par une policy : donc SANS préfixe `_`, sinon la policy
-- s'évalue avec les droits de l'appelant et échoue (leçon de 0043).
create or replace function listing_seller(p_listing_id uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select seller_id from market_listings where id = p_listing_id;
$function$;

-- L'acheteur voit ses propres offres, le vendeur voit celles reçues. Personne
-- ne voit les offres des autres sur une annonce : une enchère publique
-- changerait complètement le rapport de force d'une négociation RP.
drop policy if exists market_offers_select on market_offers;
create policy market_offers_select on market_offers
  for select to authenticated
  using (buyer_id = auth.uid() or listing_seller(listing_id) = auth.uid());

-- ----------------------------------------------------------------------------
-- NewMarket — écritures
-- ----------------------------------------------------------------------------
create or replace function market_save_listing(
  p_title text, p_description text, p_id uuid default null,
  p_category text default 'divers', p_condition text default 'bon',
  p_price numeric default null, p_price_label text default null,
  p_location text default null, p_photos text[] default null,
  p_organization_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_vendeur uuid;
begin
  perform require_active_profile();

  -- Vendre au nom d'une entreprise suppose d'y appartenir.
  if p_organization_id is not null and not is_org_member(p_organization_id) then
    raise exception 'Vous ne faites pas partie de cette entreprise';
  end if;

  if p_id is null then
    insert into market_listings (seller_id, organization_id, title, description, category,
                                 condition, price, price_label, location, photos)
    values (auth.uid(), p_organization_id, trim(p_title), p_description,
            coalesce(p_category, 'divers'), coalesce(p_condition, 'bon'), p_price,
            nullif(trim(coalesce(p_price_label, '')), ''),
            nullif(trim(coalesce(p_location, '')), ''), coalesce(p_photos, '{}'))
    returning id into v_id;
  else
    select seller_id into v_vendeur from market_listings where id = p_id;
    if v_vendeur is null then raise exception 'Annonce introuvable'; end if;
    if v_vendeur <> auth.uid() then raise exception 'Cette annonce n''est pas la vôtre'; end if;

    update market_listings set
      title = trim(p_title),
      description = p_description,
      category = coalesce(p_category, category),
      condition = coalesce(p_condition, condition),
      price = p_price,
      price_label = nullif(trim(coalesce(p_price_label, '')), ''),
      location = nullif(trim(coalesce(p_location, '')), ''),
      photos = coalesce(p_photos, photos),
      organization_id = p_organization_id
    where id = p_id
    returning id into v_id;
  end if;
  return v_id;
end;
$function$;

create or replace function market_set_status(p_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_vendeur uuid;
begin
  perform require_active_profile();
  if p_status not in ('draft','active','reserved','sold','archived') then
    raise exception 'Statut invalide';
  end if;
  select seller_id into v_vendeur from market_listings where id = p_id;
  if v_vendeur is null then raise exception 'Annonce introuvable'; end if;
  if v_vendeur <> auth.uid() and not is_newpad_admin() then
    raise exception 'Cette annonce n''est pas la vôtre';
  end if;

  update market_listings
     set status = p_status,
         bumped_at = case when p_status = 'active' then now() else bumped_at end
   where id = p_id;

  -- Vendue ou retirée : les négociations encore ouvertes se ferment d'elles-mêmes,
  -- pour qu'aucun acheteur ne reste à attendre une réponse qui ne viendra pas.
  if p_status in ('sold','archived') then
    update market_offers set status = 'declined', decided_at = now()
     where listing_id = p_id and status = 'pending';
  end if;
end;
$function$;

-- Remonter son annonce, une fois par heure : sans ce garde-fou, le fil se
-- résume au premier vendeur qui clique le plus vite.
create or replace function market_bump(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_vendeur uuid; v_bump timestamptz;
begin
  perform require_active_profile();
  select seller_id, bumped_at into v_vendeur, v_bump from market_listings where id = p_id;
  if v_vendeur is null then raise exception 'Annonce introuvable'; end if;
  if v_vendeur <> auth.uid() then raise exception 'Cette annonce n''est pas la vôtre'; end if;
  if v_bump > now() - interval '1 hour' then
    raise exception 'Annonce déjà remontée récemment — réessayez dans une heure';
  end if;
  update market_listings set bumped_at = now(), status = 'active' where id = p_id;
end;
$function$;

create or replace function market_make_offer(
  p_listing_id uuid, p_message text default null, p_proposed_price numeric default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_annonce record; v_nom text;
begin
  perform require_active_profile();
  select id, seller_id, title, status into v_annonce from market_listings where id = p_listing_id;
  if v_annonce.id is null then raise exception 'Annonce introuvable'; end if;
  if v_annonce.seller_id = auth.uid() then raise exception 'C''est votre propre annonce'; end if;
  if v_annonce.status <> 'active' then raise exception 'Cette annonce n''est plus disponible'; end if;

  if exists (select 1 from market_offers
              where listing_id = p_listing_id and buyer_id = auth.uid() and status = 'pending') then
    raise exception 'Vous avez déjà une proposition en attente sur cette annonce';
  end if;

  insert into market_offers (listing_id, buyer_id, message, proposed_price)
  values (p_listing_id, auth.uid(), nullif(trim(coalesce(p_message, '')), ''), p_proposed_price)
  returning id into v_id;

  select display_name into v_nom from profiles where id = auth.uid();
  perform notify(v_annonce.seller_id, 'market_offer', 'Nouvelle proposition',
                 coalesce(v_nom, 'Un acheteur') || ' — ' || v_annonce.title, '/market');
  return v_id;
end;
$function$;

create or replace function market_decide_offer(p_offer_id uuid, p_decision text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_offre record; v_titre text; v_libelle text;
begin
  perform require_active_profile();
  if p_decision not in ('accepted','declined','withdrawn') then
    raise exception 'Décision invalide';
  end if;

  select o.*, l.seller_id, l.title into v_offre
    from market_offers o join market_listings l on l.id = o.listing_id
   where o.id = p_offer_id;
  if v_offre.id is null then raise exception 'Proposition introuvable'; end if;
  if v_offre.status <> 'pending' then raise exception 'Proposition déjà traitée'; end if;

  -- Retirer sa proposition appartient à l'acheteur ; l'accepter ou la refuser
  -- appartient au vendeur. Les deux passent par la même porte, pas par la même clé.
  if p_decision = 'withdrawn' then
    if v_offre.buyer_id <> auth.uid() then raise exception 'Cette proposition n''est pas la vôtre'; end if;
  else
    if v_offre.seller_id <> auth.uid() then raise exception 'Cette annonce n''est pas la vôtre'; end if;
  end if;

  update market_offers set status = p_decision, decided_at = now() where id = p_offer_id;
  v_titre := v_offre.title;

  if p_decision = 'accepted' then
    -- Réservée, pas vendue : l'échange se conclut en jeu, et c'est le vendeur
    -- qui vient dire ici que c'est fait. Aucun fonds ne bouge dans Newpad.
    update market_listings set status = 'reserved' where id = v_offre.listing_id;
    update market_offers set status = 'declined', decided_at = now()
     where listing_id = v_offre.listing_id and status = 'pending' and id <> p_offer_id;
    v_libelle := 'Proposition acceptée';
  elsif p_decision = 'declined' then
    v_libelle := 'Proposition refusée';
  end if;

  if p_decision in ('accepted','declined') then
    perform notify(v_offre.buyer_id, 'market_offer', v_libelle, v_titre, '/market');
  end if;
end;
$function$;

-- ----------------------------------------------------------------------------
-- NewMarket — lectures
-- ----------------------------------------------------------------------------
create or replace function market_feed(
  p_category text default null, p_search text default null, p_limit int default 40
)
returns table (id uuid, title text, category text, condition text, price numeric,
               price_label text, location text, photo text, status text,
               seller_name text, seller_id uuid, org_name text, bumped_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  return query
    select l.id, l.title, l.category, l.condition, l.price, l.price_label, l.location,
           case when array_length(l.photos, 1) is null then null else l.photos[1] end,
           l.status, p.display_name, l.seller_id, o.name, l.bumped_at
    from market_listings l
    join profiles p on p.id = l.seller_id
    left join organizations o on o.id = l.organization_id
    where l.status in ('active','reserved')
      and (p_category is null or l.category = p_category)
      and (p_search is null or trim(p_search) = ''
           or l.title ilike '%' || trim(p_search) || '%'
           or l.description ilike '%' || trim(p_search) || '%')
    order by l.bumped_at desc
    limit least(coalesce(p_limit, 40), 100);
end;
$function$;

create or replace function market_listing(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_res jsonb;
begin
  select jsonb_build_object(
    'id', l.id, 'title', l.title, 'description', l.description, 'category', l.category,
    'condition', l.condition, 'price', l.price, 'price_label', l.price_label,
    'location', l.location, 'photos', l.photos, 'status', l.status,
    'seller_id', l.seller_id, 'seller_name', p.display_name,
    'org_name', o.name, 'organization_id', l.organization_id,
    'created_at', l.created_at, 'bumped_at', l.bumped_at,
    'is_mine', (l.seller_id = auth.uid()),
    'my_offer', (select jsonb_build_object('id', mo.id, 'status', mo.status,
                                           'proposed_price', mo.proposed_price)
                   from market_offers mo
                  where mo.listing_id = l.id and mo.buyer_id = auth.uid()
                  order by mo.created_at desc limit 1)
  ) into v_res
  from market_listings l
  join profiles p on p.id = l.seller_id
  left join organizations o on o.id = l.organization_id
  where l.id = p_id and (l.status in ('active','reserved','sold') or l.seller_id = auth.uid());

  if v_res is null then raise exception 'Annonce introuvable'; end if;
  return v_res;
end;
$function$;

create or replace function market_my_listings()
returns table (id uuid, title text, category text, price numeric, status text,
               offers_pending bigint, created_at timestamptz, bumped_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  return query
    select l.id, l.title, l.category, l.price, l.status,
           (select count(*) from market_offers o
             where o.listing_id = l.id and o.status = 'pending'),
           l.created_at, l.bumped_at
    from market_listings l
    where l.seller_id = auth.uid()
    order by l.created_at desc
    limit 200;
end;
$function$;

create or replace function market_listing_offers(p_listing_id uuid)
returns table (id uuid, buyer_id uuid, buyer_name text, message text,
               proposed_price numeric, status text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if listing_seller(p_listing_id) is distinct from auth.uid() then
    raise exception 'Cette annonce n''est pas la vôtre';
  end if;
  return query
    select o.id, o.buyer_id, p.display_name, o.message, o.proposed_price, o.status, o.created_at
    from market_offers o
    join profiles p on p.id = o.buyer_id
    where o.listing_id = p_listing_id
    order by case o.status when 'pending' then 0 else 1 end, o.created_at desc
    limit 100;
end;
$function$;

create or replace function market_my_offers()
returns table (id uuid, listing_id uuid, listing_title text, seller_name text,
               proposed_price numeric, status text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  return query
    select o.id, o.listing_id, l.title, p.display_name, o.proposed_price, o.status, o.created_at
    from market_offers o
    join market_listings l on l.id = o.listing_id
    join profiles p on p.id = l.seller_id
    where o.buyer_id = auth.uid()
    order by o.created_at desc
    limit 100;
end;
$function$;

-- ============================================================================
-- NEWEVENT — l'agenda de la ville
-- ============================================================================
-- Application « invité » : l'affiche d'une soirée doit pouvoir circuler sans
-- compte, c'est tout l'intérêt d'une affiche. Répondre présent, en revanche,
-- suppose une identité.

create table if not exists event_items (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references profiles(id) on delete cascade,
  organization_id uuid references organizations(id) on delete set null,
  title text not null,
  description text not null,
  category text not null default 'autre',
  cover_url text,
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  capacity int,
  price_info text,
  status text not null default 'published',
  is_featured boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint event_title_len check (length(trim(title)) between 3 and 120),
  constraint event_desc_len check (length(description) between 1 and 8000),
  constraint event_location_len check (location is null or length(location) <= 120),
  constraint event_price_info_len check (price_info is null or length(price_info) <= 60),
  constraint event_capacity_check check (capacity is null or (capacity > 0 and capacity <= 100000)),
  constraint event_dates_check check (ends_at is null or ends_at >= starts_at),
  constraint event_status_check check (status in ('draft','published','cancelled','done')),
  constraint event_category_check check (category in (
    'soiree','concert','sport','course','business','vente','ceremonie','caritatif','autre'
  ))
);

create index if not exists idx_event_agenda on event_items(status, starts_at);
create index if not exists idx_event_host on event_items(host_id, starts_at desc);

drop trigger if exists trg_event_touch on event_items;
create trigger trg_event_touch before update on event_items
  for each row execute function _touch_updated_at();

alter table event_items enable row level security;

drop policy if exists event_select_public on event_items;
create policy event_select_public on event_items
  for select to authenticated, anon using (status in ('published','cancelled','done'));

drop policy if exists event_select_own on event_items;
create policy event_select_own on event_items
  for select to authenticated
  using (host_id = auth.uid() or (organization_id is not null and is_org_member(organization_id)));

create table if not exists event_attendees (
  event_id uuid not null references event_items(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  rsvp text not null default 'going',
  created_at timestamptz not null default now(),
  primary key (event_id, profile_id),
  constraint event_rsvp_check check (rsvp in ('going','interested'))
);

create index if not exists idx_event_attendees_profile on event_attendees(profile_id, created_at desc);

alter table event_attendees enable row level security;

create or replace function event_host(p_event_id uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select host_id from event_items where id = p_event_id;
$function$;

-- La liste des présents est publique côté joueurs — savoir qui vient fait
-- partie de la décision de venir. Un invité (rôle anon) voit le compteur,
-- calculé par fonction, pas la liste nominative.
drop policy if exists event_attendees_select on event_attendees;
create policy event_attendees_select on event_attendees
  for select to authenticated using (true);

-- ----------------------------------------------------------------------------
-- NewEvent — écritures
-- ----------------------------------------------------------------------------
create or replace function event_save(
  p_title text, p_description text, p_starts_at timestamptz,
  p_id uuid default null, p_category text default 'autre',
  p_location text default null, p_ends_at timestamptz default null,
  p_capacity int default null, p_price_info text default null,
  p_cover_url text default null, p_organization_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_event record;
begin
  perform require_active_profile();
  if p_starts_at is null then raise exception 'La date est obligatoire'; end if;
  if p_organization_id is not null and not is_org_member(p_organization_id) then
    raise exception 'Vous ne faites pas partie de cette organisation';
  end if;

  if p_id is null then
    insert into event_items (host_id, organization_id, title, description, category,
                             location, starts_at, ends_at, capacity, price_info, cover_url)
    values (auth.uid(), p_organization_id, trim(p_title), p_description,
            coalesce(p_category, 'autre'), nullif(trim(coalesce(p_location, '')), ''),
            p_starts_at, p_ends_at, p_capacity,
            nullif(trim(coalesce(p_price_info, '')), ''),
            nullif(trim(coalesce(p_cover_url, '')), ''))
    returning id into v_id;
  else
    select id, host_id, organization_id into v_event from event_items where id = p_id;
    if v_event.id is null then raise exception 'Événement introuvable'; end if;
    -- L'organisateur, ou la direction de l'organisation qui porte l'événement :
    -- une soirée d'entreprise ne doit pas mourir avec le départ de l'employé
    -- qui l'a créée.
    if v_event.host_id <> auth.uid()
       and not (v_event.organization_id is not null and is_org_manager(v_event.organization_id)) then
      raise exception 'Cet événement n''est pas le vôtre';
    end if;

    update event_items set
      title = trim(p_title),
      description = p_description,
      category = coalesce(p_category, category),
      location = nullif(trim(coalesce(p_location, '')), ''),
      starts_at = p_starts_at,
      ends_at = p_ends_at,
      capacity = p_capacity,
      price_info = nullif(trim(coalesce(p_price_info, '')), ''),
      cover_url = nullif(trim(coalesce(p_cover_url, '')), ''),
      organization_id = p_organization_id
    where id = p_id
    returning id into v_id;
  end if;
  return v_id;
end;
$function$;

create or replace function event_set_status(p_id uuid, p_status text, p_featured boolean default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_event record; v_present record;
begin
  perform require_active_profile();
  if p_status not in ('draft','published','cancelled','done') then
    raise exception 'Statut invalide';
  end if;
  select id, host_id, organization_id, title, status into v_event from event_items where id = p_id;
  if v_event.id is null then raise exception 'Événement introuvable'; end if;
  if v_event.host_id <> auth.uid()
     and not (v_event.organization_id is not null and is_org_manager(v_event.organization_id))
     and not is_newpad_admin() then
    raise exception 'Cet événement n''est pas le vôtre';
  end if;

  -- La mise en avant sur l'agenda relève de l'administration Newpad, pas de
  -- l'organisateur : sinon tout le monde se met en avant et plus personne.
  if p_featured is not null and not is_newpad_admin() then
    raise exception 'La mise en avant relève de l''administration Newpad';
  end if;

  update event_items
     set status = p_status,
         is_featured = coalesce(p_featured, is_featured)
   where id = p_id;

  -- Une annulation se dit à ceux qui avaient prévu de venir.
  if p_status = 'cancelled' and v_event.status <> 'cancelled' then
    for v_present in select profile_id from event_attendees where event_id = p_id loop
      perform notify(v_present.profile_id, 'event', 'Événement annulé', v_event.title, '/events');
    end loop;
  end if;
end;
$function$;

create or replace function event_rsvp(p_event_id uuid, p_rsvp text default 'going')
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_event record; v_actuel text; v_places bigint;
begin
  perform require_active_profile();
  if p_rsvp not in ('going','interested') then raise exception 'Réponse invalide'; end if;

  select id, status, capacity, starts_at into v_event from event_items where id = p_event_id;
  if v_event.id is null then raise exception 'Événement introuvable'; end if;
  if v_event.status <> 'published' then raise exception 'Cet événement n''accepte pas d''inscription'; end if;

  select rsvp into v_actuel from event_attendees
   where event_id = p_event_id and profile_id = auth.uid();

  -- Même réponse deux fois : on se désinscrit. Un seul bouton, deux sens.
  if v_actuel = p_rsvp then
    delete from event_attendees where event_id = p_event_id and profile_id = auth.uid();
    return 'none';
  end if;

  if p_rsvp = 'going' and v_event.capacity is not null then
    select count(*) into v_places from event_attendees
     where event_id = p_event_id and rsvp = 'going' and profile_id <> auth.uid();
    if v_places >= v_event.capacity then raise exception 'Événement complet'; end if;
  end if;

  insert into event_attendees (event_id, profile_id, rsvp)
  values (p_event_id, auth.uid(), p_rsvp)
  on conflict (event_id, profile_id) do update set rsvp = excluded.rsvp;
  return p_rsvp;
end;
$function$;

-- ----------------------------------------------------------------------------
-- NewEvent — lectures
-- ----------------------------------------------------------------------------
create or replace function event_feed(
  p_scope text default 'upcoming', p_category text default null, p_limit int default 40
)
returns table (id uuid, title text, category text, location text, cover_url text,
               starts_at timestamptz, ends_at timestamptz, status text, is_featured boolean,
               price_info text, host_name text, org_name text,
               going_count bigint, capacity int)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  return query
    select e.id, e.title, e.category, e.location, e.cover_url, e.starts_at, e.ends_at,
           e.status, e.is_featured, e.price_info, p.display_name, o.name,
           (select count(*) from event_attendees a where a.event_id = e.id and a.rsvp = 'going'),
           e.capacity
    from event_items e
    join profiles p on p.id = e.host_id
    left join organizations o on o.id = e.organization_id
    where e.status in ('published','cancelled')
      and (p_category is null or e.category = p_category)
      and (case when coalesce(p_scope, 'upcoming') = 'past'
                then coalesce(e.ends_at, e.starts_at) < now()
                else coalesce(e.ends_at, e.starts_at) >= now() end)
    order by e.is_featured desc,
             case when coalesce(p_scope, 'upcoming') = 'past' then null else e.starts_at end asc nulls last,
             e.starts_at desc
    limit least(coalesce(p_limit, 40), 100);
end;
$function$;

create or replace function event_detail(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_res jsonb;
begin
  select jsonb_build_object(
    'id', e.id, 'title', e.title, 'description', e.description, 'category', e.category,
    'cover_url', e.cover_url, 'location', e.location, 'starts_at', e.starts_at,
    'ends_at', e.ends_at, 'capacity', e.capacity, 'price_info', e.price_info,
    'status', e.status, 'is_featured', e.is_featured,
    'host_id', e.host_id, 'host_name', p.display_name,
    'organization_id', e.organization_id, 'org_name', o.name,
    'going_count', (select count(*) from event_attendees a where a.event_id = e.id and a.rsvp = 'going'),
    'interested_count', (select count(*) from event_attendees a where a.event_id = e.id and a.rsvp = 'interested'),
    'my_rsvp', (select a.rsvp from event_attendees a where a.event_id = e.id and a.profile_id = auth.uid()),
    'can_edit', (e.host_id = auth.uid()
                 or (e.organization_id is not null and is_org_manager(e.organization_id)))
  ) into v_res
  from event_items e
  join profiles p on p.id = e.host_id
  left join organizations o on o.id = e.organization_id
  where e.id = p_id
    and (e.status in ('published','cancelled','done')
         or e.host_id = auth.uid()
         or (e.organization_id is not null and is_org_member(e.organization_id)));

  if v_res is null then raise exception 'Événement introuvable'; end if;
  return v_res;
end;
$function$;

create or replace function event_mine()
returns table (id uuid, title text, starts_at timestamptz, status text,
               going_count bigint, capacity int, is_host boolean, my_rsvp text)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  return query
    select e.id, e.title, e.starts_at, e.status,
           (select count(*) from event_attendees a where a.event_id = e.id and a.rsvp = 'going'),
           e.capacity,
           (e.host_id = auth.uid()),
           (select a.rsvp from event_attendees a where a.event_id = e.id and a.profile_id = auth.uid())
    from event_items e
    where e.host_id = auth.uid()
       or exists (select 1 from event_attendees a where a.event_id = e.id and a.profile_id = auth.uid())
       or (e.organization_id is not null and is_org_member(e.organization_id) and e.status <> 'draft')
    order by e.starts_at desc
    limit 200;
end;
$function$;

create or replace function event_attendees_list(p_event_id uuid)
returns table (profile_id uuid, display_name text, rsvp text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_event record;
begin
  select host_id, organization_id into v_event from event_items where id = p_event_id;
  if v_event.host_id is null then raise exception 'Événement introuvable'; end if;
  if v_event.host_id <> auth.uid()
     and not (v_event.organization_id is not null and is_org_member(v_event.organization_id)) then
    raise exception 'Réservé à l''organisateur';
  end if;
  return query
    select a.profile_id, p.display_name, a.rsvp, a.created_at
    from event_attendees a
    join profiles p on p.id = a.profile_id
    where a.event_id = p_event_id
    order by a.rsvp, a.created_at
    limit 500;
end;
$function$;

update app_registry set status = 'live', admin_route = null where slug in ('market','events');

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

-- ############################################################################
-- 0055 — NEWADS : LA RÉGIE PUBLICITAIRE DE NEWPAD
-- ############################################################################
-- NewAds n'est pas une application de plus : c'est la seule qui s'affiche DANS
-- les autres. Une entreprise achète un encart, la régie (l'administration
-- Newpad) le valide, et il apparaît dans News24, NewTube, NewLife, NewMarket
-- ou NewEvent selon les emplacements choisis.
--
-- Trois décisions qui structurent tout le reste :
--
-- 1. Les impressions et les clics ne créent AUCUNE table : `analytics_events`
--    accepte déjà `impression` et `click` (0049). Un annonceur lit ses chiffres
--    par une fonction, jamais la table — qui n'a toujours aucune policy de
--    lecture, et c'est voulu.
-- 2. Une annonce ne peut pointer que vers une route INTERNE de Newpad. Le
--    navigateur du jeu n'ouvre pas d'onglet, et une régie qui accepterait des
--    liens sortants deviendrait un vecteur d'hameçonnage dans un jeu où les
--    joueurs ont des comptes en banque.
-- 3. §90 : le budget d'une campagne est une DONNÉE D'AFFICHAGE. Newpad ne
--    facture rien ; l'annonceur règle sa campagne par un virement Newman Bank.
-- ############################################################################

create table if not exists ad_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  created_by uuid not null references profiles(id) on delete cascade,
  title text not null,
  body text,
  media_url text,
  target_route text,
  placements text[] not null default '{}',
  budget numeric(14,2),
  weight int not null default 1,
  status text not null default 'draft',
  review_note text,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ads_title_len check (length(trim(title)) between 3 and 80),
  constraint ads_body_len check (body is null or length(body) <= 300),
  constraint ads_budget_check check (budget is null or (budget >= 0 and budget <= 1000000000)),
  constraint ads_weight_check check (weight between 1 and 10),
  constraint ads_dates_check check (ends_at is null or starts_at is null or ends_at >= starts_at),
  constraint ads_placements_len check (array_length(placements, 1) is null or array_length(placements, 1) <= 10),
  constraint ads_status_check check (status in ('draft','pending','active','paused','rejected','ended')),
  -- Route interne uniquement : ni http, ni //, ni javascript:.
  constraint ads_target_internal check (
    target_route is null or target_route ~ '^/[a-zA-Z0-9/_:-]{0,80}$'
  ),
  constraint ads_media_url check (media_url is null or media_url ~ '^https://')
);

create index if not exists idx_ads_actives on ad_campaigns(status, starts_at, ends_at);
create index if not exists idx_ads_org on ad_campaigns(organization_id, created_at desc);

drop trigger if exists trg_ads_touch on ad_campaigns;
create trigger trg_ads_touch before update on ad_campaigns
  for each row execute function _touch_updated_at();

alter table ad_campaigns enable row level security;

-- Une campagne en cours est publique — c'est une publicité. Tout le reste
-- (brouillons, campagnes refusées, budgets) reste chez l'annonceur et la régie.
drop policy if exists ads_select_live on ad_campaigns;
create policy ads_select_live on ad_campaigns
  for select to authenticated, anon
  using (
    status = 'active'
    and (starts_at is null or starts_at <= now())
    and (ends_at is null or ends_at >= now())
  );

drop policy if exists ads_select_own on ad_campaigns;
create policy ads_select_own on ad_campaigns
  for select to authenticated
  using (is_org_member(organization_id) or is_newpad_admin());

-- ----------------------------------------------------------------------------
-- L'annonceur
-- ----------------------------------------------------------------------------
create or replace function ads_save_campaign(
  p_organization_id uuid, p_title text, p_id uuid default null,
  p_body text default null, p_media_url text default null,
  p_target_route text default null, p_placements text[] default null,
  p_budget numeric default null, p_starts_at timestamptz default null,
  p_ends_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_camp record; v_slug text;
begin
  perform require_active_profile();
  if not is_org_member(p_organization_id) then
    raise exception 'Vous ne faites pas partie de cette entreprise';
  end if;

  -- Un emplacement est une application existante du registre : impossible
  -- d'acheter un encart dans une application qui n'existe pas.
  if p_placements is not null then
    foreach v_slug in array p_placements loop
      if not exists (select 1 from app_registry where slug = v_slug) then
        raise exception 'Emplacement inconnu : %', v_slug;
      end if;
    end loop;
  end if;

  if p_id is null then
    insert into ad_campaigns (organization_id, created_by, title, body, media_url,
                              target_route, placements, budget, starts_at, ends_at)
    values (p_organization_id, auth.uid(), trim(p_title),
            nullif(trim(coalesce(p_body, '')), ''),
            nullif(trim(coalesce(p_media_url, '')), ''),
            nullif(trim(coalesce(p_target_route, '')), ''),
            coalesce(p_placements, '{}'), p_budget, p_starts_at, p_ends_at)
    returning id into v_id;
  else
    select organization_id, status into v_camp from ad_campaigns where id = p_id;
    if v_camp.organization_id is null then raise exception 'Campagne introuvable'; end if;
    if not is_org_member(v_camp.organization_id) then
      raise exception 'Cette campagne n''est pas la vôtre';
    end if;
    -- Modifier une campagne déjà validée reviendrait à faire valider un texte
    -- et en diffuser un autre. Elle repasse donc par la régie.
    if v_camp.status in ('active','paused') then
      raise exception 'Une campagne diffusée se met en pause avant d''être modifiée';
    end if;

    update ad_campaigns set
      title = trim(p_title),
      body = nullif(trim(coalesce(p_body, '')), ''),
      media_url = nullif(trim(coalesce(p_media_url, '')), ''),
      target_route = nullif(trim(coalesce(p_target_route, '')), ''),
      placements = coalesce(p_placements, placements),
      budget = p_budget,
      starts_at = p_starts_at,
      ends_at = p_ends_at,
      status = case when status = 'rejected' then 'draft' else status end,
      review_note = case when status = 'rejected' then null else review_note end
    where id = p_id
    returning id into v_id;
  end if;
  return v_id;
end;
$function$;

create or replace function ads_submit(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_camp record; v_admin record;
begin
  perform require_active_profile();
  select organization_id, status, title, placements into v_camp from ad_campaigns where id = p_id;
  if v_camp.organization_id is null then raise exception 'Campagne introuvable'; end if;
  if not is_org_member(v_camp.organization_id) then
    raise exception 'Cette campagne n''est pas la vôtre';
  end if;
  if v_camp.status not in ('draft','rejected') then
    raise exception 'Cette campagne est déjà passée à la régie';
  end if;
  if array_length(v_camp.placements, 1) is null then
    raise exception 'Choisissez au moins un emplacement';
  end if;

  update ad_campaigns set status = 'pending', review_note = null where id = p_id;

  for v_admin in select id from profiles where newpad_role = 'admin' loop
    perform notify(v_admin.id, 'ad_campaign', 'Campagne à valider', v_camp.title, '/ads');
  end loop;
end;
$function$;

create or replace function ads_set_paused(p_id uuid, p_paused boolean)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_camp record;
begin
  perform require_active_profile();
  select organization_id, status into v_camp from ad_campaigns where id = p_id;
  if v_camp.organization_id is null then raise exception 'Campagne introuvable'; end if;
  if not is_org_member(v_camp.organization_id) and not is_newpad_admin() then
    raise exception 'Cette campagne n''est pas la vôtre';
  end if;
  if v_camp.status not in ('active','paused') then
    raise exception 'Cette campagne n''est pas en diffusion';
  end if;
  update ad_campaigns set status = case when coalesce(p_paused, false) then 'paused' else 'active' end
   where id = p_id;
end;
$function$;

-- ----------------------------------------------------------------------------
-- La régie (administration Newpad)
-- ----------------------------------------------------------------------------
create or replace function ads_review(p_id uuid, p_decision text, p_note text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_camp record; v_membre record; v_libelle text;
begin
  if not is_newpad_admin() then raise exception 'Réservé à la régie Newpad'; end if;
  if p_decision not in ('active','rejected','ended') then raise exception 'Décision invalide'; end if;

  select organization_id, status, title into v_camp from ad_campaigns where id = p_id;
  if v_camp.organization_id is null then raise exception 'Campagne introuvable'; end if;

  update ad_campaigns set
    status = p_decision,
    review_note = nullif(trim(coalesce(p_note, '')), ''),
    starts_at = case when p_decision = 'active' and starts_at is null then now() else starts_at end
  where id = p_id;

  v_libelle := case p_decision when 'active' then 'Campagne validée'
                               when 'rejected' then 'Campagne refusée'
                               else 'Campagne arrêtée' end;
  for v_membre in select profile_id from organization_members
                   where organization_id = v_camp.organization_id loop
    perform notify(v_membre.profile_id, 'ad_campaign', v_libelle, v_camp.title, '/ads');
  end loop;
end;
$function$;

create or replace function ads_pending()
returns table (id uuid, title text, body text, media_url text, target_route text,
               placements text[], budget numeric, org_name text, organization_id uuid,
               starts_at timestamptz, ends_at timestamptz, status text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_newpad_admin() then raise exception 'Réservé à la régie Newpad'; end if;
  return query
    select c.id, c.title, c.body, c.media_url, c.target_route, c.placements, c.budget,
           o.name, c.organization_id, c.starts_at, c.ends_at, c.status, c.created_at
    from ad_campaigns c
    join organizations o on o.id = c.organization_id
    where c.status in ('pending','active','paused')
    order by case c.status when 'pending' then 0 else 1 end, c.created_at desc
    limit 200;
end;
$function$;

-- ----------------------------------------------------------------------------
-- La diffusion
-- ----------------------------------------------------------------------------
-- Un encart par emplacement, tiré au sort à chaque affichage et pondéré : une
-- campagne de poids 3 sort trois fois plus souvent qu'une campagne de poids 1.
-- Le tirage se fait en base, sinon deux joueurs verraient toujours la même.
create or replace function ads_serve(p_app_slug text, p_limit int default 1)
returns table (id uuid, title text, body text, media_url text, target_route text,
               org_name text, organization_id uuid)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  return query
    select c.id, c.title, c.body, c.media_url, c.target_route, o.name, c.organization_id
    from ad_campaigns c
    join organizations o on o.id = c.organization_id
    where c.status = 'active'
      and p_app_slug = any (c.placements)
      and (c.starts_at is null or c.starts_at <= now())
      and (c.ends_at is null or c.ends_at >= now())
      and o.status = 'active'
    order by random() * (1.0 / c.weight)
    limit least(coalesce(p_limit, 1), 3);
end;
$function$;

-- Les chiffres d'une campagne : lus par fonction, jamais par la table.
create or replace function ads_campaign_stats(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_org uuid; v_imp bigint; v_clics bigint;
begin
  select organization_id into v_org from ad_campaigns where id = p_id;
  if v_org is null then raise exception 'Campagne introuvable'; end if;
  if not is_org_member(v_org) and not is_newpad_admin() then
    raise exception 'Cette campagne n''est pas la vôtre';
  end if;

  select count(*) filter (where event_type = 'impression'),
         count(*) filter (where event_type = 'click')
    into v_imp, v_clics
  from analytics_events
  where entity_type = 'ad_campaign' and entity_id = p_id;

  return jsonb_build_object(
    'impressions', coalesce(v_imp, 0),
    'clics', coalesce(v_clics, 0),
    'taux', case when coalesce(v_imp, 0) = 0 then 0
                 else round((coalesce(v_clics, 0)::numeric * 100) / v_imp, 2) end
  );
end;
$function$;

create or replace function ads_my_campaigns(p_organization_id uuid)
returns table (id uuid, title text, status text, placements text[], budget numeric,
               starts_at timestamptz, ends_at timestamptz, review_note text,
               impressions bigint, clics bigint, created_at timestamptz)
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
    select c.id, c.title, c.status, c.placements, c.budget, c.starts_at, c.ends_at, c.review_note,
           (select count(*) from analytics_events a
             where a.entity_type = 'ad_campaign' and a.entity_id = c.id and a.event_type = 'impression'),
           (select count(*) from analytics_events a
             where a.entity_type = 'ad_campaign' and a.entity_id = c.id and a.event_type = 'click'),
           c.created_at
    from ad_campaigns c
    where c.organization_id = p_organization_id
    order by c.created_at desc
    limit 200;
end;
$function$;

update app_registry set status = 'live' where slug = 'ads';

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
-- Les applications à audience s'ouvrent sans compte : leurs encarts aussi.
grant execute on function ads_serve(text, int) to anon;

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

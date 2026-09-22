-- ############################################################################
-- 0050 — NEWS24 : LE MÉDIA DE LA VILLE (§34)
-- ############################################################################
-- Trois interfaces demandées : lecteur, journaliste, rédacteur en chef. Aucune
-- n'introduit un nouveau système de rôles — un journal EST une organisation de
-- genre `media`, ses journalistes en sont les membres et son rédacteur en chef
-- la direction. La même mécanique fait donc tourner Newman Bank, NewPro,
-- NewWork et maintenant la rédaction.
--
-- Conséquence directe et voulue : la ville peut avoir plusieurs journaux
-- concurrents sans une ligne de code de plus.
-- ############################################################################

create table if not exists news_articles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  author_id uuid not null references profiles(id) on delete cascade,
  title text not null,
  lede text,
  body text not null,
  cover_url text,
  category text not null default 'city',
  tags text[] not null default '{}',
  status text not null default 'draft',
  is_breaking boolean not null default false,
  is_featured boolean not null default false,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint news_title_len check (length(trim(title)) between 3 and 160),
  constraint news_body_len check (length(body) between 1 and 30000),
  constraint news_lede_len check (lede is null or length(lede) <= 400),
  constraint news_status_check check (status in ('draft','review','published','archived')),
  constraint news_category_check check (category in (
    'city','economy','politics','justice','culture','sport','faitsdivers','people','annonce'
  )),
  constraint news_tags_len check (array_length(tags, 1) is null or array_length(tags, 1) <= 10)
);

create index if not exists idx_news_published on news_articles(status, published_at desc);
create index if not exists idx_news_org on news_articles(organization_id, created_at desc);

drop trigger if exists trg_news_touch on news_articles;
create trigger trg_news_touch before update on news_articles
  for each row execute function _touch_updated_at();

alter table news_articles enable row level security;

-- Un article publié est lisible de toute la ville, compte ou non : un journal
-- sans lecteurs n'est pas un journal. Les brouillons et les articles en
-- relecture restent dans la rédaction.
drop policy if exists news_select_public on news_articles;
create policy news_select_public on news_articles
  for select to authenticated, anon using (status = 'published');

drop policy if exists news_select_newsroom on news_articles;
create policy news_select_newsroom on news_articles
  for select to authenticated using (is_org_member(organization_id));

-- ----------------------------------------------------------------------------
-- Rédaction
-- ----------------------------------------------------------------------------
create or replace function news_save_article(
  p_organization_id uuid, p_title text, p_body text, p_id uuid default null,
  p_lede text default null, p_category text default 'city',
  p_tags text[] default null, p_cover_url text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_auteur uuid; v_statut text;
begin
  if not is_org_member(p_organization_id) then
    raise exception 'Réservé à la rédaction';
  end if;
  perform require_active_profile();

  if p_id is null then
    insert into news_articles (organization_id, author_id, title, lede, body, category, tags, cover_url)
    values (p_organization_id, auth.uid(), trim(p_title), nullif(trim(coalesce(p_lede, '')), ''),
            p_body, coalesce(p_category, 'city'), coalesce(p_tags, '{}'),
            nullif(trim(coalesce(p_cover_url, '')), ''))
    returning id into v_id;
  else
    select author_id, status into v_auteur, v_statut from news_articles where id = p_id;
    if v_auteur is null then raise exception 'Article introuvable'; end if;
    -- Un journaliste écrit ses articles ; le rédacteur en chef peut corriger
    -- ceux de sa rédaction, y compris après publication (une coquille dans un
    -- titre publié doit pouvoir se rattraper).
    if v_auteur <> auth.uid() and not is_org_manager(p_organization_id) then
      raise exception 'Cet article n''est pas le vôtre';
    end if;
    if v_statut = 'published' and not is_org_manager(p_organization_id) then
      raise exception 'Un article publié ne se modifie que par la rédaction en chef';
    end if;

    update news_articles set
      title = trim(p_title),
      lede = nullif(trim(coalesce(p_lede, '')), ''),
      body = p_body,
      category = coalesce(p_category, category),
      tags = coalesce(p_tags, tags),
      cover_url = nullif(trim(coalesce(p_cover_url, '')), '')
    where id = p_id
    returning id into v_id;
  end if;
  return v_id;
end;
$function$;

create or replace function news_set_status(
  p_id uuid, p_status text, p_breaking boolean default null, p_featured boolean default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_org uuid; v_auteur uuid; v_titre text; v_etait text;
begin
  select organization_id, author_id, title, status
    into v_org, v_auteur, v_titre, v_etait
  from news_articles where id = p_id;
  if v_org is null then raise exception 'Article introuvable'; end if;
  if p_status not in ('draft','review','published','archived') then
    raise exception 'Statut invalide';
  end if;

  -- Proposer son article à la relecture est un geste de journaliste ; publier,
  -- mettre à la une ou déclarer une alerte engage le journal et n'appartient
  -- qu'à la rédaction en chef.
  if p_status in ('draft', 'review') then
    if v_auteur <> auth.uid() and not is_org_manager(v_org) then
      raise exception 'Cet article n''est pas le vôtre';
    end if;
  elsif not is_org_manager(v_org) then
    raise exception 'Réservé à la rédaction en chef';
  end if;

  if (p_breaking is not null or p_featured is not null) and not is_org_manager(v_org) then
    raise exception 'Réservé à la rédaction en chef';
  end if;

  update news_articles set
    status = p_status,
    published_at = case when p_status = 'published' and published_at is null then now() else published_at end,
    is_breaking = coalesce(p_breaking, is_breaking),
    is_featured = coalesce(p_featured, is_featured)
  where id = p_id;

  -- Une alerte qui n'alerte personne n'est pas une alerte. Seule la première
  -- publication déclenche la notification : rouvrir puis republier un article
  -- ne doit pas resonner toute la ville.
  if p_status = 'published' and v_etait <> 'published' and coalesce(p_breaking, false) then
    perform notify_all_staff('news_breaking', 'Alerte info', v_titre, '/news', false);
  end if;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Lecture
-- ----------------------------------------------------------------------------
create or replace function news_feed(
  p_category text default null, p_query text default null, p_limit int default 40
)
returns table (
  id uuid, organization_id uuid, journal text, title text, lede text, cover_url text,
  category text, tags text[], is_breaking boolean, is_featured boolean,
  published_at timestamptz, author_name text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_q text := lower(trim(coalesce(p_query, '')));
begin
  return query
    select a.id, a.organization_id, g.name, a.title, a.lede, a.cover_url,
           a.category, a.tags, a.is_breaking, a.is_featured, a.published_at, p.display_name
    from news_articles a
    join organizations g on g.id = a.organization_id
    join profiles p on p.id = a.author_id
    where a.status = 'published'
      and (p_category is null or a.category = p_category)
      and (v_q = '' or lower(a.title) like '%' || v_q || '%'
           or lower(coalesce(a.lede, '')) like '%' || v_q || '%'
           or v_q = any (select lower(t) from unnest(a.tags) t))
    order by a.is_breaking desc, a.published_at desc
    limit least(coalesce(p_limit, 40), 100);
end;
$function$;

create or replace function news_article(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_res jsonb;
begin
  select jsonb_build_object(
    'id', a.id, 'title', a.title, 'lede', a.lede, 'body', a.body,
    'cover_url', a.cover_url, 'category', a.category, 'tags', a.tags,
    'is_breaking', a.is_breaking, 'published_at', a.published_at, 'status', a.status,
    'journal', g.name, 'organization_id', a.organization_id,
    'author_name', p.display_name
  ) into v_res
  from news_articles a
  join organizations g on g.id = a.organization_id
  join profiles p on p.id = a.author_id
  where a.id = p_id and (a.status = 'published' or is_org_member(a.organization_id));

  if v_res is null then raise exception 'Article introuvable'; end if;
  return v_res;
end;
$function$;

-- La rédaction voit tout ce qui n'est pas encore publié, dans l'ordre de
-- travail : ce qui attend une relecture d'abord.
create or replace function news_newsroom(p_organization_id uuid)
returns table (id uuid, title text, category text, status text, is_breaking boolean,
               is_featured boolean, author_name text, author_id uuid,
               created_at timestamptz, published_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_org_member(p_organization_id) then
    raise exception 'Réservé à la rédaction';
  end if;
  return query
    select a.id, a.title, a.category, a.status, a.is_breaking, a.is_featured,
           p.display_name, a.author_id, a.created_at, a.published_at
    from news_articles a
    join profiles p on p.id = a.author_id
    where a.organization_id = p_organization_id
    order by case a.status when 'review' then 0 when 'draft' then 1
                           when 'published' then 2 else 3 end,
             a.updated_at desc
    limit 200;
end;
$function$;

update app_registry set status = 'live', admin_route = null where slug = 'news';

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

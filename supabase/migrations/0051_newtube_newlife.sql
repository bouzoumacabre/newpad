-- ############################################################################
-- 0051 — NEWTUBE (§35) ET NEWLIFE (§41)
-- ############################################################################
-- Les deux se posent sur le socle d'engagement (0049) : ni l'une ni l'autre ne
-- recompte les vues, les réactions ou les commentaires. Elles n'apportent que
-- ce qui leur est propre — des chaînes et des vidéos d'un côté, des
-- publications et un fil de l'autre.
--
-- Une chaîne NewTube peut appartenir à une personne OU à une organisation :
-- le journal a sa chaîne comme le particulier a la sienne, sans table de plus.
-- ############################################################################

-- ============================================================================
-- NEWTUBE
-- ============================================================================
create table if not exists tube_channels (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  organization_id uuid references organizations(id) on delete set null,
  name text not null,
  slug text not null unique,
  description text,
  avatar_url text,
  banner_url text,
  created_at timestamptz not null default now(),
  constraint channel_name_len check (length(trim(name)) between 2 and 60),
  constraint channel_slug_format check (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])$')
);

create table if not exists tube_videos (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references tube_channels(id) on delete cascade,
  title text not null,
  description text,
  video_url text not null,
  thumbnail_url text,
  duration_seconds int,
  status text not null default 'published',
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint video_title_len check (length(trim(title)) between 2 and 140),
  constraint video_status_check check (status in ('published','unlisted','removed')),
  constraint video_url_format check (video_url ~ '^https?://')
);

create table if not exists tube_subscriptions (
  channel_id uuid not null references tube_channels(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (channel_id, profile_id)
);

create index if not exists idx_tube_videos_channel on tube_videos(channel_id, published_at desc);
create index if not exists idx_tube_videos_pub on tube_videos(status, published_at desc);

-- Définie AVANT les policies qui la citent : une policy qui référence une
-- fonction inexistante fait échouer la migration entière (constaté au premier
-- essai). Nom sans souligné, comme toute fonction citée par une policy (0043).
create or replace function channel_owner(p_channel_id uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select owner_id from tube_channels where id = p_channel_id;
$function$;

alter table tube_channels enable row level security;
alter table tube_videos enable row level security;
alter table tube_subscriptions enable row level security;

drop policy if exists tube_channels_select on tube_channels;
create policy tube_channels_select on tube_channels
  for select to authenticated, anon using (true);

-- Une vidéo retirée disparaît pour tout le monde sauf sa chaîne : le créateur
-- doit pouvoir constater qu'elle est bien retirée, et la remettre en ligne.
drop policy if exists tube_videos_select on tube_videos;
create policy tube_videos_select on tube_videos
  for select to authenticated, anon
  using (status <> 'removed' or channel_owner(channel_id) = auth.uid());

drop policy if exists tube_subs_select on tube_subscriptions;
create policy tube_subs_select on tube_subscriptions
  for select to authenticated, anon using (true);

create or replace function tube_save_channel(
  p_name text, p_slug text, p_description text default null,
  p_avatar_url text default null, p_organization_id uuid default null, p_id uuid default null
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
  if p_organization_id is not null and not is_org_manager(p_organization_id) then
    raise exception 'Réservé à la direction de l''organisation';
  end if;

  if p_id is null then
    insert into tube_channels (owner_id, organization_id, name, slug, description, avatar_url)
    values (auth.uid(), p_organization_id, trim(p_name), lower(trim(p_slug)),
            nullif(trim(coalesce(p_description, '')), ''), nullif(trim(coalesce(p_avatar_url, '')), ''))
    returning id into v_id;
  else
    if channel_owner(p_id) is distinct from auth.uid() then
      raise exception 'Cette chaîne n''est pas la vôtre';
    end if;
    update tube_channels set
      name = trim(p_name), slug = lower(trim(p_slug)),
      description = nullif(trim(coalesce(p_description, '')), ''),
      avatar_url = nullif(trim(coalesce(p_avatar_url, '')), '')
    where id = p_id returning id into v_id;
  end if;
  return v_id;
end;
$function$;

create or replace function tube_publish_video(
  p_channel_id uuid, p_title text, p_video_url text,
  p_description text default null, p_thumbnail_url text default null,
  p_duration int default null, p_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_abonne record; v_chaine text;
begin
  if channel_owner(p_channel_id) is distinct from auth.uid() then
    raise exception 'Cette chaîne n''est pas la vôtre';
  end if;
  perform require_active_profile();

  if p_id is null then
    insert into tube_videos (channel_id, title, description, video_url, thumbnail_url, duration_seconds)
    values (p_channel_id, trim(p_title), nullif(trim(coalesce(p_description, '')), ''),
            trim(p_video_url), nullif(trim(coalesce(p_thumbnail_url, '')), ''), p_duration)
    returning id into v_id;

    -- Une chaîne sans notification à ses abonnés n'a pas d'abonnés : c'est
    -- exactement ce que l'abonnement promet.
    select name into v_chaine from tube_channels where id = p_channel_id;
    for v_abonne in select profile_id from tube_subscriptions where channel_id = p_channel_id loop
      perform notify(v_abonne.profile_id, 'tube_video', v_chaine, trim(p_title), '/youtube');
    end loop;
  else
    update tube_videos set
      title = trim(p_title), description = nullif(trim(coalesce(p_description, '')), ''),
      video_url = trim(p_video_url), thumbnail_url = nullif(trim(coalesce(p_thumbnail_url, '')), ''),
      duration_seconds = coalesce(p_duration, duration_seconds)
    where id = p_id and channel_id = p_channel_id
    returning id into v_id;
    if v_id is null then raise exception 'Vidéo introuvable'; end if;
  end if;
  return v_id;
end;
$function$;

create or replace function tube_set_video_status(p_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_chaine uuid;
begin
  select channel_id into v_chaine from tube_videos where id = p_id;
  if v_chaine is null then raise exception 'Vidéo introuvable'; end if;
  -- L'administration Newpad peut retirer une vidéo : c'est la modération (§35).
  if channel_owner(v_chaine) is distinct from auth.uid() and not is_newpad_admin() then
    raise exception 'Cette vidéo n''est pas la vôtre';
  end if;
  if p_status not in ('published','unlisted','removed') then raise exception 'Statut invalide'; end if;
  update tube_videos set status = p_status where id = p_id;
end;
$function$;

create or replace function tube_subscribe(p_channel_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'Connectez-vous pour vous abonner'; end if;
  perform require_active_profile();
  if channel_owner(p_channel_id) = auth.uid() then
    raise exception 'Vous ne pouvez pas vous abonner à votre propre chaîne';
  end if;

  if exists (select 1 from tube_subscriptions where channel_id = p_channel_id and profile_id = auth.uid()) then
    delete from tube_subscriptions where channel_id = p_channel_id and profile_id = auth.uid();
    return false;
  end if;
  insert into tube_subscriptions (channel_id, profile_id) values (p_channel_id, auth.uid());
  insert into analytics_events (app_slug, entity_type, entity_id, event_type, actor_id)
  values ('youtube', 'tube_channel', p_channel_id, 'subscribe', auth.uid());
  return true;
end;
$function$;

create or replace function tube_feed(p_query text default null, p_channel_id uuid default null)
returns table (id uuid, channel_id uuid, chaine text, chaine_slug text, avatar_url text,
               title text, description text, video_url text, thumbnail_url text,
               duration_seconds int, status text, published_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_q text := lower(trim(coalesce(p_query, '')));
begin
  return query
    select v.id, v.channel_id, c.name, c.slug, c.avatar_url, v.title, v.description,
           v.video_url, v.thumbnail_url, v.duration_seconds, v.status, v.published_at
    from tube_videos v
    join tube_channels c on c.id = v.channel_id
    where (v.status = 'published' or (p_channel_id is not null and c.owner_id = auth.uid()))
      and (p_channel_id is null or v.channel_id = p_channel_id)
      and (v_q = '' or lower(v.title) like '%' || v_q || '%' or lower(c.name) like '%' || v_q || '%')
    order by v.published_at desc
    limit 60;
end;
$function$;

create or replace function tube_channel_info(p_channel_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v jsonb;
begin
  select jsonb_build_object(
    'id', c.id, 'name', c.name, 'slug', c.slug, 'description', c.description,
    'avatar_url', c.avatar_url, 'owner_id', c.owner_id,
    'abonnes', (select count(*) from tube_subscriptions s where s.channel_id = c.id),
    'je_suis_abonne', exists (select 1 from tube_subscriptions s
                              where s.channel_id = c.id and s.profile_id = auth.uid()),
    'nb_videos', (select count(*) from tube_videos v where v.channel_id = c.id and v.status = 'published')
  ) into v from tube_channels c where c.id = p_channel_id;
  if v is null then raise exception 'Chaîne introuvable'; end if;
  return v;
end;
$function$;

create or replace function tube_my_channels()
returns table (id uuid, name text, slug text, avatar_url text, nb_videos int, abonnes int)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  return query
    select c.id, c.name, c.slug, c.avatar_url,
           (select count(*)::int from tube_videos v where v.channel_id = c.id),
           (select count(*)::int from tube_subscriptions s where s.channel_id = c.id)
    from tube_channels c where c.owner_id = auth.uid() order by c.name;
end;
$function$;

-- ============================================================================
-- NEWLIFE
-- ============================================================================
create table if not exists life_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references profiles(id) on delete cascade,
  organization_id uuid references organizations(id) on delete set null,
  body text not null,
  media_url text,
  tags text[] not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint life_body_len check (length(trim(body)) between 1 and 1200),
  constraint life_tags_len check (array_length(tags, 1) is null or array_length(tags, 1) <= 8)
);

create table if not exists life_follows (
  follower_id uuid not null references profiles(id) on delete cascade,
  followee_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id),
  constraint life_no_self_follow check (follower_id <> followee_id)
);

create index if not exists idx_life_posts on life_posts(created_at desc) where deleted_at is null;
create index if not exists idx_life_author on life_posts(author_id, created_at desc);

alter table life_posts enable row level security;
alter table life_follows enable row level security;

drop policy if exists life_posts_select on life_posts;
create policy life_posts_select on life_posts
  for select to authenticated, anon using (deleted_at is null);

drop policy if exists life_follows_select on life_follows;
create policy life_follows_select on life_follows
  for select to authenticated, anon using (true);

create or replace function life_publish(
  p_body text, p_media_url text default null, p_organization_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_tags text[];
begin
  if auth.uid() is null then raise exception 'Connectez-vous pour publier'; end if;
  perform require_active_profile();
  if p_organization_id is not null and not is_org_member(p_organization_id) then
    raise exception 'Vous n''êtes pas membre de cette organisation';
  end if;

  -- Les mots-clés sont extraits du texte plutôt que saisis à part : personne ne
  -- remplit un second champ pour répéter ce qu'il vient d'écrire.
  select array_agg(distinct lower(m[1])) into v_tags
  from regexp_matches(p_body, '#([A-Za-zÀ-ÿ0-9_]{2,24})', 'g') m;

  insert into life_posts (author_id, organization_id, body, media_url, tags)
  values (auth.uid(), p_organization_id, trim(p_body),
          nullif(trim(coalesce(p_media_url, '')), ''), coalesce(v_tags, '{}'))
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function life_delete_post(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_auteur uuid;
begin
  select author_id into v_auteur from life_posts where id = p_id;
  if v_auteur is null then raise exception 'Publication introuvable'; end if;
  if v_auteur <> auth.uid() and not is_newpad_admin() then
    raise exception 'Cette publication n''est pas la vôtre';
  end if;
  update life_posts set deleted_at = now() where id = p_id;
end;
$function$;

create or replace function life_follow(p_profile_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_nom text;
begin
  if auth.uid() is null then raise exception 'Connectez-vous pour suivre quelqu''un'; end if;
  perform require_active_profile();
  if p_profile_id = auth.uid() then raise exception 'Vous ne pouvez pas vous suivre vous-même'; end if;

  if exists (select 1 from life_follows where follower_id = auth.uid() and followee_id = p_profile_id) then
    delete from life_follows where follower_id = auth.uid() and followee_id = p_profile_id;
    return false;
  end if;
  insert into life_follows (follower_id, followee_id) values (auth.uid(), p_profile_id);
  select display_name into v_nom from profiles where id = auth.uid();
  perform notify(p_profile_id, 'life_follow', 'Nouvel abonné', v_nom || ' vous suit désormais.', '/life');
  insert into analytics_events (app_slug, entity_type, entity_id, event_type, actor_id)
  values ('life', 'life_profile', p_profile_id, 'follow', auth.uid());
  return true;
end;
$function$;

create or replace function life_feed(
  p_scope text default 'all', p_query text default null, p_author uuid default null
)
returns table (id uuid, author_id uuid, auteur text, organisation text,
               body text, media_url text, tags text[], created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_q text := lower(trim(coalesce(p_query, '')));
begin
  return query
    select p.id, p.author_id, pr.display_name, g.name, p.body, p.media_url, p.tags, p.created_at
    from life_posts p
    join profiles pr on pr.id = p.author_id
    left join organizations g on g.id = p.organization_id
    where p.deleted_at is null
      and (p_author is null or p.author_id = p_author)
      -- « Abonnements » n'a de sens que connecté ; sans session la portée
      -- retombe sur le fil public plutôt que de renvoyer un fil vide.
      and (p_scope <> 'following' or auth.uid() is null
           or p.author_id in (select followee_id from life_follows where follower_id = auth.uid()))
      and (v_q = '' or lower(p.body) like '%' || v_q || '%'
           or replace(v_q, '#', '') = any (select lower(t) from unnest(p.tags) t))
    order by p.created_at desc
    limit 60;
end;
$function$;

create or replace function life_profile_info(p_profile_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v jsonb;
begin
  select jsonb_build_object(
    'id', p.id, 'display_name', p.display_name, 'username', p.username,
    'avatar_url', p.avatar_url, 'bio', p.bio,
    'abonnes', (select count(*) from life_follows f where f.followee_id = p.id),
    'abonnements', (select count(*) from life_follows f where f.follower_id = p.id),
    'publications', (select count(*) from life_posts x where x.author_id = p.id and x.deleted_at is null),
    'je_le_suis', exists (select 1 from life_follows f
                          where f.followee_id = p.id and f.follower_id = auth.uid())
  ) into v from profiles p where p.id = p_profile_id;
  if v is null then raise exception 'Profil introuvable'; end if;
  return v;
end;
$function$;

update app_registry set status = 'live' where slug in ('youtube', 'life');

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

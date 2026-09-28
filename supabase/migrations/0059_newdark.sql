-- ############################################################################
-- 0059 — NEWDARK : l'espace clandestin
-- ############################################################################
-- Application « restreinte » (0045) : l'icône n'apparaît qu'aux personnes
-- autorisées nommément. Mais une icône cachée n'est pas une sécurité : CHAQUE
-- fonction ci-dessous repose la question à `can_open_app('dark')`, et les
-- tables n'ont AUCUNE policy de lecture — même un client autorisé ne peut pas
-- les interroger directement par l'API, seulement par ces fonctions.
--
-- Anonymat : on y parle sous un pseudonyme, choisi une fois et définitif (une
-- réputation doit pouvoir se construire). L'auteur réel reste en base pour la
-- modération, mais aucune fonction ne le renvoie.
--
-- Éphémère : un message disparaît 14 jours après sa publication.
--
-- §90 : aucun paiement. Un « contrat » se règle hors de Newpad.
-- ############################################################################

create table if not exists dark_aliases (
  profile_id uuid primary key references profiles(id) on delete cascade,
  alias text not null,
  created_at timestamptz not null default now(),
  constraint dark_alias_format check (alias ~ '^[A-Za-z0-9_.-]{3,20}$')
);
create unique index if not exists uq_dark_alias on dark_aliases(lower(alias));

create table if not exists dark_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references profiles(id) on delete cascade,
  category text not null default 'divers',
  title text not null,
  body text not null,
  is_removed boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  constraint dark_post_cat check (category in ('contrats','marche','infos','recrutement','divers')),
  constraint dark_post_title_len check (length(trim(title)) between 3 and 100),
  constraint dark_post_body_len check (length(trim(body)) between 1 and 4000)
);
create index if not exists idx_dark_posts on dark_posts(expires_at desc) where not is_removed;

create table if not exists dark_replies (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references dark_posts(id) on delete cascade,
  author_id uuid not null references profiles(id) on delete cascade,
  body text not null,
  is_removed boolean not null default false,
  created_at timestamptz not null default now(),
  constraint dark_reply_body_len check (length(trim(body)) between 1 and 2000)
);
create index if not exists idx_dark_replies on dark_replies(post_id, created_at);

-- RLS actif, AUCUNE policy : refus par défaut pour tout accès direct.
alter table dark_aliases enable row level security;
alter table dark_posts enable row level security;
alter table dark_replies enable row level security;

-- ----------------------------------------------------------------------------
create or replace function dark_require_access()
returns void
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Message volontairement neutre : un refus ne doit pas confirmer que
  -- l'espace existe.
  if not can_open_app('dark') then raise exception 'Accès refusé'; end if;
end;
$function$;

create or replace function dark_my_alias()
returns text
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v text;
begin
  perform dark_require_access();
  select alias into v from dark_aliases where profile_id = auth.uid();
  return v;
end;
$function$;

create or replace function dark_set_alias(p_alias text)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  perform dark_require_access();
  perform require_active_profile();
  if exists (select 1 from dark_aliases where profile_id = auth.uid()) then
    raise exception 'Votre pseudonyme est définitif';
  end if;
  if coalesce(p_alias, '') !~ '^[A-Za-z0-9_.-]{3,20}$' then
    raise exception 'Pseudonyme : 3 à 20 caractères, lettres, chiffres, point, tiret ou soulignement';
  end if;
  insert into dark_aliases (profile_id, alias) values (auth.uid(), p_alias);
  return p_alias;
exception when unique_violation then
  raise exception 'Ce pseudonyme est déjà pris';
end;
$function$;

create or replace function dark_feed(p_category text default null)
returns table (id uuid, category text, title text, excerpt text, alias text, is_mine boolean,
               replies bigint, created_at timestamptz, expires_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  perform dark_require_access();
  return query
    select p.id, p.category, p.title, left(p.body, 180), coalesce(a.alias, 'inconnu'),
           p.author_id = auth.uid(),
           (select count(*) from dark_replies r where r.post_id = p.id and not r.is_removed),
           p.created_at, p.expires_at
    from dark_posts p
    left join dark_aliases a on a.profile_id = p.author_id
    where not p.is_removed and p.expires_at > now()
      and (p_category is null or p_category = '' or p.category = p_category)
    order by p.created_at desc
    limit 100;
end;
$function$;

create or replace function dark_thread(p_post_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v jsonb;
begin
  perform dark_require_access();
  select jsonb_build_object(
    'id', p.id, 'category', p.category, 'title', p.title, 'body', p.body,
    'alias', coalesce(a.alias, 'inconnu'), 'is_mine', p.author_id = auth.uid(),
    'created_at', p.created_at, 'expires_at', p.expires_at,
    'can_moderate', is_newpad_admin(),
    'replies', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'body', r.body, 'alias', coalesce(ra.alias, 'inconnu'),
        'is_mine', r.author_id = auth.uid(), 'created_at', r.created_at) order by r.created_at)
      from dark_replies r left join dark_aliases ra on ra.profile_id = r.author_id
      where r.post_id = p.id and not r.is_removed), '[]'::jsonb)
  ) into v
  from dark_posts p
  left join dark_aliases a on a.profile_id = p.author_id
  where p.id = p_post_id and not p.is_removed and p.expires_at > now();
  if v is null then raise exception 'Message introuvable ou effacé'; end if;
  return v;
end;
$function$;

create or replace function dark_post(p_category text, p_title text, p_body text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid;
begin
  perform dark_require_access();
  perform require_active_profile();
  if not exists (select 1 from dark_aliases where profile_id = auth.uid()) then
    raise exception 'Choisissez d''abord un pseudonyme';
  end if;
  -- Frein au flood : 5 messages par heure.
  if (select count(*) from dark_posts where author_id = auth.uid()
        and created_at > now() - interval '1 hour') >= 5 then
    raise exception 'Trop de messages : réessayez plus tard';
  end if;
  insert into dark_posts (author_id, category, title, body)
  values (auth.uid(), coalesce(nullif(p_category, ''), 'divers'), trim(p_title), trim(p_body))
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function dark_reply(p_post_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_auteur uuid;
begin
  perform dark_require_access();
  perform require_active_profile();
  if not exists (select 1 from dark_aliases where profile_id = auth.uid()) then
    raise exception 'Choisissez d''abord un pseudonyme';
  end if;
  select author_id into v_auteur from dark_posts
   where id = p_post_id and not is_removed and expires_at > now();
  if v_auteur is null then raise exception 'Message introuvable ou effacé'; end if;
  if (select count(*) from dark_replies where author_id = auth.uid()
        and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Trop de réponses : réessayez plus tard';
  end if;

  insert into dark_replies (post_id, author_id, body) values (p_post_id, auth.uid(), trim(p_body))
  returning id into v_id;
  -- Notification sans contenu ni pseudonyme : un écran de téléphone se lit
  -- par-dessus l'épaule.
  if v_auteur <> auth.uid() then
    perform notify(v_auteur, 'dark', 'Nouveau message', null, '/dark');
  end if;
  return v_id;
end;
$function$;

create or replace function dark_remove(p_kind text, p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_auteur uuid;
begin
  perform dark_require_access();
  if p_kind = 'post' then
    select author_id into v_auteur from dark_posts where id = p_id;
  elsif p_kind = 'reply' then
    select author_id into v_auteur from dark_replies where id = p_id;
  else
    raise exception 'Type invalide';
  end if;
  if v_auteur is null then raise exception 'Message introuvable'; end if;
  if v_auteur <> auth.uid() and not is_newpad_admin() then
    raise exception 'Ce message n''est pas le vôtre';
  end if;
  if p_kind = 'post' then update dark_posts set is_removed = true where id = p_id;
  else update dark_replies set is_removed = true where id = p_id; end if;
end;
$function$;

update app_registry set status = 'live' where slug = 'dark';

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

revoke execute on function dark_require_access() from public, anon;
revoke execute on function dark_my_alias() from public, anon;
revoke execute on function dark_set_alias(text) from public, anon;
revoke execute on function dark_feed(text) from public, anon;
revoke execute on function dark_thread(uuid) from public, anon;
revoke execute on function dark_post(text, text, text) from public, anon;
revoke execute on function dark_reply(uuid, text) from public, anon;
revoke execute on function dark_remove(text, uuid) from public, anon;

grant execute on function dark_require_access() to authenticated;
grant execute on function dark_my_alias() to authenticated;
grant execute on function dark_set_alias(text) to authenticated;
grant execute on function dark_feed(text) to authenticated;
grant execute on function dark_thread(uuid) to authenticated;
grant execute on function dark_post(text, text, text) to authenticated;
grant execute on function dark_reply(uuid, text) to authenticated;
grant execute on function dark_remove(text, uuid) to authenticated;

-- ############################################################################
-- 0049 — SOCLE D'ENGAGEMENT : VUES, RÉACTIONS, COMMENTAIRES (§14, §15)
-- ############################################################################
-- News24, NewTube, NewLife, NewEvent et NewMarket ont tous besoin des mêmes
-- trois choses : compter les vues, recevoir des « j'aime », porter des
-- commentaires. Et SACEM (§51, §52) devra ensuite LIRE ces chiffres sans les
-- ressaisir.
--
-- Écrire trois fois la même mécanique garantirait trois comportements
-- différents au premier correctif, et obligerait SACEM à connaître trois
-- formats. Le socle est donc posé une fois, au-dessus d'un couple
-- (entity_type, entity_id) volontairement générique : une vidéo, un article,
-- une publication et une annonce s'y rangent de la même façon.
-- ############################################################################

create table if not exists analytics_events (
  id bigserial primary key,
  app_slug text not null,
  entity_type text not null,
  entity_id uuid,
  event_type text not null,
  actor_id uuid references profiles(id) on delete set null,
  session_id text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  constraint analytics_event_type_check check (event_type in (
    'view','click','like','unlike','reaction','comment','share',
    'follow','subscribe','registration','conversion','impression'
  ))
);
comment on table analytics_events is
  'Journal d''audience commun à toutes les applications. En écriture seule : on n''y corrige rien, on y ajoute.';

create index if not exists idx_analytics_entity on analytics_events(entity_type, entity_id, event_type);
create index if not exists idx_analytics_app on analytics_events(app_slug, created_at desc);

create table if not exists content_reactions (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  actor_id uuid not null references profiles(id) on delete cascade,
  reaction text not null default 'like',
  created_at timestamptz not null default now(),
  unique (entity_type, entity_id, actor_id),
  constraint reaction_check check (reaction in ('like','love','laugh','sad','angry'))
);

create table if not exists content_comments (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  author_id uuid not null references profiles(id) on delete cascade,
  body text not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint comment_len check (length(trim(body)) between 1 and 2000)
);

create index if not exists idx_reactions_entity on content_reactions(entity_type, entity_id);
create index if not exists idx_comments_entity on content_comments(entity_type, entity_id, created_at desc);

alter table analytics_events enable row level security;
alter table content_reactions enable row level security;
alter table content_comments enable row level security;

-- Le journal d'audience n'a AUCUNE policy de lecture, délibérément : les
-- chiffres s'obtiennent agrégés, par fonction. Ouvrir la lecture ligne à ligne
-- reviendrait à publier qui a regardé quoi et à quelle heure.

-- Réactions et commentaires sont publics : c'est ce qui en fait une audience.
-- Ils restent lisibles par les invités, sans quoi un article commenté
-- apparaîtrait vide à un visiteur.
drop policy if exists content_reactions_select on content_reactions;
create policy content_reactions_select on content_reactions
  for select to authenticated, anon using (true);

drop policy if exists content_comments_select on content_comments;
create policy content_comments_select on content_comments
  for select to authenticated, anon using (deleted_at is null);

-- ----------------------------------------------------------------------------
-- Écriture
-- ----------------------------------------------------------------------------
-- `track_event` est appelable SANS COMPTE : compter les spectateurs d'une vidéo
-- est précisément le travail d'une application à audience. Elle n'accepte donc
-- que des types connus et n'écrit jamais d'identité qu'on ne lui a pas donnée.
create or replace function track_event(
  p_app_slug text, p_entity_type text, p_entity_id uuid,
  p_event_type text default 'view', p_metadata jsonb default '{}'
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if p_event_type not in ('view','click','impression','share') then
    -- Les événements qui engagent une personne (j'aime, commentaire,
    -- abonnement) ne passent pas par ici : ils sont écrits par les fonctions
    -- qui les produisent réellement, avec l'identité vérifiée.
    raise exception 'Type d''événement non déclarable directement';
  end if;
  insert into analytics_events (app_slug, entity_type, entity_id, event_type, actor_id, metadata)
  values (left(coalesce(p_app_slug, 'newpad'), 40), left(p_entity_type, 40), p_entity_id,
          p_event_type, auth.uid(), coalesce(p_metadata, '{}'));
end;
$function$;

create or replace function react(p_entity_type text, p_entity_id uuid, p_reaction text default 'like')
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_existe text;
begin
  if auth.uid() is null then raise exception 'Connectez-vous pour réagir'; end if;
  perform require_active_profile();

  select reaction into v_existe from content_reactions
  where entity_type = p_entity_type and entity_id = p_entity_id and actor_id = auth.uid();

  -- Recliquer sur la même réaction la retire : c'est le geste attendu, et ça
  -- évite une seconde fonction qui ferait exactement l'inverse.
  if v_existe is not null and v_existe = coalesce(p_reaction, 'like') then
    delete from content_reactions
    where entity_type = p_entity_type and entity_id = p_entity_id and actor_id = auth.uid();
    insert into analytics_events (app_slug, entity_type, entity_id, event_type, actor_id)
    values ('newpad', p_entity_type, p_entity_id, 'unlike', auth.uid());
    return false;
  end if;

  insert into content_reactions (entity_type, entity_id, actor_id, reaction)
  values (p_entity_type, p_entity_id, auth.uid(), coalesce(p_reaction, 'like'))
  on conflict (entity_type, entity_id, actor_id)
  do update set reaction = excluded.reaction;

  insert into analytics_events (app_slug, entity_type, entity_id, event_type, actor_id)
  values ('newpad', p_entity_type, p_entity_id, 'like', auth.uid());
  return true;
end;
$function$;

create or replace function post_comment(p_entity_type text, p_entity_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Connectez-vous pour commenter'; end if;
  perform require_active_profile();

  insert into content_comments (entity_type, entity_id, author_id, body)
  values (p_entity_type, p_entity_id, auth.uid(), trim(p_body))
  returning id into v_id;

  insert into analytics_events (app_slug, entity_type, entity_id, event_type, actor_id)
  values ('newpad', p_entity_type, p_entity_id, 'comment', auth.uid());
  return v_id;
end;
$function$;

-- Un commentaire se retire par son auteur, ou par l'administration Newpad en
-- modération. Il n'est pas effacé : une suppression physique ferait disparaître
-- la trace d'un propos qu'on a précisément eu besoin de modérer.
create or replace function delete_comment(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_auteur uuid;
begin
  select author_id into v_auteur from content_comments where id = p_id;
  if v_auteur is null then raise exception 'Commentaire introuvable'; end if;
  if v_auteur <> auth.uid() and not is_newpad_admin() then
    raise exception 'Vous ne pouvez retirer que vos propres commentaires';
  end if;
  update content_comments set deleted_at = now() where id = p_id;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Lecture agrégée — le seul chemin vers les chiffres. SACEM s'en servira tel
-- quel : une œuvre liée à une vidéo lira les statistiques de cette vidéo sans
-- jamais les ressaisir (§51).
-- ----------------------------------------------------------------------------
create or replace function content_stats(p_entity_type text, p_entity_ids uuid[])
returns table (entity_id uuid, vues bigint, reactions bigint, commentaires bigint, ma_reaction text)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  return query
    select e.id,
      (select count(*) from analytics_events a
        where a.entity_type = p_entity_type and a.entity_id = e.id and a.event_type = 'view'),
      (select count(*) from content_reactions r
        where r.entity_type = p_entity_type and r.entity_id = e.id),
      (select count(*) from content_comments c
        where c.entity_type = p_entity_type and c.entity_id = e.id and c.deleted_at is null),
      (select r.reaction from content_reactions r
        where r.entity_type = p_entity_type and r.entity_id = e.id and r.actor_id = auth.uid())
    from unnest(p_entity_ids) as e(id);
end;
$function$;

create or replace function list_comments(p_entity_type text, p_entity_id uuid)
returns table (id uuid, author_id uuid, display_name text, body text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  return query
    select c.id, c.author_id, p.display_name, c.body, c.created_at
    from content_comments c
    join profiles p on p.id = c.author_id
    where c.entity_type = p_entity_type and c.entity_id = p_entity_id and c.deleted_at is null
    order by c.created_at
    limit 200;
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
grant execute on function can_open_app(text) to anon;
-- Un visiteur sans compte compte dans l'audience : c'est tout l'objet des
-- applications de niveau invité.
grant execute on function track_event(text, text, uuid, text, jsonb) to anon;
grant execute on function content_stats(text, uuid[]) to anon;
grant execute on function list_comments(text, uuid) to anon;

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

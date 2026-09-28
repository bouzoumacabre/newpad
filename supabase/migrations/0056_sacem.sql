-- ############################################################################
-- 0056 — SACEM : LE DÉPÔT DES ŒUVRES ET LE PARTAGE DES DROITS
-- ############################################################################
-- Une société de droits d'auteur ne gère pas de la musique : elle gère des
-- PARTS. Deux personnes écrivent un morceau, une troisième le produit, et la
-- seule question qui compte est « qui détient quoi ». Tout le reste — la
-- fiche, le genre, la pochette — est de la décoration autour de ce registre.
--
-- D'où la table centrale : `music_work_shares`, dont la somme doit faire 100.
-- La vérification est en base, dans la même transaction que l'écriture des
-- parts : un dépôt dont les parts ne tombent pas juste n'existe jamais, même
-- une milliseconde.
--
-- Le lien avec NewTube (§52) ne duplique rien : déclarer qu'une vidéo utilise
-- une œuvre crée une LIGNE DE LIAISON, et les écoutes se comptent là où elles
-- se produisent — dans `analytics_events`, sur la vidéo.
--
-- §90 : aucune répartition d'argent. La SACEM de Newpad dit qui détient quoi
-- et combien l'œuvre a été écoutée ; ce que ça vaut se règle en jeu.
-- ############################################################################

create sequence if not exists music_work_seq;

-- ----------------------------------------------------------------------------
-- Les artistes
-- ----------------------------------------------------------------------------
-- Un artiste est un profil qui a pris un nom de scène. Ce n'est pas un
-- deuxième compte : c'est la même personne, avec un nom d'affiche (§11).
create table if not exists music_artists (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null unique references profiles(id) on delete cascade,
  organization_id uuid references organizations(id) on delete set null,
  stage_name text not null,
  slug text not null unique,
  bio text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint music_artist_name_len check (length(trim(stage_name)) between 2 and 60),
  constraint music_artist_slug_format check (slug ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])$'),
  constraint music_artist_bio_len check (bio is null or length(bio) <= 1000)
);

create index if not exists idx_music_artist_label on music_artists(organization_id);

drop trigger if exists trg_music_artist_touch on music_artists;
create trigger trg_music_artist_touch before update on music_artists
  for each row execute function _touch_updated_at();

alter table music_artists enable row level security;

drop policy if exists music_artists_select on music_artists;
create policy music_artists_select on music_artists
  for select to authenticated using (true);

-- ----------------------------------------------------------------------------
-- Les œuvres
-- ----------------------------------------------------------------------------
create table if not exists music_works (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  title text not null,
  depositor_id uuid not null references music_artists(id) on delete cascade,
  organization_id uuid references organizations(id) on delete set null,
  genre text,
  duration_seconds int,
  release_date date,
  cover_url text,
  status text not null default 'registered',
  dispute_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint music_work_title_len check (length(trim(title)) between 1 and 120),
  constraint music_work_genre_len check (genre is null or length(genre) <= 40),
  constraint music_work_duration check (duration_seconds is null or duration_seconds between 1 and 36000),
  constraint music_work_status check (status in ('registered','disputed','withdrawn'))
);

create index if not exists idx_music_work_dep on music_works(depositor_id, created_at desc);
create index if not exists idx_music_work_status on music_works(status, created_at desc);

drop trigger if exists trg_music_work_touch on music_works;
create trigger trg_music_work_touch before update on music_works
  for each row execute function _touch_updated_at();

alter table music_works enable row level security;

-- Le registre est public à l'intérieur de Newpad : c'est le principe même
-- d'un dépôt. Savoir qui détient une œuvre ne sert à rien si c'est secret.
drop policy if exists music_works_select on music_works;
create policy music_works_select on music_works
  for select to authenticated using (true);

create table if not exists music_work_shares (
  work_id uuid not null references music_works(id) on delete cascade,
  artist_id uuid not null references music_artists(id) on delete cascade,
  share numeric(5,2) not null,
  role text not null default 'auteur',
  primary key (work_id, artist_id, role),
  constraint music_share_range check (share > 0 and share <= 100),
  constraint music_share_role check (role in ('auteur','compositeur','interprete','producteur'))
);

create index if not exists idx_music_share_artist on music_work_shares(artist_id);

alter table music_work_shares enable row level security;

drop policy if exists music_shares_select on music_work_shares;
create policy music_shares_select on music_work_shares
  for select to authenticated using (true);

-- ----------------------------------------------------------------------------
-- Les utilisations déclarées
-- ----------------------------------------------------------------------------
-- Une utilisation relie une œuvre à un contenu déjà existant ailleurs dans
-- Newpad — une vidéo NewTube, un événement, un article. On ne recopie ni le
-- contenu ni ses compteurs : l'audience se lit là où elle se produit.
create table if not exists music_uses (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references music_works(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  declared_by uuid not null references profiles(id) on delete cascade,
  note text,
  created_at timestamptz not null default now(),
  unique (work_id, entity_type, entity_id),
  constraint music_use_entity check (entity_type in ('tube_video','event','news_article','life_post')),
  constraint music_use_note_len check (note is null or length(note) <= 300)
);

create index if not exists idx_music_use_work on music_uses(work_id, created_at desc);
create index if not exists idx_music_use_entity on music_uses(entity_type, entity_id);

alter table music_uses enable row level security;

drop policy if exists music_uses_select on music_uses;
create policy music_uses_select on music_uses
  for select to authenticated using (true);

-- Fonctions citées par des policies ou par les contrôles : sans préfixe
-- interne (leçon de 0043).
create or replace function artist_profile(p_artist_id uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select profile_id from music_artists where id = p_artist_id;
$function$;

create or replace function my_artist_id()
returns uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select id from music_artists where profile_id = auth.uid();
$function$;

-- ----------------------------------------------------------------------------
-- S'enregistrer comme artiste
-- ----------------------------------------------------------------------------
create or replace function sacem_register_artist(
  p_stage_name text, p_slug text default null, p_bio text default null,
  p_avatar_url text default null, p_organization_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_slug text;
begin
  perform require_active_profile();
  if p_organization_id is not null and not is_org_member(p_organization_id) then
    raise exception 'Vous ne faites pas partie de ce label';
  end if;

  v_slug := lower(regexp_replace(coalesce(nullif(trim(p_slug), ''), trim(p_stage_name)),
                                 '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug := trim(both '-' from v_slug);
  if v_slug = '' then raise exception 'Nom de scène invalide'; end if;

  select id into v_id from music_artists where profile_id = auth.uid();
  if v_id is null then
    insert into music_artists (profile_id, organization_id, stage_name, slug, bio, avatar_url)
    values (auth.uid(), p_organization_id, trim(p_stage_name), v_slug,
            nullif(trim(coalesce(p_bio, '')), ''), nullif(trim(coalesce(p_avatar_url, '')), ''))
    returning id into v_id;
  else
    update music_artists set
      stage_name = trim(p_stage_name),
      slug = v_slug,
      bio = nullif(trim(coalesce(p_bio, '')), ''),
      avatar_url = nullif(trim(coalesce(p_avatar_url, '')), ''),
      organization_id = p_organization_id
    where id = v_id;
  end if;
  return v_id;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Déposer une œuvre
-- ----------------------------------------------------------------------------
-- p_shares : [{artist_id, share, role}]. Le déposant est ajouté d'office s'il
-- n'y figure pas, et la somme doit faire exactement 100.
create or replace function sacem_save_work(
  p_title text, p_shares jsonb, p_id uuid default null,
  p_genre text default null, p_duration_seconds int default null,
  p_release_date date default null, p_cover_url text default null,
  p_organization_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid; v_moi uuid; v_ref text; v_total numeric := 0;
  v_part jsonb; v_artiste uuid; v_deposant uuid; v_statut text;
begin
  perform require_active_profile();
  v_moi := my_artist_id();
  if v_moi is null then
    raise exception 'Enregistrez-vous comme artiste avant de déposer une œuvre';
  end if;
  if p_organization_id is not null and not is_org_member(p_organization_id) then
    raise exception 'Vous ne faites pas partie de ce label';
  end if;

  if p_shares is null or jsonb_typeof(p_shares) <> 'array'
     or jsonb_array_length(p_shares) = 0 then
    raise exception 'Indiquez au moins une part';
  end if;
  if jsonb_array_length(p_shares) > 12 then
    raise exception 'Douze ayants droit au maximum';
  end if;

  -- Les parts doivent tomber juste, et chaque bénéficiaire doit exister.
  for v_part in select * from jsonb_array_elements(p_shares) loop
    v_artiste := (v_part ->> 'artist_id')::uuid;
    if v_artiste is null or not exists (select 1 from music_artists where id = v_artiste) then
      raise exception 'Ayant droit inconnu';
    end if;
    if coalesce((v_part ->> 'share')::numeric, 0) <= 0 then
      raise exception 'Une part doit être strictement positive';
    end if;
    v_total := v_total + (v_part ->> 'share')::numeric;
  end loop;
  if round(v_total, 2) <> 100 then
    raise exception 'La somme des parts fait % au lieu de 100', round(v_total, 2);
  end if;

  if p_id is null then
    v_ref := 'SCM-' || to_char(now(), 'YYYY') || '-'
             || lpad(nextval('music_work_seq')::text, 6, '0');
    insert into music_works (reference, title, depositor_id, organization_id, genre,
                             duration_seconds, release_date, cover_url)
    values (v_ref, trim(p_title), v_moi, p_organization_id,
            nullif(trim(coalesce(p_genre, '')), ''), p_duration_seconds, p_release_date,
            nullif(trim(coalesce(p_cover_url, '')), ''))
    returning id into v_id;
  else
    select depositor_id, status into v_deposant, v_statut from music_works where id = p_id;
    if v_deposant is null then raise exception 'Œuvre introuvable'; end if;
    if v_deposant <> v_moi then raise exception 'Ce dépôt n''est pas le vôtre'; end if;
    -- Une œuvre contestée est gelée : c'est l'intérêt d'avoir un registre.
    if v_statut = 'disputed' then
      raise exception 'Cette œuvre est contestée : elle ne se modifie plus tant que le litige dure';
    end if;

    update music_works set
      title = trim(p_title),
      genre = nullif(trim(coalesce(p_genre, '')), ''),
      duration_seconds = p_duration_seconds,
      release_date = p_release_date,
      cover_url = nullif(trim(coalesce(p_cover_url, '')), ''),
      organization_id = p_organization_id
    where id = p_id
    returning id into v_id;
    delete from music_work_shares where work_id = v_id;
  end if;

  for v_part in select * from jsonb_array_elements(p_shares) loop
    insert into music_work_shares (work_id, artist_id, share, role)
    values (v_id, (v_part ->> 'artist_id')::uuid,
            (v_part ->> 'share')::numeric,
            coalesce(nullif(v_part ->> 'role', ''), 'auteur'))
    on conflict (work_id, artist_id, role) do update set share = excluded.share;
  end loop;

  return v_id;
end;
$function$;

create or replace function sacem_set_work_status(
  p_id uuid, p_status text, p_note text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_deposant uuid; v_moi uuid;
begin
  perform require_active_profile();
  if p_status not in ('registered','disputed','withdrawn') then
    raise exception 'Statut invalide';
  end if;
  select depositor_id into v_deposant from music_works where id = p_id;
  if v_deposant is null then raise exception 'Œuvre introuvable'; end if;
  v_moi := my_artist_id();

  -- Le déposant peut retirer son œuvre ; contester celle d'un autre relève de
  -- l'administration, qui arbitre. Sinon n'importe qui gèlerait le catalogue
  -- d'un rival en un clic.
  if p_status = 'disputed' then
    if not is_newpad_admin() then raise exception 'Une contestation s''ouvre auprès de l''administration'; end if;
  elsif v_deposant is distinct from v_moi and not is_newpad_admin() then
    raise exception 'Ce dépôt n''est pas le vôtre';
  end if;

  update music_works set
    status = p_status,
    dispute_note = case when p_status = 'disputed'
                        then nullif(trim(coalesce(p_note, '')), '') else null end
  where id = p_id;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Déclarer une utilisation
-- ----------------------------------------------------------------------------
create or replace function sacem_declare_use(
  p_work_id uuid, p_entity_type text, p_entity_id uuid, p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_moi uuid; v_ayant boolean; v_proprio boolean := false; v_oeuvre text;
begin
  perform require_active_profile();
  if p_entity_type not in ('tube_video','event','news_article','life_post') then
    raise exception 'Type de contenu invalide';
  end if;
  select title into v_oeuvre from music_works where id = p_work_id;
  if v_oeuvre is null then raise exception 'Œuvre introuvable'; end if;

  v_moi := my_artist_id();
  v_ayant := v_moi is not null and exists (
    select 1 from music_work_shares where work_id = p_work_id and artist_id = v_moi
  );

  -- Deux personnes ont le droit de déclarer : un ayant droit de l'œuvre, et
  -- celui qui a publié le contenu. Le premier réclame, le second crédite.
  if p_entity_type = 'tube_video' then
    v_proprio := exists (
      select 1 from tube_videos v join tube_channels c on c.id = v.channel_id
       where v.id = p_entity_id and c.owner_id = auth.uid());
  elsif p_entity_type = 'event' then
    v_proprio := exists (select 1 from event_items where id = p_entity_id and host_id = auth.uid());
  elsif p_entity_type = 'news_article' then
    v_proprio := exists (select 1 from news_articles where id = p_entity_id and author_id = auth.uid());
  elsif p_entity_type = 'life_post' then
    v_proprio := exists (select 1 from life_posts where id = p_entity_id and author_id = auth.uid());
  end if;

  if not v_ayant and not v_proprio then
    raise exception 'Seul un ayant droit de l''œuvre ou l''auteur du contenu peut déclarer cette utilisation';
  end if;

  insert into music_uses (work_id, entity_type, entity_id, declared_by, note)
  values (p_work_id, p_entity_type, p_entity_id, auth.uid(), nullif(trim(coalesce(p_note, '')), ''))
  on conflict (work_id, entity_type, entity_id) do nothing
  returning id into v_id;

  if v_id is null then raise exception 'Cette utilisation est déjà déclarée'; end if;
  return v_id;
end;
$function$;

create or replace function sacem_remove_use(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_use record; v_moi uuid;
begin
  perform require_active_profile();
  select work_id, declared_by into v_use from music_uses where id = p_id;
  if v_use.work_id is null then raise exception 'Déclaration introuvable'; end if;
  v_moi := my_artist_id();
  if v_use.declared_by <> auth.uid()
     and not exists (select 1 from music_work_shares
                      where work_id = v_use.work_id and artist_id = v_moi)
     and not is_newpad_admin() then
    raise exception 'Cette déclaration n''est pas la vôtre';
  end if;
  delete from music_uses where id = p_id;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Lectures
-- ----------------------------------------------------------------------------
create or replace function sacem_catalogue(
  p_search text default null, p_artist_id uuid default null, p_limit int default 40
)
returns table (id uuid, reference text, title text, genre text, cover_url text,
               release_date date, status text, depositor_id uuid, depositor_name text,
               label_name text, ayants_droit text, ecoutes bigint, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  return query
    select w.id, w.reference, w.title, w.genre, w.cover_url, w.release_date, w.status,
           w.depositor_id, a.stage_name, o.name,
           (select string_agg(ar.stage_name || ' (' || trim(to_char(s.share, 'FM990.99')) || ' %)', ', '
                              order by s.share desc)
              from music_work_shares s join music_artists ar on ar.id = s.artist_id
             where s.work_id = w.id),
           -- Les écoutes ne sont pas stockées : on les compte là où elles se
           -- produisent, sur les contenus qui déclarent utiliser l'œuvre.
           (select count(*) from music_uses u
              join analytics_events e on e.entity_type = u.entity_type and e.entity_id = u.entity_id
             where u.work_id = w.id and e.event_type = 'view'),
           w.created_at
    from music_works w
    join music_artists a on a.id = w.depositor_id
    left join organizations o on o.id = w.organization_id
    where w.status <> 'withdrawn'
      and (p_artist_id is null
           or exists (select 1 from music_work_shares s
                       where s.work_id = w.id and s.artist_id = p_artist_id))
      and (p_search is null or trim(p_search) = ''
           or w.title ilike '%' || trim(p_search) || '%'
           or w.reference ilike '%' || trim(p_search) || '%'
           or a.stage_name ilike '%' || trim(p_search) || '%')
    order by w.created_at desc
    limit least(coalesce(p_limit, 40), 100);
end;
$function$;

create or replace function sacem_work(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_res jsonb; v_moi uuid;
begin
  v_moi := my_artist_id();
  select jsonb_build_object(
    'id', w.id, 'reference', w.reference, 'title', w.title, 'genre', w.genre,
    'cover_url', w.cover_url, 'release_date', w.release_date,
    'duration_seconds', w.duration_seconds, 'status', w.status,
    'dispute_note', w.dispute_note,
    'depositor_id', w.depositor_id, 'depositor_name', a.stage_name,
    'label_name', o.name, 'organization_id', w.organization_id,
    'is_mine', (w.depositor_id = v_moi),
    'shares', (select jsonb_agg(jsonb_build_object(
                  'artist_id', s.artist_id, 'stage_name', ar.stage_name,
                  'share', s.share, 'role', s.role) order by s.share desc)
                 from music_work_shares s join music_artists ar on ar.id = s.artist_id
                where s.work_id = w.id),
    'uses', (select jsonb_agg(jsonb_build_object(
                  'id', u.id, 'entity_type', u.entity_type, 'entity_id', u.entity_id,
                  'note', u.note, 'created_at', u.created_at) order by u.created_at desc)
               from music_uses u where u.work_id = w.id)
  ) into v_res
  from music_works w
  join music_artists a on a.id = w.depositor_id
  left join organizations o on o.id = w.organization_id
  where w.id = p_id;

  if v_res is null then raise exception 'Œuvre introuvable'; end if;
  return v_res;
end;
$function$;

create or replace function sacem_artist(p_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_res jsonb; v_id uuid;
begin
  v_id := coalesce(p_id, my_artist_id());
  if v_id is null then return null; end if;

  select jsonb_build_object(
    'id', a.id, 'stage_name', a.stage_name, 'slug', a.slug, 'bio', a.bio,
    'avatar_url', a.avatar_url, 'profile_id', a.profile_id,
    'label_name', o.name, 'organization_id', a.organization_id,
    'is_me', (a.profile_id = auth.uid()),
    'oeuvres', (select count(*) from music_work_shares s
                 join music_works w on w.id = s.work_id
                where s.artist_id = a.id and w.status <> 'withdrawn'),
    'parts_moyennes', (select round(avg(s.share), 1) from music_work_shares s where s.artist_id = a.id),
    'ecoutes', (select count(*)
                  from music_work_shares s
                  join music_uses u on u.work_id = s.work_id
                  join analytics_events e
                    on e.entity_type = u.entity_type and e.entity_id = u.entity_id
                 where s.artist_id = a.id and e.event_type = 'view')
  ) into v_res
  from music_artists a
  left join organizations o on o.id = a.organization_id
  where a.id = v_id;

  return v_res;
end;
$function$;

create or replace function sacem_search_artists(p_query text)
returns table (id uuid, stage_name text, slug text, avatar_url text, label_name text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select a.id, a.stage_name, a.slug, a.avatar_url, o.name
  from music_artists a
  left join organizations o on o.id = a.organization_id
  where coalesce(trim(p_query), '') = ''
     or a.stage_name ilike '%' || trim(p_query) || '%'
     or a.slug ilike '%' || trim(p_query) || '%'
  order by a.stage_name
  limit 25;
$function$;

-- ----------------------------------------------------------------------------
-- Correctif trouvé en testant SACEM : NewTube exigeait un identifiant d'URL
-- ----------------------------------------------------------------------------
-- `tube_save_channel` écrivait `p_slug` tel quel. Un appel sans identifiant
-- d'URL — ce que fait n'importe quel formulaire où le champ est facultatif —
-- tombait sur une violation de contrainte NOT NULL, message technique à
-- l'appui. On le dérive du nom, comme SACEM le fait pour un nom de scène.
create or replace function tube_save_channel(
  p_name text, p_slug text, p_description text default null,
  p_avatar_url text default null, p_organization_id uuid default null, p_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_slug text;
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  perform require_active_profile();
  if p_organization_id is not null and not is_org_manager(p_organization_id) then
    raise exception 'Réservé à la direction de l''organisation';
  end if;

  v_slug := lower(regexp_replace(coalesce(nullif(trim(coalesce(p_slug, '')), ''), trim(coalesce(p_name, ''))),
                                 '[^a-zA-Z0-9]+', '-', 'g'));
  v_slug := trim(both '-' from v_slug);
  if v_slug = '' then raise exception 'Nom de chaîne invalide'; end if;

  if p_id is null then
    insert into tube_channels (owner_id, organization_id, name, slug, description, avatar_url)
    values (auth.uid(), p_organization_id, trim(p_name), v_slug,
            nullif(trim(coalesce(p_description, '')), ''), nullif(trim(coalesce(p_avatar_url, '')), ''))
    returning id into v_id;
  else
    if channel_owner(p_id) is distinct from auth.uid() then
      raise exception 'Cette chaîne n''est pas la vôtre';
    end if;
    update tube_channels set
      name = trim(p_name), slug = v_slug,
      description = nullif(trim(coalesce(p_description, '')), ''),
      avatar_url = nullif(trim(coalesce(p_avatar_url, '')), '')
    where id = p_id returning id into v_id;
  end if;
  return v_id;
end;
$function$;

update app_registry set status = 'live' where slug = 'sacem';

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

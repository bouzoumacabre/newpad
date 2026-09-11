-- ############################################################################
-- 0047 — NEWPAGE + NEWPRO : L'ANNUAIRE ET LE BACK-OFFICE DES ENTREPRISES
-- ############################################################################
-- §36 et §38. Les deux applications s'appuient sur la MÊME table
-- `organizations`, posée avec le noyau : NewPage en est la vitrine publique,
-- NewPro la salle des machines. Une entreprise créée dans l'une existe
-- immédiatement dans l'autre — c'est la règle du §13, et la raison pour
-- laquelle `organizations` a été créée avant ces deux applications plutôt qu'à
-- l'intérieur de l'une d'elles.
--
-- Note de déploiement : appliquée en deux passes (le socle, puis la fonction de
-- mise à jour de la fiche). Ce fichier réunit les deux.
-- ############################################################################

alter table organizations add column if not exists opening_hours text;
alter table organizations add column if not exists is_published boolean not null default true;
alter table organizations add column if not exists discord_url text;

comment on column organizations.is_published is
  'Figure à l''annuaire public NewPage. Une entreprise en cours de montage peut exister dans NewPro sans être encore annoncée en ville.';

-- ----------------------------------------------------------------------------
-- NewPage est ouverte aux invités : l'annuaire doit être lisible sans compte.
-- Un annuaire d'entreprises que seuls les clients de la banque peuvent
-- consulter ne remplit pas son office — on y cherche justement une adresse
-- avant d'être client de quoi que ce soit.
-- ----------------------------------------------------------------------------
drop policy if exists organizations_select_guest on organizations;
create policy organizations_select_guest on organizations
  for select to anon
  using (status = 'active' and is_published);

-- Un visiteur doit aussi pouvoir voir qui dirige une entreprise publiée, sans
-- pour autant obtenir la liste de ses employés : seuls les responsables sont
-- exposés, et uniquement pour les entreprises annoncées.
drop policy if exists organization_members_select_guest on organization_members;
create policy organization_members_select_guest on organization_members
  for select to anon
  using (
    member_role in ('owner', 'manager')
    and exists (
      select 1 from organizations o
      where o.id = organization_members.organization_id
        and o.status = 'active' and o.is_published
    )
  );

-- ----------------------------------------------------------------------------
-- Annonces internes d'entreprise (§38)
-- ----------------------------------------------------------------------------
create table if not exists organization_announcements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  author_id uuid not null references profiles(id) on delete cascade,
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  constraint org_ann_title_len check (length(trim(title)) between 1 and 120),
  constraint org_ann_body_len check (length(body) between 1 and 4000)
);

create index if not exists idx_org_ann_org on organization_announcements(organization_id, created_at desc);

alter table organization_announcements enable row level security;

-- Une annonce interne est interne : elle ne sort pas de l'entreprise, pas même
-- pour l'administration Newpad.
drop policy if exists org_announcements_select on organization_announcements;
create policy org_announcements_select on organization_announcements
  for select to authenticated
  using (is_org_member(organization_id));

create or replace function neworg_post_announcement(
  p_organization_id uuid, p_title text, p_body text
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_membre record; v_nom text;
begin
  if not is_org_manager(p_organization_id) then
    raise exception 'Réservé à la direction de l''organisation';
  end if;
  perform require_active_profile();

  insert into organization_announcements (organization_id, author_id, title, body)
  values (p_organization_id, auth.uid(), trim(p_title), p_body)
  returning id into v_id;

  select name into v_nom from organizations where id = p_organization_id;

  -- Une annonce interne que personne ne voit passer n'est pas une annonce :
  -- chaque membre est prévenu, sauf son auteur.
  for v_membre in
    select profile_id from organization_members
    where organization_id = p_organization_id and profile_id <> auth.uid()
  loop
    perform notify(v_membre.profile_id, 'org_announcement', v_nom, trim(p_title), '/pro');
  end loop;

  return v_id;
end;
$function$;

create or replace function neworg_delete_announcement(p_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_org uuid;
begin
  select organization_id into v_org from organization_announcements where id = p_id;
  if v_org is null then raise exception 'Annonce introuvable'; end if;
  if not is_org_manager(v_org) then
    raise exception 'Réservé à la direction de l''organisation';
  end if;
  delete from organization_announcements where id = p_id;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Lecture des effectifs avec les noms (même raison que pour NewMail : un joueur
-- n'a pas le droit de parcourir les profils des autres)
-- ----------------------------------------------------------------------------
create or replace function neworg_members(p_organization_id uuid)
returns table (profile_id uuid, username text, display_name text, member_role text, grade_label text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not (is_org_member(p_organization_id) or is_newpad_admin()) then
    raise exception 'Réservé aux membres de l''organisation';
  end if;
  return query
    select m.profile_id, p.username, p.display_name, m.member_role, m.grade_label, m.created_at
    from organization_members m
    join profiles p on p.id = m.profile_id
    where m.organization_id = p_organization_id
    order by case m.member_role when 'owner' then 0 when 'manager' then 1 else 2 end, p.display_name;
end;
$function$;

-- Les organisations dont je suis membre, avec mon rôle. Une jointure directe
-- côté client buterait sur la policy des organisations pour une entreprise non
-- publiée dont on est pourtant membre.
create or replace function neworg_mine()
returns table (id uuid, slug text, name text, kind text, logo_url text, status text,
               is_published boolean, member_role text, grade_label text, nb_membres int)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  return query
    select o.id, o.slug, o.name, o.kind, o.logo_url, o.status, o.is_published,
           m.member_role, m.grade_label,
           (select count(*)::int from organization_members x where x.organization_id = o.id)
    from organization_members m
    join organizations o on o.id = m.organization_id
    where m.profile_id = auth.uid()
    order by o.name;
end;
$function$;

-- ----------------------------------------------------------------------------
-- La fiche d'annuaire se modifie par fonction, comme le reste
-- ----------------------------------------------------------------------------
-- Il aurait été tentant d'ouvrir une policy d'écriture sur `organizations` pour
-- ces champs-là, « sans enjeu de sécurité ». C'est faux, et le détail est le
-- suivant : une policy d'UPDATE porte sur la LIGNE, pas sur les colonnes.
-- Autoriser un responsable à corriger ses horaires l'autoriserait du même geste
-- à changer `status`, `owner_id` ou le nom de son entreprise. Une fonction, elle,
-- ne touche que ce qu'elle nomme.
create or replace function neworg_update_profile(
  p_organization_id uuid,
  p_description text default null,
  p_contact_email text default null,
  p_contact_phone text default null,
  p_location text default null,
  p_opening_hours text default null,
  p_discord_url text default null,
  p_logo_url text default null,
  p_is_published boolean default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not (is_org_manager(p_organization_id) or is_newpad_admin()) then
    raise exception 'Réservé à la direction de l''organisation';
  end if;
  perform require_active_profile();

  if p_discord_url is not null and trim(p_discord_url) <> ''
     and p_discord_url !~ '^https?://' then
    raise exception 'Le lien doit commencer par http:// ou https://';
  end if;

  update organizations set
    description   = nullif(trim(coalesce(p_description, description, '')), ''),
    contact_email = nullif(trim(coalesce(p_contact_email, contact_email, '')), ''),
    contact_phone = nullif(trim(coalesce(p_contact_phone, contact_phone, '')), ''),
    location      = nullif(trim(coalesce(p_location, location, '')), ''),
    opening_hours = nullif(trim(coalesce(p_opening_hours, opening_hours, '')), ''),
    discord_url   = nullif(trim(coalesce(p_discord_url, discord_url, '')), ''),
    logo_url      = nullif(trim(coalesce(p_logo_url, logo_url, '')), ''),
    is_published  = coalesce(p_is_published, is_published)
  where id = p_organization_id;
end;
$function$;

update app_registry set status = 'live' where slug in ('page', 'pro');
update app_registry set admin_route = '/newpad/organizations' where slug = 'page';

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

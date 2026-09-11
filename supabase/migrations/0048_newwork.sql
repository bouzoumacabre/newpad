-- ############################################################################
-- 0048 — NEWWORK : RÉSEAU PROFESSIONNEL ET EMPLOI (§39)
-- ############################################################################
-- Trois briques déjà en place se rejoignent ici, et c'est tout l'intérêt :
--   · les entreprises viennent de `organizations` (NewPro) ;
--   · les CV viennent de `files` (NewFiles) ;
--   · l'autorisation d'un document à une ORGANISATION existe déjà dans
--     `file_permissions` — c'est exactement ce dont une candidature a besoin.
--
-- Postuler ne duplique donc aucun document : le candidat autorise l'entreprise
-- à consulter son CV. Toute la direction y a accès, et le candidat peut retirer
-- cette autorisation depuis NewFiles une fois le recrutement passé.
-- ############################################################################

create table if not exists work_profiles (
  profile_id uuid primary key references profiles(id) on delete cascade,
  headline text,
  about text,
  skills text[] not null default '{}',
  open_to_work boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint work_headline_len check (headline is null or length(trim(headline)) <= 100),
  constraint work_about_len check (about is null or length(about) <= 2000),
  constraint work_skills_len check (array_length(skills, 1) is null or array_length(skills, 1) <= 20)
);
comment on table work_profiles is
  'Profil professionnel public. La ligne n''existe que si le joueur l''a créée : ne pas se déclarer ici, c''est ne pas figurer au réseau.';

create table if not exists job_offers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  created_by uuid not null references profiles(id) on delete cascade,
  title text not null,
  description text not null,
  contract_type text not null default 'cdi',
  compensation text,
  location text,
  is_open boolean not null default true,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  constraint offer_title_len check (length(trim(title)) between 2 and 120),
  constraint offer_desc_len check (length(description) between 1 and 4000),
  constraint offer_contract_check check (contract_type in ('cdi','cdd','mission','stage','benevolat'))
);

create index if not exists idx_offers_open on job_offers(is_open, created_at desc);
create index if not exists idx_offers_org on job_offers(organization_id);

create table if not exists job_applications (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references job_offers(id) on delete cascade,
  applicant_id uuid not null references profiles(id) on delete cascade,
  message text,
  status text not null default 'received',
  decision_note text,
  decided_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (offer_id, applicant_id),
  constraint application_status_check check (status in ('received','viewed','interview','accepted','rejected'))
);

create index if not exists idx_applications_offer on job_applications(offer_id);
create index if not exists idx_applications_applicant on job_applications(applicant_id);

-- Nom sans souligné : cette fonction est citée par une policy, donc elle fait
-- partie de la surface appelable (règle posée en 0043).
create or replace function job_offer_org(p_offer_id uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select organization_id from job_offers where id = p_offer_id;
$function$;

alter table work_profiles enable row level security;
alter table job_offers enable row level security;
alter table job_applications enable row level security;

-- Un profil professionnel est fait pour être vu : c'est l'objet même de
-- l'application. Il n'existe que si son propriétaire l'a créé.
drop policy if exists work_profiles_select on work_profiles;
create policy work_profiles_select on work_profiles
  for select to authenticated using (true);

drop policy if exists work_profiles_write on work_profiles;
create policy work_profiles_write on work_profiles
  for all to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- Une offre fermée reste visible de l'entreprise qui l'a publiée (historique)
-- et des personnes qui y ont postulé, mais disparaît des offres à pourvoir.
drop policy if exists job_offers_select on job_offers;
create policy job_offers_select on job_offers
  for select to authenticated
  using (
    is_open
    or is_org_member(organization_id)
    or exists (select 1 from job_applications a
               where a.offer_id = job_offers.id and a.applicant_id = auth.uid())
  );

-- Une candidature n'est visible que du candidat et de l'entreprise concernée.
-- Les autres candidats ne se voient pas entre eux.
drop policy if exists job_applications_select on job_applications;
create policy job_applications_select on job_applications
  for select to authenticated
  using (applicant_id = auth.uid() or is_org_member(job_offer_org(offer_id)));

-- ----------------------------------------------------------------------------
-- Offres
-- ----------------------------------------------------------------------------
create or replace function newwork_publish_offer(
  p_organization_id uuid, p_title text, p_description text,
  p_contract_type text default 'cdi', p_compensation text default null,
  p_location text default null, p_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid;
begin
  if not is_org_manager(p_organization_id) then
    raise exception 'Réservé à la direction de l''organisation';
  end if;
  perform require_active_profile();

  if p_id is null then
    insert into job_offers (organization_id, created_by, title, description,
                            contract_type, compensation, location)
    values (p_organization_id, auth.uid(), trim(p_title), p_description,
            coalesce(p_contract_type, 'cdi'),
            nullif(trim(coalesce(p_compensation, '')), ''),
            nullif(trim(coalesce(p_location, '')), ''))
    returning id into v_id;
  else
    update job_offers set
      title = trim(p_title), description = p_description,
      contract_type = coalesce(p_contract_type, contract_type),
      compensation = nullif(trim(coalesce(p_compensation, '')), ''),
      location = nullif(trim(coalesce(p_location, '')), '')
    where id = p_id and organization_id = p_organization_id
    returning id into v_id;
    if v_id is null then raise exception 'Offre introuvable'; end if;
  end if;
  return v_id;
end;
$function$;

create or replace function newwork_close_offer(p_id uuid, p_open boolean default false)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_org_manager(job_offer_org(p_id)) then
    raise exception 'Réservé à la direction de l''organisation';
  end if;
  update job_offers
  set is_open = coalesce(p_open, false),
      closed_at = case when coalesce(p_open, false) then null else now() end
  where id = p_id;
end;
$function$;

-- Les offres à pourvoir, avec le nom de l'entreprise et l'état de MA
-- candidature : sans cela l'interface proposerait de postuler à une offre où
-- l'on a déjà postulé.
create or replace function newwork_list_offers(p_query text default null)
returns table (
  id uuid, organization_id uuid, organisation text, org_logo text, org_kind text,
  title text, description text, contract_type text, compensation text,
  location text, created_at timestamptz, nb_candidatures int, ma_candidature text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_q text := lower(trim(coalesce(p_query, '')));
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  return query
    select o.id, o.organization_id, g.name, g.logo_url, g.kind,
           o.title, o.description, o.contract_type, o.compensation,
           o.location, o.created_at,
           (select count(*)::int from job_applications a where a.offer_id = o.id),
           (select a.status from job_applications a
             where a.offer_id = o.id and a.applicant_id = auth.uid())
    from job_offers o
    join organizations g on g.id = o.organization_id
    where o.is_open and g.status = 'active'
      and (v_q = '' or lower(o.title) like '%' || v_q || '%'
           or lower(g.name) like '%' || v_q || '%'
           or lower(coalesce(o.location, '')) like '%' || v_q || '%')
    order by o.created_at desc limit 100;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Candidatures
-- ----------------------------------------------------------------------------
create or replace function newwork_apply(
  p_offer_id uuid, p_message text default null, p_file_ids uuid[] default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_org uuid; v_file uuid; v_titre text; v_nom text; v_membre record;
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  perform require_active_profile();

  select organization_id, title into v_org, v_titre
  from job_offers where id = p_offer_id and is_open;
  if v_org is null then raise exception 'Cette offre n''est plus à pourvoir'; end if;

  if is_org_member(v_org) then
    raise exception 'Vous faites déjà partie de cette organisation';
  end if;

  insert into job_applications (offer_id, applicant_id, message)
  values (p_offer_id, auth.uid(), nullif(trim(coalesce(p_message, '')), ''))
  on conflict (offer_id, applicant_id)
  do update set message = excluded.message, status = 'received', updated_at = now()
  returning id into v_id;

  -- Les documents ne sont pas copiés : ils sont AUTORISÉS à l'organisation
  -- entière, donc à toute personne qui y travaille aujourd'hui. Le candidat
  -- peut retirer cette autorisation depuis NewFiles une fois le recrutement
  -- passé — ce qu'une pièce jointe envoyée ne permettrait jamais.
  if p_file_ids is not null then
    foreach v_file in array p_file_ids loop
      if file_owner_id(v_file) is distinct from auth.uid() then
        raise exception 'Vous ne pouvez joindre que vos propres documents';
      end if;
      insert into file_permissions (file_id, grantee_type, grantee_id, permission, granted_by, note)
      values (v_file, 'organization', v_org, 'view', auth.uid(), 'Candidature — ' || v_titre)
      on conflict (file_id, grantee_type, grantee_id) do nothing;
    end loop;
  end if;

  select display_name into v_nom from profiles where id = auth.uid();
  for v_membre in
    select profile_id from organization_members
    where organization_id = v_org and member_role in ('owner', 'manager')
  loop
    perform notify(v_membre.profile_id, 'job_application', 'Nouvelle candidature',
      v_nom || ' — ' || v_titre, '/work');
  end loop;

  return v_id;
end;
$function$;

create or replace function newwork_decide(p_application_id uuid, p_status text, p_note text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_org uuid; v_candidat uuid; v_titre text; v_libelle text;
begin
  select o.organization_id, a.applicant_id, o.title
    into v_org, v_candidat, v_titre
  from job_applications a join job_offers o on o.id = a.offer_id
  where a.id = p_application_id;

  if v_org is null then raise exception 'Candidature introuvable'; end if;
  if not is_org_member(v_org) then
    raise exception 'Réservé aux membres de l''organisation';
  end if;
  if p_status not in ('received','viewed','interview','accepted','rejected') then
    raise exception 'Statut invalide';
  end if;
  -- Marquer « consultée » est un geste anodin, accepter ou refuser n'en est pas
  -- un : la décision appartient à la direction.
  if p_status in ('accepted', 'rejected', 'interview') and not is_org_manager(v_org) then
    raise exception 'Réservé à la direction de l''organisation';
  end if;

  update job_applications
  set status = p_status, decision_note = nullif(trim(coalesce(p_note, '')), ''),
      decided_by = auth.uid(), updated_at = now()
  where id = p_application_id;

  v_libelle := case p_status
    when 'viewed' then 'Votre candidature a été consultée'
    when 'interview' then 'Vous êtes convoqué en entretien'
    when 'accepted' then 'Votre candidature est acceptée'
    when 'rejected' then 'Votre candidature n''a pas été retenue'
    else 'Votre candidature a été mise à jour' end;

  perform notify(v_candidat, 'job_application', v_libelle, v_titre, '/work');
end;
$function$;

create or replace function newwork_my_applications()
returns table (id uuid, offer_id uuid, titre text, organisation text, status text,
               decision_note text, message text, created_at timestamptz, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  return query
    select a.id, a.offer_id, o.title, g.name, a.status, a.decision_note,
           a.message, a.created_at, a.updated_at
    from job_applications a
    join job_offers o on o.id = a.offer_id
    join organizations g on g.id = o.organization_id
    where a.applicant_id = auth.uid()
    order by a.updated_at desc;
end;
$function$;

create or replace function newwork_offer_applications(p_offer_id uuid)
returns table (id uuid, applicant_id uuid, display_name text, username text,
               message text, status text, created_at timestamptz,
               headline text, nb_documents int)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_org uuid := job_offer_org(p_offer_id);
begin
  if not is_org_member(v_org) then
    raise exception 'Réservé aux membres de l''organisation';
  end if;
  return query
    select a.id, a.applicant_id, p.display_name, p.username, a.message, a.status, a.created_at,
           w.headline,
           (select count(*)::int from file_permissions fp
             join files f on f.id = fp.file_id
            where fp.grantee_type = 'organization' and fp.grantee_id = v_org
              and f.owner_id = a.applicant_id and f.deleted_at is null
              and (fp.expires_at is null or fp.expires_at > now()))
    from job_applications a
    join profiles p on p.id = a.applicant_id
    left join work_profiles w on w.profile_id = a.applicant_id
    where a.offer_id = p_offer_id
    order by a.created_at desc;
end;
$function$;

-- Les documents qu'un candidat a autorisés à l'entreprise. Rien d'autre de son
-- coffre n'est visible : la liste est bornée par les autorisations en cours.
create or replace function newwork_applicant_files(p_application_id uuid)
returns table (file_id uuid, nom text, categorie text, storage_path text)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_org uuid; v_candidat uuid;
begin
  select o.organization_id, a.applicant_id into v_org, v_candidat
  from job_applications a join job_offers o on o.id = a.offer_id
  where a.id = p_application_id;
  if v_org is null or not is_org_member(v_org) then
    raise exception 'Réservé aux membres de l''organisation';
  end if;
  return query
    select f.id, f.name, f.category, f.storage_path
    from file_permissions fp
    join files f on f.id = fp.file_id
    where fp.grantee_type = 'organization' and fp.grantee_id = v_org
      and f.owner_id = v_candidat and f.deleted_at is null
      and (fp.expires_at is null or fp.expires_at > now())
    order by f.name;
end;
$function$;

update app_registry set status = 'live' where slug = 'work';

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

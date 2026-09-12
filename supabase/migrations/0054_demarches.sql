-- ############################################################################
-- 0054 — LE SOCLE DES DÉMARCHES : NewGov, NewDoc, NewInsurance
-- ############################################################################
-- Même raisonnement que les vitrines (0053), appliqué à l'autre grande famille
-- d'applications du cahier des charges. Une mairie, un hôpital et une compagnie
-- d'assurance font tous la même chose : ils publient des démarches, un citoyen
-- en ouvre une, joint des pièces, la conversation s'installe, un agent décide.
--
-- Ce qui change d'une administration à l'autre, ce sont les démarches proposées
-- et les champs de leur formulaire. Ce sont donc des DONNÉES : chaque
-- organisation compose ses propres démarches depuis son guichet, sans
-- déploiement (§7, Principe 1). `app_registry.is_service` ouvre une quatrième
-- administration le jour où elle existera.
--
-- Les pièces justificatives ne sont pas recopiées : elles sont AUTORISÉES à
-- l'organisation depuis NewFiles (§13), comme les CV de NewWork. Le citoyen
-- garde la main : il révoque, l'administration perd l'accès.
--
-- §90 : aucun mouvement de fonds. Une amende, une prime d'assurance ou un acte
-- médical se paient par un virement Newman Bank, pas ici.
-- ############################################################################

alter table app_registry add column if not exists is_service boolean not null default false;

create sequence if not exists service_case_seq;

-- ----------------------------------------------------------------------------
-- Les démarches proposées par une administration
-- ----------------------------------------------------------------------------
create table if not exists service_procedures (
  id uuid primary key default gen_random_uuid(),
  app_slug text not null references app_registry(slug) on update cascade,
  organization_id uuid not null references organizations(id) on delete cascade,
  title text not null,
  description text not null,
  -- Le formulaire de la démarche : [{key,label,type,required,options}]. Une
  -- demande de permis n'a pas les mêmes champs qu'une déclaration de sinistre,
  -- et aucune colonne ne pourra jamais les prévoir toutes.
  fields jsonb not null default '[]'::jsonb,
  requires_files boolean not null default false,
  is_open boolean not null default true,
  sort_order int not null default 10,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_proc_title_len check (length(trim(title)) between 3 and 120),
  constraint service_proc_desc_len check (length(description) between 1 and 4000),
  constraint service_proc_fields_array check (jsonb_typeof(fields) = 'array'),
  constraint service_proc_fields_size check (length(fields::text) <= 8000)
);

create index if not exists idx_service_proc on service_procedures(app_slug, is_open, sort_order);
create index if not exists idx_service_proc_org on service_procedures(organization_id);

drop trigger if exists trg_service_proc_touch on service_procedures;
create trigger trg_service_proc_touch before update on service_procedures
  for each row execute function _touch_updated_at();

alter table service_procedures enable row level security;

drop policy if exists service_proc_select on service_procedures;
create policy service_proc_select on service_procedures
  for select to authenticated using (is_open or is_org_member(organization_id));

-- ----------------------------------------------------------------------------
-- Les dossiers
-- ----------------------------------------------------------------------------
-- `organization_id` est recopié ici volontairement : la policy des dossiers
-- doit pouvoir trancher sans passer par une fonction, et un dossier reste
-- rattaché à l'administration qui l'a reçu même si la démarche est retirée.
create table if not exists service_cases (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  app_slug text not null references app_registry(slug) on update cascade,
  procedure_id uuid not null references service_procedures(id) on delete restrict,
  organization_id uuid not null references organizations(id) on delete cascade,
  applicant_id uuid not null references profiles(id) on delete cascade,
  answers jsonb not null default '{}'::jsonb,
  status text not null default 'submitted',
  assignee_id uuid references profiles(id) on delete set null,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  decided_at timestamptz,
  constraint service_case_answers_object check (jsonb_typeof(answers) = 'object'),
  constraint service_case_answers_size check (length(answers::text) <= 8000),
  constraint service_case_note_len check (decision_note is null or length(decision_note) <= 2000),
  constraint service_case_status check (status in (
    'submitted','in_review','info_needed','accepted','rejected','closed'
  ))
);

create index if not exists idx_service_case_org on service_cases(organization_id, status, created_at desc);
create index if not exists idx_service_case_user on service_cases(applicant_id, created_at desc);

drop trigger if exists trg_service_case_touch on service_cases;
create trigger trg_service_case_touch before update on service_cases
  for each row execute function _touch_updated_at();

alter table service_cases enable row level security;

-- Un dossier ne se lit qu'à deux : celui qui l'a ouvert et l'administration qui
-- le traite. C'est la règle la plus importante de cette migration — NewDoc y
-- fait transiter des dossiers médicaux.
drop policy if exists service_case_select on service_cases;
create policy service_case_select on service_cases
  for select to authenticated
  using (applicant_id = auth.uid() or is_org_member(organization_id));

-- ----------------------------------------------------------------------------
-- La conversation et les pièces
-- ----------------------------------------------------------------------------
create or replace function case_org(p_case_id uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select organization_id from service_cases where id = p_case_id;
$function$;

create or replace function case_applicant(p_case_id uuid)
returns uuid
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select applicant_id from service_cases where id = p_case_id;
$function$;

create table if not exists service_case_messages (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references service_cases(id) on delete cascade,
  author_id uuid not null references profiles(id) on delete cascade,
  body text not null,
  -- Une note interne reste au guichet : l'usager ne la voit jamais.
  is_internal boolean not null default false,
  created_at timestamptz not null default now(),
  constraint service_msg_len check (length(trim(body)) between 1 and 4000)
);

create index if not exists idx_service_msg on service_case_messages(case_id, created_at);

alter table service_case_messages enable row level security;

drop policy if exists service_msg_select on service_case_messages;
create policy service_msg_select on service_case_messages
  for select to authenticated
  using (
    is_org_member(case_org(case_id))
    or (not is_internal and case_applicant(case_id) = auth.uid())
  );

create table if not exists service_case_files (
  case_id uuid not null references service_cases(id) on delete cascade,
  file_id uuid not null references files(id) on delete cascade,
  added_by uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (case_id, file_id)
);

alter table service_case_files enable row level security;

drop policy if exists service_case_files_select on service_case_files;
create policy service_case_files_select on service_case_files
  for select to authenticated
  using (is_org_member(case_org(case_id)) or case_applicant(case_id) = auth.uid());

-- ----------------------------------------------------------------------------
-- Administration des guichets
-- ----------------------------------------------------------------------------
create or replace function service_set_service_app(p_app_slug text, p_is_service boolean)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_newpad_admin() then raise exception 'Réservé à l''administrateur Newpad'; end if;
  update app_registry set is_service = coalesce(p_is_service, false) where slug = p_app_slug;
  if not found then raise exception 'Application introuvable'; end if;
end;
$function$;

create or replace function service_upsert_procedure(
  p_app_slug text, p_organization_id uuid, p_title text, p_description text,
  p_id uuid default null, p_fields jsonb default null,
  p_requires_files boolean default false, p_sort_order int default 10
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_org uuid; v_service boolean;
begin
  perform require_active_profile();

  select is_service into v_service from app_registry where slug = p_app_slug;
  if v_service is null then raise exception 'Application introuvable'; end if;
  if not v_service then raise exception 'Cette application n''est pas un guichet'; end if;

  -- Composer les démarches d'une administration relève de sa direction, pas de
  -- n'importe quel agent : c'est ce que l'usager verra comme la parole de
  -- l'institution.
  if not is_org_manager(p_organization_id) then
    raise exception 'Réservé à la direction de l''organisation';
  end if;

  if p_id is null then
    insert into service_procedures (app_slug, organization_id, title, description,
                                    fields, requires_files, sort_order)
    values (p_app_slug, p_organization_id, trim(p_title), p_description,
            coalesce(p_fields, '[]'::jsonb), coalesce(p_requires_files, false),
            coalesce(p_sort_order, 10))
    returning id into v_id;
  else
    select organization_id into v_org from service_procedures where id = p_id;
    if v_org is null then raise exception 'Démarche introuvable'; end if;
    if not is_org_manager(v_org) then raise exception 'Cette démarche n''est pas la vôtre'; end if;

    update service_procedures set
      title = trim(p_title),
      description = p_description,
      fields = coalesce(p_fields, fields),
      requires_files = coalesce(p_requires_files, requires_files),
      sort_order = coalesce(p_sort_order, sort_order)
    where id = p_id
    returning id into v_id;
  end if;
  return v_id;
end;
$function$;

create or replace function service_set_procedure_open(p_id uuid, p_open boolean)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_org uuid;
begin
  perform require_active_profile();
  select organization_id into v_org from service_procedures where id = p_id;
  if v_org is null then raise exception 'Démarche introuvable'; end if;
  if not is_org_manager(v_org) then raise exception 'Réservé à la direction'; end if;
  update service_procedures set is_open = coalesce(p_open, false) where id = p_id;
end;
$function$;

create or replace function service_procedures_list(
  p_app_slug text, p_organization_id uuid default null, p_all boolean default false
)
returns table (id uuid, title text, description text, fields jsonb, requires_files boolean,
               is_open boolean, organization_id uuid, org_name text, org_kind text,
               open_cases bigint)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  return query
    select p.id, p.title, p.description, p.fields, p.requires_files, p.is_open,
           p.organization_id, o.name, o.kind,
           (select count(*) from service_cases c
             where c.procedure_id = p.id and c.status in ('submitted','in_review','info_needed'))
    from service_procedures p
    join organizations o on o.id = p.organization_id
    where p.app_slug = p_app_slug
      and (p_organization_id is null or p.organization_id = p_organization_id)
      -- Les démarches fermées ne se voient qu'au guichet qui les a écrites.
      and (p.is_open or (coalesce(p_all, false) and is_org_member(p.organization_id)))
    order by o.name, p.sort_order, p.title;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Ouvrir un dossier
-- ----------------------------------------------------------------------------
create or replace function service_open_case(
  p_procedure_id uuid, p_answers jsonb default null,
  p_message text default null, p_file_ids uuid[] default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid; v_proc record; v_ref text; v_file uuid; v_nom text; v_membre record;
  v_champ jsonb; v_valeur text; v_route text;
begin
  perform require_active_profile();

  select p.id, p.title, p.app_slug, p.organization_id, p.fields, p.requires_files, p.is_open
    into v_proc from service_procedures p where p.id = p_procedure_id;
  if v_proc.id is null then raise exception 'Démarche introuvable'; end if;
  if not v_proc.is_open then raise exception 'Cette démarche n''est plus ouverte'; end if;
  if is_org_member(v_proc.organization_id) then
    raise exception 'Vous faites partie de cette administration';
  end if;

  -- Les champs obligatoires sont vérifiés EN BASE : le formulaire vient de la
  -- base, sa validation aussi, sinon elle ne vaut rien.
  for v_champ in select * from jsonb_array_elements(v_proc.fields) loop
    if coalesce((v_champ ->> 'required')::boolean, false) then
      v_valeur := coalesce(p_answers, '{}'::jsonb) ->> (v_champ ->> 'key');
      if v_valeur is null or trim(v_valeur) = '' then
        raise exception 'Champ obligatoire manquant : %', coalesce(v_champ ->> 'label', v_champ ->> 'key');
      end if;
    end if;
  end loop;

  if v_proc.requires_files and (p_file_ids is null or array_length(p_file_ids, 1) is null) then
    raise exception 'Cette démarche exige au moins une pièce justificative';
  end if;

  v_ref := upper(left(regexp_replace(v_proc.app_slug, '[^a-zA-Z]', '', 'g') || 'xxx', 3))
           || '-' || to_char(now(), 'YYYY') || '-'
           || lpad(nextval('service_case_seq')::text, 6, '0');

  insert into service_cases (reference, app_slug, procedure_id, organization_id,
                             applicant_id, answers)
  values (v_ref, v_proc.app_slug, v_proc.id, v_proc.organization_id, auth.uid(),
          coalesce(p_answers, '{}'::jsonb))
  returning id into v_id;

  if p_message is not null and trim(p_message) <> '' then
    insert into service_case_messages (case_id, author_id, body)
    values (v_id, auth.uid(), trim(p_message));
  end if;

  -- Les pièces ne sont pas copiées : elles sont autorisées à l'organisation,
  -- et l'usager peut retirer cette autorisation depuis NewFiles (§13).
  if p_file_ids is not null then
    foreach v_file in array p_file_ids loop
      if file_owner_id(v_file) is distinct from auth.uid() then
        raise exception 'Vous ne pouvez joindre que vos propres documents';
      end if;
      insert into file_permissions (file_id, grantee_type, grantee_id, permission, granted_by, note)
      values (v_file, 'organization', v_proc.organization_id, 'view', auth.uid(),
              'Dossier ' || v_ref)
      on conflict (file_id, grantee_type, grantee_id) do nothing;
      insert into service_case_files (case_id, file_id, added_by)
      values (v_id, v_file, auth.uid()) on conflict do nothing;
    end loop;
  end if;

  select display_name into v_nom from profiles where id = auth.uid();
  select route into v_route from app_registry where slug = v_proc.app_slug;
  for v_membre in select profile_id from organization_members
                   where organization_id = v_proc.organization_id loop
    perform notify(v_membre.profile_id, 'service_case', 'Nouveau dossier',
                   v_ref || ' — ' || v_proc.title, coalesce(v_route, '/newpad'));
  end loop;

  return v_id;
end;
$function$;

create or replace function service_set_case_status(
  p_case_id uuid, p_status text, p_note text default null, p_assign_me boolean default false
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_case record; v_route text; v_libelle text;
begin
  perform require_active_profile();
  if p_status not in ('submitted','in_review','info_needed','accepted','rejected','closed') then
    raise exception 'Statut invalide';
  end if;

  select c.id, c.organization_id, c.applicant_id, c.reference, c.app_slug, c.status
    into v_case from service_cases c where c.id = p_case_id;
  if v_case.id is null then raise exception 'Dossier introuvable'; end if;
  if not is_org_member(v_case.organization_id) then
    raise exception 'Réservé à l''administration qui traite ce dossier';
  end if;
  if v_case.status in ('accepted','rejected','closed') and p_status <> 'closed' then
    raise exception 'Ce dossier est clos : il ne se rouvre pas';
  end if;

  update service_cases set
    status = p_status,
    decision_note = coalesce(nullif(trim(coalesce(p_note, '')), ''), decision_note),
    assignee_id = case when coalesce(p_assign_me, false) then auth.uid() else assignee_id end,
    decided_at = case when p_status in ('accepted','rejected','closed') then now() else decided_at end
  where id = p_case_id;

  v_libelle := case p_status
                 when 'in_review' then 'Dossier en cours de traitement'
                 when 'info_needed' then 'Pièces complémentaires demandées'
                 when 'accepted' then 'Dossier accepté'
                 when 'rejected' then 'Dossier refusé'
                 when 'closed' then 'Dossier clôturé'
                 else null end;
  if v_libelle is not null then
    select route into v_route from app_registry where slug = v_case.app_slug;
    perform notify(v_case.applicant_id, 'service_case', v_libelle, v_case.reference,
                   coalesce(v_route, '/newpad'));
  end if;
end;
$function$;

create or replace function service_post_case_message(
  p_case_id uuid, p_body text, p_internal boolean default false, p_file_ids uuid[] default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_case record; v_id uuid; v_agent boolean; v_file uuid; v_route text; v_nom text; v_membre record;
begin
  perform require_active_profile();
  if coalesce(trim(p_body), '') = '' then raise exception 'Message vide'; end if;

  select c.id, c.organization_id, c.applicant_id, c.reference, c.app_slug, c.status
    into v_case from service_cases c where c.id = p_case_id;
  if v_case.id is null then raise exception 'Dossier introuvable'; end if;

  v_agent := is_org_member(v_case.organization_id);
  if not v_agent and v_case.applicant_id <> auth.uid() then
    raise exception 'Ce dossier ne vous concerne pas';
  end if;
  -- Une note interne n'a de sens que côté guichet ; l'usager ne peut pas en
  -- écrire une, sinon il croirait s'adresser à lui-même.
  if coalesce(p_internal, false) and not v_agent then
    raise exception 'Réservé à l''administration';
  end if;

  insert into service_case_messages (case_id, author_id, body, is_internal)
  values (p_case_id, auth.uid(), trim(p_body), coalesce(p_internal, false))
  returning id into v_id;

  if p_file_ids is not null and not coalesce(p_internal, false) then
    foreach v_file in array p_file_ids loop
      if file_owner_id(v_file) is distinct from auth.uid() then
        raise exception 'Vous ne pouvez joindre que vos propres documents';
      end if;
      if not v_agent then
        insert into file_permissions (file_id, grantee_type, grantee_id, permission, granted_by, note)
        values (v_file, 'organization', v_case.organization_id, 'view', auth.uid(),
                'Dossier ' || v_case.reference)
        on conflict (file_id, grantee_type, grantee_id) do nothing;
      else
        insert into file_permissions (file_id, grantee_type, grantee_id, permission, granted_by, note)
        values (v_file, 'profile', v_case.applicant_id, 'view', auth.uid(),
                'Dossier ' || v_case.reference)
        on conflict (file_id, grantee_type, grantee_id) do nothing;
      end if;
      insert into service_case_files (case_id, file_id, added_by)
      values (p_case_id, v_file, auth.uid()) on conflict do nothing;
    end loop;
  end if;

  if not coalesce(p_internal, false) then
    select route into v_route from app_registry where slug = v_case.app_slug;
    select display_name into v_nom from profiles where id = auth.uid();
    if v_agent then
      perform notify(v_case.applicant_id, 'service_case', 'Réponse de l''administration',
                     v_case.reference, coalesce(v_route, '/newpad'));
    else
      for v_membre in select profile_id from organization_members
                       where organization_id = v_case.organization_id loop
        perform notify(v_membre.profile_id, 'service_case', 'Nouveau message sur un dossier',
                       v_case.reference || ' — ' || coalesce(v_nom, 'Usager'),
                       coalesce(v_route, '/newpad'));
      end loop;
    end if;
  end if;

  return v_id;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Lectures
-- ----------------------------------------------------------------------------
create or replace function service_case(p_case_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_res jsonb;
begin
  select jsonb_build_object(
    'id', c.id, 'reference', c.reference, 'app_slug', c.app_slug,
    'procedure_id', c.procedure_id, 'procedure_title', p.title, 'fields', p.fields,
    'answers', c.answers, 'status', c.status, 'decision_note', c.decision_note,
    'organization_id', c.organization_id, 'org_name', o.name,
    'applicant_id', c.applicant_id, 'applicant_name', a.display_name,
    'assignee_name', ag.display_name,
    'created_at', c.created_at, 'decided_at', c.decided_at,
    'is_agent', is_org_member(c.organization_id),
    'is_mine', (c.applicant_id = auth.uid())
  ) into v_res
  from service_cases c
  join service_procedures p on p.id = c.procedure_id
  join organizations o on o.id = c.organization_id
  join profiles a on a.id = c.applicant_id
  left join profiles ag on ag.id = c.assignee_id
  where c.id = p_case_id
    and (c.applicant_id = auth.uid() or is_org_member(c.organization_id));

  if v_res is null then raise exception 'Dossier introuvable'; end if;
  return v_res;
end;
$function$;

create or replace function service_case_thread(p_case_id uuid)
returns table (id uuid, author_id uuid, author_name text, body text,
               is_internal boolean, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_agent boolean; v_case record;
begin
  -- Alias obligatoire : `id` est aussi une colonne de sortie de cette fonction,
  -- et PostgreSQL refuse la référence ambiguë.
  select c.organization_id, c.applicant_id into v_case
    from service_cases c where c.id = p_case_id;
  if v_case.applicant_id is null then raise exception 'Dossier introuvable'; end if;
  v_agent := is_org_member(v_case.organization_id);
  if not v_agent and v_case.applicant_id <> auth.uid() then
    raise exception 'Ce dossier ne vous concerne pas';
  end if;

  return query
    select m.id, m.author_id, p.display_name, m.body, m.is_internal, m.created_at
    from service_case_messages m
    join profiles p on p.id = m.author_id
    where m.case_id = p_case_id
      and (v_agent or not m.is_internal)
    order by m.created_at
    limit 300;
end;
$function$;

create or replace function service_case_documents(p_case_id uuid)
returns table (file_id uuid, name text, category text, size_bytes bigint,
               added_by_name text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_case record;
begin
  select c.organization_id, c.applicant_id into v_case
    from service_cases c where c.id = p_case_id;
  if v_case.applicant_id is null then raise exception 'Dossier introuvable'; end if;
  if not is_org_member(v_case.organization_id) and v_case.applicant_id <> auth.uid() then
    raise exception 'Ce dossier ne vous concerne pas';
  end if;

  return query
    select f.id, f.name, f.category, f.size_bytes, p.display_name, cf.created_at
    from service_case_files cf
    join files f on f.id = cf.file_id
    join profiles p on p.id = cf.added_by
    where cf.case_id = p_case_id
    order by cf.created_at;
end;
$function$;

create or replace function service_my_cases(p_app_slug text default null)
returns table (id uuid, reference text, app_slug text, procedure_title text, org_name text,
               status text, created_at timestamptz, updated_at timestamptz, unread bigint)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  return query
    select c.id, c.reference, c.app_slug, p.title, o.name, c.status, c.created_at, c.updated_at,
           (select count(*) from service_case_messages m
             where m.case_id = c.id and not m.is_internal and m.author_id <> auth.uid())
    from service_cases c
    join service_procedures p on p.id = c.procedure_id
    join organizations o on o.id = c.organization_id
    where c.applicant_id = auth.uid()
      and (p_app_slug is null or c.app_slug = p_app_slug)
    order by c.updated_at desc
    limit 200;
end;
$function$;

create or replace function service_org_cases(
  p_app_slug text, p_organization_id uuid, p_status text default null
)
returns table (id uuid, reference text, procedure_title text, applicant_id uuid,
               applicant_name text, status text, assignee_name text,
               created_at timestamptz, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_org_member(p_organization_id) then
    raise exception 'Réservé à l''administration';
  end if;
  return query
    select c.id, c.reference, p.title, c.applicant_id, a.display_name, c.status,
           ag.display_name, c.created_at, c.updated_at
    from service_cases c
    join service_procedures p on p.id = c.procedure_id
    join profiles a on a.id = c.applicant_id
    left join profiles ag on ag.id = c.assignee_id
    where c.app_slug = p_app_slug
      and c.organization_id = p_organization_id
      and (p_status is null or p_status = '' or c.status = p_status)
    order by case c.status when 'submitted' then 0 when 'info_needed' then 1
                           when 'in_review' then 2 else 3 end,
             c.updated_at desc
    limit 300;
end;
$function$;

update app_registry set is_service = true, status = 'live'
 where slug in ('gov', 'doc', 'insurance');

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

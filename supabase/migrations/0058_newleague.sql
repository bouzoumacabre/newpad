-- ############################################################################
-- 0058 — NEWLEAGUE : les compétitions de la ville
-- ############################################################################
-- Un organisateur (un joueur, ou une organisation déjà connue de Newpad, §12)
-- ouvre une compétition. Des capitaines y inscrivent leur équipe,
-- l'organisateur accepte les inscriptions, programme les rencontres et saisit
-- les scores. Le classement n'est JAMAIS stocké : il se calcule à partir des
-- résultats, sinon il finit par les contredire.
--
-- Barème : 3 points la victoire, 1 le nul, 0 la défaite. Départage : points,
-- différence de buts, buts marqués, nom.
--
-- §90 : une dotation est un TEXTE. Newpad n'encaisse ni ne verse rien ; un prix
-- se paie par un virement Newman Bank.
-- ############################################################################

create table if not exists league_competitions (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references profiles(id) on delete cascade,
  organization_id uuid references organizations(id) on delete set null,
  name text not null,
  discipline text not null,
  description text not null default '',
  prize_info text,
  max_teams int,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint league_comp_name_len check (length(trim(name)) between 3 and 80),
  constraint league_comp_disc_len check (length(trim(discipline)) between 2 and 40),
  constraint league_comp_desc_len check (length(description) <= 4000),
  constraint league_comp_prize_len check (prize_info is null or length(prize_info) <= 120),
  constraint league_comp_max check (max_teams is null or max_teams between 2 and 64),
  constraint league_comp_status check (status in ('open','running','finished','cancelled'))
);
create index if not exists idx_league_comp on league_competitions(status, created_at desc);

drop trigger if exists trg_league_comp_touch on league_competitions;
create trigger trg_league_comp_touch before update on league_competitions
  for each row execute function _touch_updated_at();

create table if not exists league_teams (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references league_competitions(id) on delete cascade,
  name text not null,
  captain_id uuid not null references profiles(id) on delete cascade,
  roster text not null default '',
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  constraint league_team_name_len check (length(trim(name)) between 2 and 40),
  constraint league_team_roster_len check (length(roster) <= 1000),
  constraint league_team_status check (status in ('pending','accepted','rejected','withdrawn')),
  unique (competition_id, captain_id)
);
create unique index if not exists uq_league_team_name on league_teams(competition_id, lower(trim(name)));

create table if not exists league_matches (
  id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references league_competitions(id) on delete cascade,
  home_team_id uuid not null references league_teams(id) on delete cascade,
  away_team_id uuid not null references league_teams(id) on delete cascade,
  round_label text,
  scheduled_at timestamptz,
  home_score int,
  away_score int,
  status text not null default 'scheduled',
  created_at timestamptz not null default now(),
  constraint league_match_teams check (home_team_id <> away_team_id),
  constraint league_match_round_len check (round_label is null or length(round_label) <= 40),
  constraint league_match_scores check (
    (status = 'played' and home_score between 0 and 999 and away_score between 0 and 999)
    or (status <> 'played' and home_score is null and away_score is null)),
  constraint league_match_status check (status in ('scheduled','played','cancelled'))
);
create index if not exists idx_league_match on league_matches(competition_id, scheduled_at);

-- Lecture ouverte aux connectés (une compétition est publique dans la ville),
-- aucune écriture directe : tout passe par les fonctions ci-dessous.
alter table league_competitions enable row level security;
alter table league_teams enable row level security;
alter table league_matches enable row level security;

drop policy if exists league_comp_select on league_competitions;
create policy league_comp_select on league_competitions for select to authenticated using (true);
drop policy if exists league_team_select on league_teams;
create policy league_team_select on league_teams for select to authenticated using (true);
drop policy if exists league_match_select on league_matches;
create policy league_match_select on league_matches for select to authenticated using (true);

-- ----------------------------------------------------------------------------
-- Qui gère une compétition : son organisateur, la direction de l'organisation
-- qui la porte (elle ne meurt pas avec le départ d'un employé), l'admin Newpad.
-- ----------------------------------------------------------------------------
create or replace function league_can_manage(p_competition_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1 from league_competitions c
    where c.id = p_competition_id
      and (c.host_id = auth.uid()
           or (c.organization_id is not null and is_org_manager(c.organization_id))
           or is_newpad_admin())
  );
$function$;

create or replace function league_save(
  p_name text, p_discipline text, p_description text default '',
  p_id uuid default null, p_prize_info text default null,
  p_max_teams int default null, p_organization_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid;
begin
  perform require_active_profile();
  if p_organization_id is not null and not is_org_member(p_organization_id) then
    raise exception 'Vous ne faites pas partie de cette organisation';
  end if;

  if p_id is null then
    insert into league_competitions (host_id, organization_id, name, discipline, description,
                                     prize_info, max_teams)
    values (auth.uid(), p_organization_id, trim(p_name), trim(p_discipline),
            coalesce(p_description, ''), nullif(trim(coalesce(p_prize_info, '')), ''), p_max_teams)
    returning id into v_id;
  else
    if not league_can_manage(p_id) then raise exception 'Cette compétition n''est pas la vôtre'; end if;
    update league_competitions set
      name = trim(p_name), discipline = trim(p_discipline),
      description = coalesce(p_description, ''),
      prize_info = nullif(trim(coalesce(p_prize_info, '')), ''),
      max_teams = p_max_teams, organization_id = p_organization_id
    where id = p_id
    returning id into v_id;
  end if;
  return v_id;
end;
$function$;

create or replace function league_set_status(p_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_comp record; v_team record;
begin
  perform require_active_profile();
  if p_status not in ('open','running','finished','cancelled') then raise exception 'Statut invalide'; end if;
  if not league_can_manage(p_id) then raise exception 'Cette compétition n''est pas la vôtre'; end if;
  select id, name into v_comp from league_competitions where id = p_id;
  update league_competitions set status = p_status where id = p_id;
  if p_status in ('running','finished','cancelled') then
    for v_team in select captain_id from league_teams where competition_id = p_id and status = 'accepted' loop
      perform notify(v_team.captain_id, 'league', v_comp.name,
        case p_status when 'running' then 'La compétition commence.'
                      when 'finished' then 'La compétition est terminée : consultez le classement final.'
                      else 'La compétition est annulée.' end, '/league');
    end loop;
  end if;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Inscriptions
-- ----------------------------------------------------------------------------
create or replace function league_register(p_competition_id uuid, p_team_name text, p_roster text default '')
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_comp record; v_id uuid;
begin
  perform require_active_profile();
  select id, name, status, host_id into v_comp from league_competitions where id = p_competition_id;
  if v_comp.id is null then raise exception 'Compétition introuvable'; end if;
  if v_comp.status <> 'open' then raise exception 'Les inscriptions sont closes'; end if;
  if exists (select 1 from league_teams where competition_id = p_competition_id
               and captain_id = auth.uid() and status in ('pending','accepted')) then
    raise exception 'Vous avez déjà une équipe inscrite';
  end if;

  -- Une équipe retirée ou refusée peut se représenter : on réutilise sa ligne
  -- (un capitaine = une ligne par compétition).
  update league_teams set name = trim(p_team_name), roster = coalesce(p_roster, ''), status = 'pending',
                          created_at = now()
   where competition_id = p_competition_id and captain_id = auth.uid()
  returning id into v_id;
  if v_id is null then
    insert into league_teams (competition_id, name, captain_id, roster)
    values (p_competition_id, trim(p_team_name), auth.uid(), coalesce(p_roster, ''))
    returning id into v_id;
  end if;

  perform notify(v_comp.host_id, 'league', 'Nouvelle inscription',
                 trim(p_team_name) || ' — ' || v_comp.name, '/league');
  return v_id;
exception when unique_violation then
  raise exception 'Ce nom d''équipe est déjà pris dans cette compétition';
end;
$function$;

create or replace function league_withdraw(p_team_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_team record;
begin
  perform require_active_profile();
  select t.id, t.captain_id, c.status into v_team
    from league_teams t join league_competitions c on c.id = t.competition_id where t.id = p_team_id;
  if v_team.id is null then raise exception 'Équipe introuvable'; end if;
  if v_team.captain_id <> auth.uid() then raise exception 'Seul le capitaine peut retirer l''équipe'; end if;
  if v_team.status <> 'open' then raise exception 'La compétition a commencé : adressez-vous à l''organisateur'; end if;
  update league_teams set status = 'withdrawn' where id = p_team_id;
end;
$function$;

create or replace function league_decide_team(p_team_id uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_team record; v_max int; v_nb int;
begin
  perform require_active_profile();
  select t.id, t.name, t.captain_id, t.competition_id, c.name as comp_name, c.max_teams
    into v_team
    from league_teams t join league_competitions c on c.id = t.competition_id where t.id = p_team_id;
  if v_team.id is null then raise exception 'Équipe introuvable'; end if;
  if not league_can_manage(v_team.competition_id) then raise exception 'Cette compétition n''est pas la vôtre'; end if;

  if p_accept then
    select count(*) into v_nb from league_teams
     where competition_id = v_team.competition_id and status = 'accepted' and id <> p_team_id;
    if v_team.max_teams is not null and v_nb >= v_team.max_teams then
      raise exception 'La compétition est complète (% équipes)', v_team.max_teams;
    end if;
  end if;

  update league_teams set status = case when p_accept then 'accepted' else 'rejected' end where id = p_team_id;
  perform notify(v_team.captain_id, 'league', v_team.comp_name,
                 v_team.name || case when p_accept then ' est inscrite.' else ' n''a pas été retenue.' end, '/league');
end;
$function$;

-- ----------------------------------------------------------------------------
-- Rencontres
-- ----------------------------------------------------------------------------
create or replace function league_add_match(
  p_competition_id uuid, p_home_team_id uuid, p_away_team_id uuid,
  p_scheduled_at timestamptz default null, p_round_label text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid; v_nb int;
begin
  perform require_active_profile();
  if not league_can_manage(p_competition_id) then raise exception 'Cette compétition n''est pas la vôtre'; end if;
  if p_home_team_id = p_away_team_id then raise exception 'Une équipe ne joue pas contre elle-même'; end if;
  select count(*) into v_nb from league_teams
   where id in (p_home_team_id, p_away_team_id) and competition_id = p_competition_id and status = 'accepted';
  if v_nb <> 2 then raise exception 'Les deux équipes doivent être inscrites à cette compétition'; end if;

  insert into league_matches (competition_id, home_team_id, away_team_id, scheduled_at, round_label)
  values (p_competition_id, p_home_team_id, p_away_team_id, p_scheduled_at,
          nullif(trim(coalesce(p_round_label, '')), ''))
  returning id into v_id;
  return v_id;
end;
$function$;

create or replace function league_set_result(p_match_id uuid, p_home_score int, p_away_score int)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_m record;
begin
  perform require_active_profile();
  select m.id, m.competition_id, h.name as home, a.name as away, h.captain_id as hc, a.captain_id as ac,
         c.name as comp
    into v_m
    from league_matches m
    join league_teams h on h.id = m.home_team_id
    join league_teams a on a.id = m.away_team_id
    join league_competitions c on c.id = m.competition_id
   where m.id = p_match_id;
  if v_m.id is null then raise exception 'Rencontre introuvable'; end if;
  if not league_can_manage(v_m.competition_id) then raise exception 'Cette compétition n''est pas la vôtre'; end if;

  if p_home_score is null or p_away_score is null then
    -- Annuler une saisie : la rencontre redevient à jouer.
    update league_matches set status = 'scheduled', home_score = null, away_score = null where id = p_match_id;
    return;
  end if;
  if p_home_score < 0 or p_away_score < 0 then raise exception 'Score invalide'; end if;

  update league_matches set status = 'played', home_score = p_home_score, away_score = p_away_score
   where id = p_match_id;
  perform notify(x, 'league', v_m.comp,
                 v_m.home || ' ' || p_home_score || ' – ' || p_away_score || ' ' || v_m.away, '/league')
    from unnest(array[v_m.hc, v_m.ac]) as x;
end;
$function$;

create or replace function league_cancel_match(p_match_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_comp uuid;
begin
  perform require_active_profile();
  select competition_id into v_comp from league_matches where id = p_match_id;
  if v_comp is null then raise exception 'Rencontre introuvable'; end if;
  if not league_can_manage(v_comp) then raise exception 'Cette compétition n''est pas la vôtre'; end if;
  delete from league_matches where id = p_match_id;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Lecture
-- ----------------------------------------------------------------------------
create or replace function league_list(p_scope text default 'all')
returns table (id uuid, name text, discipline text, prize_info text, status text,
               organizer text, nb_teams bigint, max_teams int, my_team_status text,
               can_manage boolean, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  return query
    select c.id, c.name, c.discipline, c.prize_info, c.status,
           coalesce(o.name, p.display_name),
           (select count(*) from league_teams t where t.competition_id = c.id and t.status = 'accepted'),
           c.max_teams,
           (select t.status from league_teams t where t.competition_id = c.id and t.captain_id = auth.uid()),
           league_can_manage(c.id),
           c.created_at
    from league_competitions c
    join profiles p on p.id = c.host_id
    left join organizations o on o.id = c.organization_id
    where coalesce(p_scope, 'all') = 'all'
       or league_can_manage(c.id)
       or exists (select 1 from league_teams t where t.competition_id = c.id and t.captain_id = auth.uid())
    order by case c.status when 'running' then 0 when 'open' then 1 when 'finished' then 2 else 3 end,
             c.created_at desc
    limit 200;
end;
$function$;

create or replace function league_detail(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_manage boolean; v jsonb;
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  if not exists (select 1 from league_competitions where id = p_id) then
    raise exception 'Compétition introuvable';
  end if;
  v_manage := league_can_manage(p_id);

  select jsonb_build_object(
    'id', c.id, 'name', c.name, 'discipline', c.discipline, 'description', c.description,
    'prize_info', c.prize_info, 'max_teams', c.max_teams, 'status', c.status,
    'organization_id', c.organization_id,
    'organizer', coalesce(o.name, p.display_name),
    'can_manage', v_manage,
    'my_team', (select jsonb_build_object('id', t.id, 'name', t.name, 'status', t.status, 'roster', t.roster)
                  from league_teams t where t.competition_id = c.id and t.captain_id = auth.uid()),
    -- Les équipes en attente ou refusées ne regardent que l'organisateur.
    'teams', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', t.id, 'name', t.name, 'status', t.status, 'roster', t.roster,
                 'captain', cp.display_name) order by t.status, t.created_at)
               from league_teams t join profiles cp on cp.id = t.captain_id
               where t.competition_id = c.id and (t.status = 'accepted' or v_manage)), '[]'::jsonb),
    'matches', coalesce((select jsonb_agg(jsonb_build_object(
                 'id', m.id, 'home', h.name, 'away', a.name, 'round', m.round_label,
                 'scheduled_at', m.scheduled_at, 'status', m.status,
                 'home_score', m.home_score, 'away_score', m.away_score)
                 order by m.scheduled_at nulls last, m.created_at)
               from league_matches m
               join league_teams h on h.id = m.home_team_id
               join league_teams a on a.id = m.away_team_id
               where m.competition_id = c.id), '[]'::jsonb),
    'standings', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.pts desc, s.diff desc, s.bp desc, s.name)
      from (
        select t.name,
               count(r.gf) as j,
               count(*) filter (where r.gf > r.ga) as g,
               count(*) filter (where r.gf = r.ga) as n,
               count(*) filter (where r.gf < r.ga) as p,
               coalesce(sum(r.gf), 0) as bp,
               coalesce(sum(r.ga), 0) as bc,
               coalesce(sum(r.gf - r.ga), 0) as diff,
               coalesce(sum(case when r.gf > r.ga then 3 when r.gf = r.ga then 1 else 0 end), 0) as pts
        from league_teams t
        left join lateral (
          select m.home_score as gf, m.away_score as ga from league_matches m
           where m.home_team_id = t.id and m.status = 'played'
          union all
          select m.away_score, m.home_score from league_matches m
           where m.away_team_id = t.id and m.status = 'played'
        ) r on true
        where t.competition_id = c.id and t.status = 'accepted'
        group by t.id, t.name
      ) s), '[]'::jsonb)
  ) into v
  from league_competitions c
  join profiles p on p.id = c.host_id
  left join organizations o on o.id = c.organization_id
  where c.id = p_id;
  return v;
end;
$function$;

update app_registry set status = 'live' where slug = 'league';

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

-- Permissions : les nouvelles fonctions héritent d'EXECUTE pour PUBLIC (donc
-- anon) par défaut dans PostgreSQL. On ne touche qu'à elles, plutôt que de
-- rejouer le balayage complet de 0038.
revoke execute on function league_can_manage(uuid) from public, anon;
revoke execute on function league_save(text, text, text, uuid, text, int, uuid) from public, anon;
revoke execute on function league_set_status(uuid, text) from public, anon;
revoke execute on function league_register(uuid, text, text) from public, anon;
revoke execute on function league_withdraw(uuid) from public, anon;
revoke execute on function league_decide_team(uuid, boolean) from public, anon;
revoke execute on function league_add_match(uuid, uuid, uuid, timestamptz, text) from public, anon;
revoke execute on function league_set_result(uuid, int, int) from public, anon;
revoke execute on function league_cancel_match(uuid) from public, anon;
revoke execute on function league_list(text) from public, anon;
revoke execute on function league_detail(uuid) from public, anon;

grant execute on function league_can_manage(uuid) to authenticated;
grant execute on function league_save(text, text, text, uuid, text, int, uuid) to authenticated;
grant execute on function league_set_status(uuid, text) to authenticated;
grant execute on function league_register(uuid, text, text) to authenticated;
grant execute on function league_withdraw(uuid) to authenticated;
grant execute on function league_decide_team(uuid, boolean) to authenticated;
grant execute on function league_add_match(uuid, uuid, uuid, timestamptz, text) to authenticated;
grant execute on function league_set_result(uuid, int, int) to authenticated;
grant execute on function league_cancel_match(uuid) to authenticated;
grant execute on function league_list(text) to authenticated;
grant execute on function league_detail(uuid) to authenticated;

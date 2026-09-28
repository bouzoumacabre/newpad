-- ############################################################################
-- 0060 — NEW AI : le quota
-- ############################################################################
-- L'assistant appelle l'API Claude depuis l'Edge Function `new-ai` : chaque
-- message coûte de l'argent réel. Le quota vit EN BASE, décompté AVANT l'appel
-- par la fonction elle-même, avec le jeton de l'utilisateur (auth.uid()) — un
-- client ne peut ni le contourner ni le remettre à zéro.
--
-- Aucune conversation n'est stockée : l'historique reste dans le navigateur
-- du joueur, le temps de la session.
-- ############################################################################

create table if not exists ai_usage (
  profile_id uuid not null references profiles(id) on delete cascade,
  day date not null default current_date,
  messages int not null default 0,
  primary key (profile_id, day)
);
alter table ai_usage enable row level security;
-- Aucune policy : lecture et écriture uniquement par les fonctions ci-dessous.

-- ponytail: quota fixe à 30 messages par jour et par joueur ; en faire un
-- réglage d'economic_settings le jour où il faudra l'ajuster sans migration.
create or replace function ai_daily_limit()
returns int
language sql
immutable
set search_path to 'public', 'pg_temp'
as $function$ select 30 $function$;

-- Consomme un message. Atomique : deux appels simultanés ne peuvent pas
-- dépasser la limite (la mise à jour ne passe que sous le plafond).
create or replace function ai_consume()
returns int
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v int;
begin
  if not can_open_app('ai') then raise exception 'Accès refusé'; end if;
  perform require_active_profile();

  insert into ai_usage (profile_id, day, messages) values (auth.uid(), current_date, 1)
  on conflict (profile_id, day) do update set messages = ai_usage.messages + 1
    where ai_usage.messages < ai_daily_limit()
  returning messages into v;

  if v is null then
    raise exception 'Quota du jour atteint (% messages). Revenez demain.', ai_daily_limit();
  end if;
  return ai_daily_limit() - v;
end;
$function$;

-- Pas de remboursement en cas d'échec de l'appel : une fonction de
-- remboursement appelable par le joueur lui donnerait un quota infini.

create or replace function ai_remaining()
returns int
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not can_open_app('ai') then raise exception 'Accès refusé'; end if;
  return ai_daily_limit() - coalesce(
    (select messages from ai_usage where profile_id = auth.uid() and day = current_date), 0);
end;
$function$;

-- L'application reste « bientôt » : elle passe en ligne depuis la console
-- d'administration une fois la clé ANTHROPIC_API_KEY posée dans les secrets
-- des Edge Functions.

revoke execute on function ai_daily_limit() from public, anon;
revoke execute on function ai_consume() from public, anon;
revoke execute on function ai_remaining() from public, anon;
grant execute on function ai_daily_limit() to authenticated;
grant execute on function ai_consume() to authenticated;
grant execute on function ai_remaining() to authenticated;

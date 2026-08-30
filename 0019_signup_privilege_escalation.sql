-- ============================================================================
-- NEWPAD — Migration 0019 : élévation de privilèges à l'inscription
-- ============================================================================
-- FAILLE CRITIQUE — corrigée ici. Trouvée le 25/08/2026 lors de l'audit
-- fonctionnalité par fonctionnalité, en commençant par l'inscription.
-- ============================================================================
--
-- LE PROBLÈME
--
-- Le trigger handle_new_auth_user lisait le rôle du nouveau profil dans
-- `raw_user_meta_data` :
--
--     coalesce((new.raw_user_meta_data->>'role')::user_role, 'prospect')
--
-- Or `raw_user_meta_data` est alimenté par le champ `data` de l'appel
-- /auth/v1/signup — un endpoint PUBLIC, non authentifié, dont le contenu est
-- intégralement choisi par l'appelant. Le formulaire d'inscription du site y
-- envoie sagement `role: 'prospect'`, mais rien n'oblige à passer par le
-- formulaire : un simple appel HTTP à l'API Supabase avec
--
--     { "email": "...", "password": "...", "data": { "role": "admin" } }
--
-- suffisait à créer un compte administrateur. C'est-à-dire : lecture de tous
-- les comptes et transactions de tous les clients, ajustement de n'importe
-- quel solde, suppression de comptes, pilotage de l'économie entière.
-- Exploitable par n'importe qui depuis Internet, sans aucun compte préalable.
--
-- Vérification faite avant correction : les 3 comptes élevés existants
-- (1 admin, 1 employé, 1 IRS) sont légitimes et correspondent aux créations
-- attendues. Aucune exploitation n'a eu lieu.
--
--
-- LA CORRECTION
--
-- Supabase distingue deux jeux de métadonnées :
--   - `user_metadata` (raw_user_meta_data) : écrit par l'utilisateur, y
--     compris à l'inscription publique. À ne JAMAIS croire pour une décision
--     d'autorisation.
--   - `app_metadata` (raw_app_meta_data) : écrit uniquement par l'API admin
--     avec la clé service_role. Le endpoint public d'inscription ne peut pas
--     y toucher.
--
-- Le rôle est désormais lu dans `app_metadata`. Une inscription publique n'y
-- ayant accès en aucune façon, elle retombe systématiquement sur 'prospect'
-- — le rôle le moins privilégié, qui ne donne accès qu'à l'écran d'attente.
-- La seule voie pour créer un compte privilégié reste l'Edge Function
-- `create-account` (déployée en v6 juste avant cette migration), qui vérifie
-- elle-même que l'appelant est admin.
--
-- Les autres champs (username, display_name, discord_id, phone_number)
-- restent lus dans user_metadata : ce sont des données déclaratives sans
-- portée d'autorisation, et l'utilisateur est légitime à les fournir.

create or replace function handle_new_auth_user()
returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_role user_role;
begin
  if coalesce(new.raw_user_meta_data->>'honeypot', '') != '' then
    raise exception 'Inscription refusée';
  end if;

  -- Rôle : app_metadata uniquement (voir l'en-tête de cette migration).
  -- Toute valeur absente ou non reconnue retombe sur 'prospect'.
  begin
    v_role := coalesce((new.raw_app_meta_data->>'role')::user_role, 'prospect');
  exception when others then
    v_role := 'prospect';
  end;

  insert into profiles (id, username, role, display_name, discord_id, phone_number)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    v_role,
    coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    nullif(new.raw_user_meta_data->>'discord_id', ''),
    nullif(new.raw_user_meta_data->>'phone_number', '')
  );
  return new;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Filet de sécurité : détection d'une élévation déjà exploitée
-- ----------------------------------------------------------------------------
-- Si un compte privilégié avait été créé par la faille, il porterait un rôle
-- élevé dans `profiles` sans le rôle correspondant dans app_metadata. Cette
-- requête le remonterait. Elle est en lecture seule et ne corrige rien
-- d'elle-même : rétrograder automatiquement un compte serait plus dangereux
-- que le signaler (un faux positif couperait l'accès d'un admin légitime).
do $$
declare
  v_suspects int;
begin
  select count(*) into v_suspects
  from profiles p
  join auth.users u on u.id = p.id
  where p.role in ('employee', 'admin', 'irs')
    and coalesce(u.raw_app_meta_data->>'role', '') <> p.role::text;

  if v_suspects > 0 then
    raise warning 'ATTENTION : % compte(s) privilégié(s) sans rôle correspondant dans app_metadata. À vérifier manuellement — ils peuvent être légitimes (créés avant ce correctif) ou issus d''une exploitation.', v_suspects;
  end if;
end $$;

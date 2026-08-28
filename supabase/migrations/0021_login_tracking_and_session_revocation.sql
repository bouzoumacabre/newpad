-- ============================================================================
-- NEWPAD — Migration 0021 : journal de connexion et révocation de sessions
-- ============================================================================
-- Audit fonctionnalité par fonctionnalité — étape 2 : connexion, session et
-- réinitialisation de mot de passe.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. RÉGRESSION : les échecs de connexion ne sont plus enregistrés du tout
-- ----------------------------------------------------------------------------
-- Constat sur les données de production :
--   dernier ÉCHEC enregistré  : 24/08/2026
--   dernier SUCCÈS enregistré : 26/08/2026
--
-- Cause : `record_login_attempt` est appelée depuis l'écran de connexion,
-- donc AVANT que la session existe. En cas d'échec, l'appelant est encore
-- `anon` — or le durcissement global des permissions d'exécution (0006b, puis
-- réappliqué en 0015) a retiré EXECUTE à `anon` sur toutes les fonctions.
-- L'appel échouait donc silencieusement (il est enveloppé dans un try/catch
-- « non bloquant » côté client), et toute la détection de fraude sur les
-- tentatives répétées est morte sans que rien ne le signale.
--
-- Régression introduite par mes propres migrations de durcissement : c'est
-- exactement le genre d'effet de bord qu'un revoke global provoque, et la
-- raison pour laquelle cette fonction doit être traitée à part.
--
--
-- 2. Le résultat de la tentative était dicté par le client
--
-- La fonction recevait `p_success` en paramètre et le croyait sur parole. Un
-- utilisateur authentifié pouvait donc :
--   - déclarer des succès fictifs pour masquer une attaque en cours ;
--   - déclarer des ÉCHECS au nom de n'importe quel autre client, pour faire
--     lever des alertes de fraude contre lui.
-- Le succès est désormais déterminé côté serveur : il n'est retenu que si
-- l'appelant possède réellement une session pour ce compte (auth.uid()
-- correspond au profil visé). C'est la seule preuve non falsifiable dont on
-- dispose, et elle est gratuite.
--
--
-- 3. Une alerte de fraude créée à CHAQUE tentative au-delà du seuil
--
-- Le test `if v_recent_failures >= v_threshold` déclenchait une nouvelle
-- alerte pour chaque tentative suivante : 100 essais produisaient 95 alertes,
-- noyant l'écran des alertes au moment précis où il devient utile. Une seule
-- alerte est désormais créée par identifiant et par fenêtre de 15 minutes.

create or replace function record_login_attempt(p_username text, p_success boolean)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_profile_id uuid;
  v_recent_failures int;
  v_threshold int;
  v_success boolean;
  v_username text;
begin
  v_username := lower(trim(coalesce(p_username, '')));
  if v_username = '' then return; end if;

  select id into v_profile_id from profiles where username = v_username;

  -- Le succès ne peut pas être déclaré par le client : il n'est retenu que si
  -- l'appelant détient effectivement une session sur ce compte. Toute autre
  -- situation est journalisée comme un échec. `p_success` n'est plus utilisé
  -- que comme indication : il ne peut jamais transformer un échec en succès.
  v_success := coalesce(p_success, false)
               and v_profile_id is not null
               and auth.uid() = v_profile_id;

  insert into login_log (profile_id, username_attempted, success)
  values (v_profile_id, v_username, v_success);

  if not v_success then
    select count(*) into v_recent_failures from login_log
    where username_attempted = v_username and success = false and created_at > now() - interval '15 minutes';

    v_threshold := coalesce((get_setting('fraud_failed_login_threshold')->>'amount')::int, 5);

    -- Une seule alerte par identifiant et par fenêtre : au-delà du seuil,
    -- chaque tentative supplémentaire en créait une nouvelle.
    if v_recent_failures >= v_threshold
       and not exists (
         select 1 from fraud_alerts
         where rule_key = 'failed_login_attempts'
           and description like '%' || v_username || '%'
           and created_at > now() - interval '15 minutes'
       )
    then
      perform create_fraud_alert('auto', 'failed_login_attempts', 'high', v_profile_id, null, null,
        'Tentatives de connexion échouées répétées pour ' || v_username);
    end if;
  end if;
end;
$function$;

-- Exception assumée au durcissement global : cette fonction DOIT être
-- appelable sans session, puisqu'elle sert précisément à enregistrer les
-- connexions qui échouent. Elle n'expose aucune donnée en retour (returns
-- void) et ne peut plus être détournée pour falsifier un succès (voir §2).
grant execute on function record_login_attempt(text, boolean) to anon;


-- ----------------------------------------------------------------------------
-- 4. Un changement de mot de passe ne déconnectait pas les sessions ouvertes
-- ----------------------------------------------------------------------------
-- Après une réinitialisation via Discord, les sessions déjà ouvertes restaient
-- parfaitement valides : leurs jetons de rafraîchissement continuaient de
-- fonctionner. Or le cas d'usage principal d'une réinitialisation est
-- justement le compte compromis — le propriétaire légitime reprenait la main
-- pendant que l'intrus gardait son accès intact, sans aucun moyen de l'en
-- déloger.
--
-- Cette fonction supprime les sessions d'un utilisateur. Elle est réservée au
-- rôle `service_role` (donc aux Edge Functions) : aucun client, même
-- authentifié, ne peut déconnecter qui que ce soit.
create or replace function revoke_user_sessions(p_user_id uuid)
returns integer
language plpgsql security definer
set search_path to 'auth', 'public', 'pg_temp'
as $function$
declare
  v_count integer;
begin
  if p_user_id is null then return 0; end if;

  delete from auth.refresh_tokens where user_id::text = p_user_id::text;
  delete from auth.sessions where user_id = p_user_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

revoke execute on function revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function revoke_user_sessions(uuid) to service_role;

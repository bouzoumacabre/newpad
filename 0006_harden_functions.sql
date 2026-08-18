-- ============================================================================
-- NEWPAD — Migration 0006 : durcissement sécurité des fonctions
-- ============================================================================
-- Corrige deux avertissements remontés par les advisors Supabase après le
-- déploiement complet :
-- 1. "Function Search Path Mutable" : toute fonction SECURITY DEFINER doit
--    fixer explicitement son search_path (sinon un search_path manipulable
--    pourrait, en théorie, faire résoudre un appel vers un objet différent
--    de celui prévu). On le fixe sur toutes les fonctions SECURITY DEFINER
--    du schéma public, automatiquement via pg_proc (pas besoin de lister
--    chaque signature à la main).
-- 2. "Public/Signed-In Users Can Execute SECURITY DEFINER Function" : par
--    défaut Postgres accorde EXECUTE à PUBLIC (donc au rôle anon) sur toute
--    nouvelle fonction. Aucune fonction métier de Newpad n'a besoin d'être
--    appelable par un visiteur non connecté (le contenu public passe par une
--    lecture de table directe via RLS, pas par une fonction) : on retire
--    l'exécution à PUBLIC et on ne l'accorde qu'à authenticated/service_role.
-- ============================================================================

do $$
declare
  r record;
begin
  for r in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef = true
  loop
    execute format('alter function public.%I(%s) set search_path = public, pg_temp', r.proname, r.args);
  end loop;
end $$;

revoke execute on all functions in schema public from public;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

-- Les triggers (handle_new_auth_user, set_updated_at, enforce_profile_self_update)
-- continuent de fonctionner : ils s'exécutent avec les privilèges attachés à
-- la fonction elle-même (ou à auth.users pour le premier), jamais via un
-- appel EXECUTE direct d'un rôle client.

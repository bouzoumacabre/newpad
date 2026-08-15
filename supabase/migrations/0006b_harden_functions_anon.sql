-- ============================================================================
-- NEWPAD — Migration 0006b : complément durcissement — Supabase accorde par
-- défaut EXECUTE à `anon` explicitement (pas seulement via PUBLIC) à la
-- création de toute fonction ; "revoke ... from public" (0006) ne suffit
-- donc pas à retirer ce droit déjà accordé explicitement à `anon`. On le
-- retire ici explicitement. Fixe aussi le search_path des 4 fonctions
-- restées hors du balayage automatique de 0006 (fonctions non SECURITY
-- DEFINER : set_updated_at, enforce_profile_self_update, ainsi que
-- _bypass_profile_guard et generate_iban qui sont SECURITY DEFINER mais
-- avaient été créées/redéfinies après le balayage dans le même run — on les
-- corrige explicitement par sécurité).
-- ============================================================================

revoke execute on all functions in schema public from anon;
grant execute on function irs_stats() to authenticated; -- no-op explicite, clarifie l'intention : IRS reste un rôle applicatif, pas un rôle Postgres

alter function public._bypass_profile_guard() set search_path = public, pg_temp;
alter function public.set_updated_at() set search_path = public, pg_temp;
alter function public.generate_iban() set search_path = public, pg_temp;
alter function public.enforce_profile_self_update() set search_path = public, pg_temp;

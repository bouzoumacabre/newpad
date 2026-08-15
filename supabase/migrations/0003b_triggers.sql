-- ============================================================================
-- NEWPAD — Migration 0003b : garde-fous supplémentaires
-- ============================================================================

-- Un self-update sur profiles (RLS profiles_self_update) ne doit jamais
-- pouvoir changer role / status / trust_score / min_balance_override /
-- min_transfer_override / username — ces champs sont réservés à l'admin
-- (via profiles_admin_all) ou aux fonctions dédiées.
create or replace function enforce_profile_self_update() returns trigger
language plpgsql as $$
begin
  if is_admin() or auth.uid() is null or coalesce(current_setting('app.bypass_profile_guard', true), '') = 'true' then
    -- is_admin() : l'admin passe par sa propre policy, pas de restriction.
    -- auth.uid() is null : appel hors contexte utilisateur (service_role via
    -- Edge Function, ou SQL Editor Supabase) — c'est le seul moyen de
    -- promouvoir le tout premier compte admin sur une base fraîchement créée.
    -- bypass_profile_guard : activé pour la transaction en cours uniquement
    -- par une fonction SECURITY DEFINER de confiance (ex. activation auto du
    -- compte client après validation d'adhésion, mise à jour de la note de
    -- confiance) — voir _bypass_profile_guard() en 0002.
    return new;
  end if;
  if new.role is distinct from old.role
     or new.status is distinct from old.status
     or new.trust_score is distinct from old.trust_score
     or new.min_balance_override is distinct from old.min_balance_override
     or new.min_transfer_override is distinct from old.min_transfer_override
     or new.username is distinct from old.username
     or new.client_since is distinct from old.client_since then
    raise exception 'Modification non autorisée sur ce champ de profil';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_profile_self_update on profiles;
create trigger trg_enforce_profile_self_update
  before update on profiles
  for each row execute function enforce_profile_self_update();

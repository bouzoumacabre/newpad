-- ============================================================================
-- NEWPAD — Migration 0015 : rattrapage sécurité + petites évolutions
-- (audit complet du projet mené le 25/08/2026, à l'initiative de Claude)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Rattrapage exécution des fonctions — le durcissement global (0006/0006b :
--    revoke public/anon puis grant authenticated+service_role sur TOUTES les
--    fonctions) est un instantané figé au moment où il a tourné. Chaque
--    fonction créée depuis (migrations 0007 à 0014) a hérité du comportement
--    par défaut de PostgreSQL (EXECUTE accordé à PUBLIC à la création), donc
--    à `anon` — confirmé par les avis de sécurité Supabase : 22 fonctions
--    SECURITY DEFINER exécutables par un visiteur non connecté, dont
--    admin_delete_account, admin_adjust_account_balance,
--    staff_decide_safe_request, create_message_thread, upsert_client_info...
--    Ces fonctions vérifient toutes le rôle en interne (is_admin()/is_staff()/
--    auth.uid()), donc aucun appel anonyme ne pouvait aboutir, mais
--    l'exposition elle-même n'était pas voulue et doit être refermée
--    (défense en profondeur — idempotent, sans effet sur les fonctions déjà
--    correctement configurées).
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

-- ----------------------------------------------------------------------------
-- 2. economic_settings : la lecture publique voulue par la migration 0014
--    (mode maintenance / bannière visibles sans connexion) ouvrait par
--    erreur TOUTE la table — taux, plafonds, seuils de détection de fraude,
--    cours de l'or, lisibles par n'importe quel visiteur anonyme via un
--    simple appel REST. Restreint au strict nécessaire.
drop policy if exists economic_settings_select on economic_settings;
create policy economic_settings_select on economic_settings
  for select using (key in ('maintenance_mode', 'announcement_banner') or auth.uid() is not null);

-- ----------------------------------------------------------------------------
-- 3. gold_bars : un client connecté pouvait lire la table entière (tous les
--    lingots de tous les clients, propriétaire y compris) via une requête
--    REST directe — la restriction "mes lingots seulement" n'existait que
--    côté frontend, pas dans la policy elle-même.
drop policy if exists gold_bars_select on gold_bars;
create policy gold_bars_select on gold_bars
  for select using (owner_client_id = auth.uid() or owner_client_id is null or is_staff());

-- ----------------------------------------------------------------------------
-- 4. charge_account_fees() : seule fonction oubliée lors du durcissement
--    search_path de 0006/0006b (recréée après coup par 0012 sans la clause).
alter function charge_account_fees() set search_path to 'public', 'pg_temp';

-- ----------------------------------------------------------------------------
-- 5. Un client pouvait mettre un lingot en vente sur le marché mais ne
--    pouvait jamais annuler lui-même son annonce (seul admin_cancel_market_
--    listing existait, réservé au personnel) — il devait passer par le
--    support pour retirer son propre bien de la vente.
create or replace function cancel_market_listing(p_listing_id uuid) returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_listing gold_market_listings%rowtype;
begin
  select * into v_listing from gold_market_listings where id = p_listing_id and status = 'active';
  if v_listing is null then raise exception 'Annonce introuvable ou déjà close'; end if;
  if v_listing.seller_client_id is null or v_listing.seller_client_id <> auth.uid() then
    raise exception 'Cette annonce ne vous appartient pas';
  end if;

  update gold_market_listings set status = 'cancelled', cancelled_at = now() where id = p_listing_id;
  update gold_bars set status = 'in_vault' where id = v_listing.gold_bar_id and status = 'listed';
  perform log_audit('cancel_market_listing', 'gold_market_listings', p_listing_id, '{}'::jsonb);
end;
$function$;

revoke execute on function cancel_market_listing(uuid) from public, anon;
grant execute on function cancel_market_listing(uuid) to authenticated;

-- ============================================================================
-- NEWPAD — Migration 0038 : les fonctions internes étaient appelables en REST
-- ============================================================================
-- Audit fonctionnalité par fonctionnalité — étape 13 (vérification finale).
--
-- Trouvé en relisant les avis de sécurité Supabase après les douze étapes
-- précédentes. C'est le défaut le plus grave de tout l'audit.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- `_adjust_balance` était appelable par n'importe quel client connecté
-- ----------------------------------------------------------------------------
-- `_adjust_balance(p_account_id uuid, p_delta numeric)` est LE point de passage
-- unique de tout mouvement d'argent de la banque. Toute la conception repose
-- sur cette idée : aucun solde ne bouge sans passer par là, et les fonctions
-- métier qui l'appellent portent les contrôles.
--
-- Elle-même n'en porte aucun — c'est normal, ce n'est pas son rôle. Mais elle
-- était exposée en `SECURITY DEFINER` sur `/rest/v1/rpc/_adjust_balance`, avec
-- le droit d'exécution accordé au rôle `authenticated`. N'importe quel client
-- connecté pouvait donc, en une requête HTTP et avec la clé publique que le
-- site lui fournit déjà :
--
--     POST /rest/v1/rpc/_adjust_balance
--     { "p_account_id": "<son compte>", "p_delta": 999999999 }
--
-- créditer n'importe quel compte de n'importe quel montant, sans qu'aucune
-- ligne n'apparaisse dans `transactions`. Toutes les protections construites
-- pendant les douze étapes précédentes — solde minimum, solvabilité de la
-- trésorerie, plafonds, découvert interdit — se contournaient par cette porte.
--
-- POURQUOI ELLE EST RESTÉE OUVERTE SI LONGTEMPS. Le bloc de permissions
-- réappliqué à chaque migration depuis 0006 procède ainsi :
--
--     revoke execute on all functions in schema public from public, anon;
--     grant  execute on all functions in schema public to authenticated;
--     revoke execute on function <liste d'exceptions> from authenticated;
--
-- Un `grant` global suivi d'une liste d'exceptions tenue à la main. Toute
-- fonction absente de la liste est ouverte par défaut, et chaque migration
-- réaffirmait ce choix. Mes propres migrations l'ont réaffirmé douze fois.
--
-- La correction ne se limite donc pas à ajouter une ligne à la liste : la
-- règle est inversée pour les fonctions internes. Toute fonction dont le nom
-- commence par `_` est, par convention de ce projet, un rouage interne appelé
-- uniquement depuis une autre fonction `SECURITY DEFINER` (où le droit est
-- évalué sur le propriétaire, pas sur l'appelant) ou depuis un déclencheur
-- (qui n'a pas besoin du droit d'exécution). Aucune n'a à être appelable
-- depuis le navigateur, et la révocation est faite par balayage plutôt que par
-- énumération — pour qu'une fonction interne ajoutée demain soit fermée sans
-- que quiconque ait à y penser.
--
-- Étaient concernées, en plus de `_adjust_balance` :
--
--   _update_gold_price_from_sale  → fixer le cours de l'or à la valeur voulue
--   _flag_unusual_transfer        → fonctions de déclencheur exposées en RPC
--   _log_gold_price_change
--   _reject_if_profile_inactive
--   _freeze_branch_queue_identity
--   _validate_economic_setting
--   _validate_manual_opening
--   _validate_site_content
--
-- Et hors convention `_`, `log_audit` : un client pouvait inscrire ce qu'il
-- voulait dans le journal d'activité — le seul registre censé faire foi.


-- ----------------------------------------------------------------------------
-- Permissions — désormais exprimées comme une règle, pas comme une liste
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

-- Exceptions ouvertes : les deux seules fonctions qu'un visiteur sans session
-- doit pouvoir appeler.
--   record_login_attempt : appelée par l'écran de connexion AVANT qu'une
--     session existe (régression corrigée en 0021 — sans ce grant, plus aucun
--     échec de connexion n'était journalisé).
--   gold_price_snapshot  : cours de l'or affiché sur la page d'accueil publique.
grant execute on function record_login_attempt(text, boolean) to anon;
grant execute on function gold_price_snapshot() to anon;

-- Règle : tout rouage interne (préfixe `_`) est fermé au navigateur.
do $do$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and left(p.proname, 1) = '_'
  loop
    execute format('revoke execute on function %s from authenticated', f.sig);
  end loop;
end
$do$;

-- Exceptions nommées, hors convention de préfixe.
revoke execute on function revoke_user_sessions(uuid) from authenticated;
revoke execute on function notify(uuid, text, text, text, text, jsonb) from authenticated;
revoke execute on function notify_all_staff(text, text, text, text, boolean) from authenticated;
revoke execute on function purge_old_notifications() from authenticated;
revoke execute on function log_audit(text, text, uuid, jsonb) from authenticated;
revoke execute on function generate_iban() from authenticated;

// ============================================================================
// NEWPAD — Résolution des fonctionnalités activées pour l'utilisateur courant.
// ============================================================================
// La règle (registre `feature_registry` + rôle par défaut + exception par
// compte `permission_grants`) était réimplémentée ici, dans le navigateur, en
// parallèle de `has_feature()` côté base. Deux implémentations de la même règle
// finissent toujours par diverger — et surtout, jusqu'à la migration 0033,
// celle-ci était la SEULE à s'exécuter : aucune fonction serveur n'appelait
// `has_feature`. Décocher une fonctionnalité ne faisait donc que masquer des
// boutons, la fonction restant appelable via l'API REST.
//
// Depuis 0033, le serveur refuse lui-même l'appel (`require_feature`), et cet
// écran ne fait plus qu'afficher ce que la base a décidé : `my_feature_flags()`
// renvoie, pour chaque clé du registre, la réponse de `has_feature`.
// ============================================================================

import { supabase } from './supabaseClient.js';

let cache = null;

async function loadFlags() {
  if (cache) return cache;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase.rpc('my_feature_flags');
  if (error) throw error;
  cache = data || [];
  return cache;
}

// Le cache vit le temps d'une session de navigation. Il est vidé après un
// changement de permissions depuis /admin/permissions, pour que l'écran
// reflète immédiatement ce qui vient d'être enregistré.
export function invalidateFeatureCache() {
  cache = null;
}

/**
 * @param {string} area - 'client' | 'employee' | 'admin' | 'irs'
 * @param {string} _role - conservé pour compatibilité d'appel ; le rôle est
 *   désormais déterminé côté serveur à partir de la session, jamais transmis
 *   par le navigateur.
 */
export async function getFeatureFlags(area, _role) {
  const rows = await loadFlags();
  const flags = {};
  for (const r of rows) {
    if (!area || r.area === area) flags[r.key] = r.allowed;
  }
  return flags;
}

// Toutes zones confondues — utile aux écrans qui recoupent plusieurs domaines.
export async function getAllFeatureFlags() {
  const rows = await loadFlags();
  return Object.fromEntries(rows.map((r) => [r.key, r.allowed]));
}

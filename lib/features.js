// ============================================================================
// NEWPAD — Résolution générique des fonctionnalités activées pour l'utilisateur
// courant (registre `feature_registry` + exceptions `permission_grants`),
// réutilisée par les coquilles Client et Employé.
// ============================================================================

import { supabase } from './supabaseClient.js';

export async function getFeatureFlags(area, role) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return {};
  const [{ data: features, error: e1 }, { data: grants, error: e2 }] = await Promise.all([
    supabase.from('feature_registry').select('*').eq('area', area),
    supabase.from('permission_grants').select('feature_key, granted').eq('account_id', user.id),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  const overrides = new Map((grants || []).map((g) => [g.feature_key, g.granted]));
  const flags = {};
  for (const f of features || []) {
    if (overrides.has(f.key)) { flags[f.key] = f.enabled && overrides.get(f.key); }
    else { flags[f.key] = f.enabled && (f.default_roles || []).includes(role); }
  }
  return flags;
}

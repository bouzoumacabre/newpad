// ============================================================================
// NEWPAD — Lecture légère des 2 réglages système transverses (maintenance_mode,
// announcement_banner), gérés depuis /admin/system et stockés dans la table
// générique economic_settings (catégorie « système »). Utilisé par la coquille
// commune des 4 interfaces internes ET par l'accueil public (visiteurs non
// connectés inclus — economic_settings_select autorise la lecture publique
// depuis la migration 0014).
// ============================================================================

import { supabase } from './supabaseClient.js';

const KEYS = ['maintenance_mode', 'announcement_banner'];
let cache = null;
let cacheAt = 0;
const CACHE_MS = 15000; // évite une requête réseau à chaque écran — la config système change rarement.

export async function getSystemFlags() {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_MS) return cache;
  try {
    const { data, error } = await supabase.from('economic_settings').select('key, value').in('key', KEYS);
    if (error) throw error;
    const byKey = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
    cache = {
      maintenanceEnabled: !!byKey.maintenance_mode?.enabled,
      bannerEnabled: !!byKey.announcement_banner?.enabled,
      bannerMessage: byKey.announcement_banner?.message || '',
    };
    cacheAt = now;
    return cache;
  } catch (_) {
    // Hors-ligne / RLS pas encore appliquée : on n'affiche rien plutôt que de bloquer l'app.
    return { maintenanceEnabled: false, bannerEnabled: false, bannerMessage: '' };
  }
}

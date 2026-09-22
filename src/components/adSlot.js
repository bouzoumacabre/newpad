// ============================================================================
// Encart publicitaire — composant partagé (NewAds, migration 0055)
// ============================================================================
// C'est le seul composant de Newpad qui s'affiche dans une application au
// bénéfice d'une autre. Il est volontairement minuscule et silencieux : s'il
// n'y a pas de campagne, il ne laisse rien — pas de cadre vide, pas d'espace
// réservé. Une régie qui abîme la lecture du journal ne tient pas longtemps.
//
// L'impression est comptée à l'affichage, le clic au clic, et les deux
// atterrissent dans `analytics_events` par `track_event` — la même porte que
// les vues d'un article. Aucune table de compteurs.

import { escapeHtml } from '../lib/format.js';
import { supabase } from '../lib/supabaseClient.js';
import { trackEvent } from '../lib/engagement.js';
import { navigate } from '../lib/router.js';

/**
 * @param {HTMLElement} hote   conteneur (vidé puis rempli, ou laissé vide)
 * @param {string} appSlug     emplacement : le slug de l'application hôte
 */
export async function mountAdSlot(hote, appSlug) {
  if (!hote) return;
  let pub = null;
  try {
    const { data, error } = await supabase.rpc('ads_serve', { p_app_slug: appSlug, p_limit: 1 });
    if (error) throw error;
    pub = (data || [])[0] || null;
  } catch (_) { pub = null; }

  if (!pub) { hote.innerHTML = ''; return; }

  hote.innerHTML = `
    <aside class="ad-slot ${pub.target_route ? 'is-clickable' : ''}" role="complementary">
      ${pub.media_url ? `<img class="ad-visuel" src="${escapeHtml(pub.media_url)}" alt="" loading="lazy" />` : ''}
      <div class="ad-texte">
        <div class="ad-titre">${escapeHtml(pub.title)}</div>
        ${pub.body ? `<div class="ad-corps">${escapeHtml(pub.body)}</div>` : ''}
        <div class="ad-pied">${escapeHtml(pub.org_name)}</div>
      </div>
      <span class="ad-mention">Annonce</span>
    </aside>`;

  trackEvent(appSlug, 'ad_campaign', pub.id, 'impression');

  if (pub.target_route) {
    hote.querySelector('.ad-slot').addEventListener('click', () => {
      trackEvent(appSlug, 'ad_campaign', pub.id, 'click');
      // Route interne uniquement — la base l'a déjà garanti (0055), le
      // navigateur du jeu n'ouvre de toute façon pas d'onglet.
      navigate(pub.target_route);
    });
  }
}

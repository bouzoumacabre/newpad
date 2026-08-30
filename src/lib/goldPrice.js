// ============================================================================
// NEWPAD — Cours de l'or : lecture et affichage partagés
// ============================================================================
// Le cours était calculé et mis en forme dans chaque écran qui l'affichait,
// avec la constante de conversion once/gramme recopiée à chaque fois. Il vit
// désormais ici, en un seul endroit, pour les 4 interfaces et l'accueil public.
//
// Depuis la migration 0026, le cours peut suivre le marché de revente : chaque
// vente entre clients le tire vers le prix observé, dans des limites strictes
// (lissage, plafond de variation par vente, bornes absolues). L'indicateur de
// tendance ci-dessous rend ce mouvement lisible — sans lui, l'utilisateur voit
// un nombre changer sans savoir dans quel sens ni pourquoi.
// ============================================================================

import { supabase } from './supabaseClient.js';
import { formatMoney } from './format.js';

// 1 once troy = 31,1034768 grammes — référence standard du marché de l'or.
export const GRAMS_PER_TROY_OUNCE = 31.1034768;

/**
 * Cours courant + tendance depuis le dernier changement.
 * Lisible sans session (l'accueil public l'affiche).
 * @returns {Promise<{price_per_gram:number, price_per_ounce:number,
 *   change_percent:number, is_auto:boolean, last_source:string|null}|null>}
 */
export async function getGoldPrice() {
  const { data, error } = await supabase.rpc('gold_price_snapshot');
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row || null;
}

/**
 * Bandeau du cours, à insérer en haut d'un écran lié à l'or.
 * @param {object|null} snapshot résultat de getGoldPrice()
 * @param {{compact?: boolean}} options
 * @returns {string} HTML
 */
export function renderGoldTicker(snapshot, { compact = false } = {}) {
  if (!snapshot) {
    return `<p class="muted" style="font-size:13px;">Cours de l'or indisponible pour le moment.</p>`;
  }

  const gram = Number(snapshot.price_per_gram) || 0;
  const ounce = Number(snapshot.price_per_ounce) || gram * GRAMS_PER_TROY_OUNCE;
  const change = Number(snapshot.change_percent) || 0;

  // Une variation nulle ne mérite ni flèche ni couleur : afficher « 0 % » en
  // vert laisserait croire à une hausse.
  const arrow = change > 0 ? '▲' : change < 0 ? '▼' : '→';
  const cls = change > 0 ? 'text-success' : change < 0 ? 'text-danger' : 'muted';
  const trend = change === 0
    ? '<span class="muted" style="font-size:12px;">stable</span>'
    : `<span class="${cls}" style="font-size:12px; font-weight:600;">${arrow} ${Math.abs(change).toFixed(2)} %</span>`;

  const origine = snapshot.is_auto
    ? "indexé sur les ventes du marché de revente"
    : "fixé par la banque";

  if (compact) {
    return `
      <span class="muted" style="font-size:13px;">
        Once d'or : <span class="gold" style="font-weight:600;">${formatMoney(ounce)}</span>
        ${trend}
      </span>
    `;
  }

  return `
    <div class="card card-tight" style="margin-bottom:20px;">
      <div style="display:flex; align-items:baseline; gap:18px; flex-wrap:wrap;">
        <div>
          <div class="muted" style="font-size:11px; text-transform:uppercase; letter-spacing:0.05em;">Cours de l'once</div>
          <div class="font-display gold" style="font-size:24px; margin-top:2px;">${formatMoney(ounce)}</div>
        </div>
        <div>
          <div class="muted" style="font-size:11px; text-transform:uppercase; letter-spacing:0.05em;">Au gramme</div>
          <div class="font-display gold" style="font-size:24px; margin-top:2px;">${formatMoney(gram)}</div>
        </div>
        <div style="margin-left:auto; text-align:right;">
          <div>${trend}</div>
          <div class="muted" style="font-size:11px; margin-top:2px;">${origine}</div>
        </div>
      </div>
    </div>
  `;
}

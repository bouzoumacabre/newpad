import { renderIrsShell } from './shell.js';
import { listIrsGoldBars } from '../../lib/irsApi.js';
import { formatMoney, statusBadge, escapeHtml } from '../../lib/format.js';
import { getGoldPrice, renderGoldTicker } from '../../lib/goldPrice.js';

export async function renderIrsGold(app, profile) {
  const { content } = await renderIrsShell(app, profile, 'gold');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const [bars, goldPrice] = await Promise.all([
    listIrsGoldBars().catch(() => []),
    getGoldPrice().catch(() => null),
  ]);
  const totalWeight = bars.reduce((sum, b) => sum + Number(b.weight_grams || 0), 0);

  content.innerHTML = `
    <h1 style="margin-bottom:14px;">Lingots d'or</h1>
    ${renderGoldTicker(goldPrice)}
    <p class="muted" style="margin-bottom:20px;">Registre complet en lecture seule — ${bars.length} lingot(s), ${formatMoney(totalWeight).replace(' $', '')} g au total.</p>

    <div class="card">
      ${
        bars.length
          ? `<table>
              <thead><tr><th>N° de série</th><th style="text-align:right;">Poids (g)</th><th>Statut</th><th>Propriétaire</th></tr></thead>
              <tbody>
                ${bars
                  .map(
                    (b) => `
                  <tr>
                    <td style="font-family:monospace; font-size:12px;">${escapeHtml(b.serial_number)}</td>
                    <td style="text-align:right;">${b.weight_grams}</td>
                    <td>${statusBadge(b.status)}</td>
                    <td class="muted">${escapeHtml(b.owner_name || 'Coffre de la banque')}</td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>`
          : `<p class="muted">Aucun lingot enregistré.</p>`
      }
    </div>
  `;
}

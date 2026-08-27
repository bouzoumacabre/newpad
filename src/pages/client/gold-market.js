import { renderClientShell } from './shell.js';
import {
  getMarketListings,
  getMyMarketListings,
  getMyGoldBars,
  listGoldForSale,
  cancelMarketListing,
  buyFromMarket,
  getMyMarketPurchaseRequests,
  getEconomicSetting,
} from '../../lib/clientApi.js';
import { formatMoney, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';

export async function renderClientGoldMarket(app, profile) {
  const { content } = await renderClientShell(app, profile, 'gold-market');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const [listings, myListings, myBars, myPurchases, minSetting, maxSetting] = await Promise.all([
      getMarketListings().catch(() => []),
      getMyMarketListings().catch(() => []),
      getMyGoldBars().catch(() => []),
      getMyMarketPurchaseRequests().catch(() => []),
      getEconomicSetting('gold_listing_min_price').catch(() => null),
      getEconomicSetting('gold_listing_max_price').catch(() => null),
    ]);

    const sellableBars = myBars.filter((b) => b.status === 'in_vault');
    const minPrice = minSetting?.amount ?? 0;
    const maxPrice = maxSetting?.amount ?? 999999999;

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Marché de revente de lingots</h1>

      <h3 style="margin-bottom:12px;">Annonces actives</h3>
      <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); margin-bottom:28px;">
        ${
          listings.length
            ? listings
                .map(
                  (l) => `
          <div class="card card-tight">
            <div class="muted" style="font-size:11px;">N° ${escapeHtml(l.gold_bars?.serial_number || '')}</div>
            <div class="font-display" style="font-size:18px; margin:6px 0;">${l.gold_bars?.weight_grams} g</div>
            <div class="gold" style="font-weight:600; margin-bottom:10px;">${formatMoney(l.listed_price)}</div>
            <button class="btn btn-primary buy-listing" data-id="${l.id}" style="width:100%; font-size:13px;">Acheter</button>
          </div>
        `
                )
                .join('')
            : `<div class="card"><p class="muted">Aucune annonce active actuellement.</p></div>`
        }
      </div>

      <div class="grid" style="grid-template-columns: 1fr 1fr; align-items:start; margin-bottom:28px;">
        <div class="card">
          <h3 style="margin-bottom:12px;">Mettre un de mes lingots en vente</h3>
          ${
            sellableBars.length
              ? `
            <div class="field">
              <label>Lingot</label>
              <select id="sell-bar">
                ${sellableBars.map((b) => `<option value="${b.id}">N° ${escapeHtml(b.serial_number)} — ${b.weight_grams} g</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>Prix de vente ($)</label>
              <input type="number" id="sell-price" min="${minPrice}" max="${maxPrice}" step="0.01" placeholder="0.00" />
              <div class="muted" style="font-size:12px; margin-top:4px;">Entre ${formatMoney(minPrice)} et ${formatMoney(maxPrice)}.</div>
            </div>
            <div id="sell-error" class="text-danger" style="font-size:13px; margin-bottom:12px; display:none;"></div>
            <button id="sell-submit" class="btn btn-primary" style="width:100%;">Mettre en vente</button>
          `
              : `<p class="muted">Vous n'avez aucun lingot disponible pour la revente.</p>`
          }
        </div>
        <div class="card">
          <h3 style="margin-bottom:12px;">Mes annonces (${myListings.length})</h3>
          ${
            myListings.length
              ? `<table><tbody>${myListings
                  .map(
                    (l) => `
                <tr>
                  <td>N° ${escapeHtml(l.gold_bars?.serial_number || '')} — ${formatMoney(l.listed_price)}</td>
                  <td style="text-align:right;">
                    ${statusBadge(l.status)}
                    ${l.status === 'active' ? `<button class="btn btn-secondary cancel-listing" data-id="${l.id}" style="margin-left:8px; font-size:12px; padding:4px 10px;">Retirer</button>` : ''}
                  </td>
                </tr>
              `
                  )
                  .join('')}</tbody></table>`
              : `<p class="muted">Aucune annonce publiée.</p>`
          }
        </div>
      </div>

      <div class="card">
        <h3 style="margin-bottom:12px;">Mes achats sur le marché</h3>
        ${
          myPurchases.length
            ? `<table><tbody>${myPurchases
                .map(
                  (p) => `
              <tr>
                <td>
                  <div>${formatMoney(p.gold_market_listings?.listed_price)}</div>
                  <div class="muted" style="font-size:12px;">${formatDateTime(p.requested_at)}</div>
                </td>
                <td style="text-align:right;">${statusBadge(p.status)}</td>
              </tr>
            `
                )
                .join('')}</tbody></table>`
            : `<p class="muted">Aucun achat en cours.</p>`
        }
      </div>
    `;

    content.querySelectorAll('.buy-listing').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!await showConfirm('Confirmer l\'achat de ce lingot ?')) return;
        btn.disabled = true;
        try {
          await buyFromMarket(btn.getAttribute('data-id'));
          await showAlert('Demande d\'achat soumise — en attente de traitement.');
          await draw();
        } catch (err) {
          await showAlert(err.message || 'Erreur lors de la demande.');
          btn.disabled = false;
        }
      });
    });

    content.querySelectorAll('.cancel-listing').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!await showConfirm('Retirer cette annonce de la vente ?')) return;
        btn.disabled = true;
        try {
          await cancelMarketListing(btn.getAttribute('data-id'));
          await draw();
        } catch (err) {
          await showAlert(err.message || 'Erreur lors du retrait de l\'annonce.');
          btn.disabled = false;
        }
      });
    });

    document.getElementById('sell-submit')?.addEventListener('click', async () => {
      const errorEl = document.getElementById('sell-error');
      errorEl.style.display = 'none';
      const barId = document.getElementById('sell-bar').value;
      const price = parseFloat(document.getElementById('sell-price').value);
      if (!price || price <= 0) {
        errorEl.textContent = 'Prix invalide.';
        errorEl.style.display = 'block';
        return;
      }
      try {
        await listGoldForSale(barId, price);
        await draw();
      } catch (err) {
        errorEl.textContent = err.message || 'Erreur lors de la mise en vente.';
        errorEl.style.display = 'block';
      }
    });
  }

  await draw();
}

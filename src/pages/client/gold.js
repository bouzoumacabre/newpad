import { renderClientShell } from './shell.js';
import { getBankGoldStock, getMyGoldBars, buyGoldFromBank, getMyGoldPurchaseRequests, getEconomicSetting } from '../../lib/clientApi.js';
import { formatMoney, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';

export async function renderClientGold(app, profile) {
  const { content } = await renderClientShell(app, profile, 'gold');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const [stock, myBars, myRequests, priceSetting] = await Promise.all([
      getBankGoldStock().catch(() => []),
      getMyGoldBars().catch(() => []),
      getMyGoldPurchaseRequests().catch(() => []),
      getEconomicSetting('gold_price_per_gram').catch(() => null),
    ]);
    const pricePerGram = priceSetting?.amount ?? 60;

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Lingots d'or</h1>
      <p class="muted" style="margin-bottom:20px;">Cours actuel : <span class="gold" style="font-weight:600;">${formatMoney(pricePerGram)}/gramme</span></p>

      <h3 style="margin-bottom:12px;">Stock disponible à la banque</h3>
      <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); margin-bottom:28px;">
        ${
          stock.length
            ? stock
                .map(
                  (g) => `
          <div class="card card-tight">
            <div class="muted" style="font-size:11px;">N° ${escapeHtml(g.serial_number)}</div>
            <div class="font-display" style="font-size:20px; margin:6px 0;">${g.weight_grams} g</div>
            <div class="gold" style="font-weight:600; margin-bottom:10px;">${formatMoney(g.weight_grams * pricePerGram)}</div>
            <button class="btn btn-primary buy-bar" data-id="${g.id}" style="width:100%; font-size:13px;">Acheter</button>
          </div>
        `
                )
                .join('')
            : `<div class="card"><p class="muted">Aucun lingot disponible actuellement.</p></div>`
        }
      </div>

      <div class="grid" style="grid-template-columns: 1fr 1fr; align-items:start;">
        <div class="card">
          <h3 style="margin-bottom:12px;">Mes lingots (${myBars.length})</h3>
          ${
            myBars.length
              ? `<table><tbody>${myBars
                  .map(
                    (g) => `
                <tr>
                  <td>N° ${escapeHtml(g.serial_number)} — ${g.weight_grams} g</td>
                  <td style="text-align:right;">${statusBadge(g.status)}</td>
                </tr>
              `
                  )
                  .join('')}</tbody></table>`
              : `<p class="muted">Vous ne possédez aucun lingot pour l'instant.</p>`
          }
        </div>
        <div class="card">
          <h3 style="margin-bottom:12px;">Mes demandes d'achat</h3>
          ${
            myRequests.length
              ? `<table><tbody>${myRequests
                  .map(
                    (r) => `
                <tr>
                  <td>
                    <div>${formatMoney(r.price)}</div>
                    <div class="muted" style="font-size:12px;">${formatDateTime(r.created_at)}</div>
                  </td>
                  <td style="text-align:right;">${statusBadge(r.status)}</td>
                </tr>
              `
                  )
                  .join('')}</tbody></table>`
              : `<p class="muted">Aucune demande en cours.</p>`
          }
        </div>
      </div>
    `;

    content.querySelectorAll('.buy-bar').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Confirmer l\'achat de ce lingot ?')) return;
        btn.disabled = true;
        btn.textContent = 'Envoi…';
        try {
          await buyGoldFromBank(btn.getAttribute('data-id'));
          alert('Demande d\'achat soumise — en attente de traitement.');
          await draw();
        } catch (err) {
          alert(err.message || 'Erreur lors de la demande.');
          btn.disabled = false;
          btn.textContent = 'Acheter';
        }
      });
    });
  }

  await draw();
}

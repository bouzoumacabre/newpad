import { renderEmployeeShell } from './shell.js';
import { getGoldBankQueue, decideGoldBankPurchase, getGoldMarketQueue, decideMarketPurchase } from '../../lib/employeeApi.js';
import { formatMoney, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';

export async function renderEmployeeGold(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'gold');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const [bankQueue, marketQueue] = await Promise.all([
      getGoldBankQueue().catch(() => []),
      getGoldMarketQueue().catch(() => []),
    ]);
    const bankPending = bankQueue.filter((r) => r.status === 'pending' || r.status === 'processing');
    const marketPending = marketQueue.filter((r) => r.status === 'pending' || r.status === 'processing');

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Lingots & marché de revente</h1>

      <h3 style="margin-bottom:12px;">Achats banque</h3>
      <div class="card" style="margin-bottom:24px;">
        ${
          bankPending.length
            ? bankPending
                .map(
                  (r) => `
          <div style="padding:14px 0; border-bottom:1px solid var(--card-border);">
            <div class="flex justify-between items-center" style="margin-bottom:8px;">
              <div>
                <div style="font-weight:600;">${escapeHtml(r.profiles?.display_name || '')} — N° ${escapeHtml(r.gold_bars?.serial_number || '')}</div>
                <div class="muted" style="font-size:12px;">${r.gold_bars?.weight_grams} g — ${formatDateTime(r.requested_at)}</div>
              </div>
              ${statusBadge(r.status)}
            </div>
            <div style="font-size:14px; margin-bottom:10px;">
              Prix : <strong class="gold">${formatMoney(r.price)}</strong>
            </div>
            <div class="flex gap-sm">
              <button class="btn btn-primary bank-approve" data-id="${r.id}">Valider</button>
              <button class="btn btn-danger bank-reject" data-id="${r.id}">Refuser</button>
            </div>
          </div>
        `
                )
                .join('')
            : `<p class="muted">Aucune demande en attente.</p>`
        }
      </div>

      <h3 style="margin-bottom:12px;">Achats sur le marché de revente</h3>
      <div class="card">
        ${
          marketPending.length
            ? marketPending
                .map(
                  (r) => `
          <div style="padding:14px 0; border-bottom:1px solid var(--card-border);">
            <div class="flex justify-between items-center" style="margin-bottom:8px;">
              <div>
                <div style="font-weight:600;">${escapeHtml(r.profiles?.display_name || '')} — N° ${escapeHtml(r.gold_market_listings?.gold_bars?.serial_number || '')}</div>
                <div class="muted" style="font-size:12px;">${formatDateTime(r.requested_at)}</div>
              </div>
              ${statusBadge(r.status)}
            </div>
            <div style="font-size:14px; margin-bottom:10px;">
              Prix : <strong class="gold">${formatMoney(r.gold_market_listings?.listed_price)}</strong>
            </div>
            <div class="flex gap-sm">
              <button class="btn btn-primary market-approve" data-id="${r.id}">Valider</button>
              <button class="btn btn-danger market-reject" data-id="${r.id}">Refuser</button>
            </div>
          </div>
        `
                )
                .join('')
            : `<p class="muted">Aucune demande en attente.</p>`
        }
      </div>
    `;

    content.querySelectorAll('.bank-approve').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await decideGoldBankPurchase(btn.getAttribute('data-id'), true, null); await draw(); }
        catch (err) { alert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.bank-reject').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = prompt('Motif du refus (optionnel) :') || null;
        try { await decideGoldBankPurchase(btn.getAttribute('data-id'), false, note); await draw(); }
        catch (err) { alert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.market-approve').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await decideMarketPurchase(btn.getAttribute('data-id'), true, null); await draw(); }
        catch (err) { alert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.market-reject').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = prompt('Motif du refus (optionnel) :') || null;
        try { await decideMarketPurchase(btn.getAttribute('data-id'), false, note); await draw(); }
        catch (err) { alert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

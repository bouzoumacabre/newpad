import { renderEmployeeShell } from './shell.js';
import { getGoldBankQueue, decideGoldBankPurchase, getGoldMarketQueue, decideMarketPurchase, getAllMarketListings, cancelMarketListing } from '../../lib/employeeApi.js';
import { formatMoney, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';

export async function renderEmployeeGold(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'gold');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const [bankQueue, marketQueue, marketListings] = await Promise.all([
      getGoldBankQueue().catch(() => []),
      getGoldMarketQueue().catch(() => []),
      getAllMarketListings().catch(() => []),
    ]);
    const bankPending = bankQueue.filter((r) => r.status === 'pending' || r.status === 'processing').map((r) => ({ ...r, _kind: 'bank' }));
    const marketPending = marketQueue.filter((r) => r.status === 'pending' || r.status === 'processing').map((r) => ({ ...r, _kind: 'market' }));
    const allPending = [...bankPending, ...marketPending].sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at));

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Lingots & marché de revente</h1>

      <h3 style="margin-bottom:12px;">Demandes d'achat en attente (${allPending.length})</h3>
      <div class="card" style="margin-bottom:24px;">
        ${
          allPending.length
            ? allPending
                .map((r) => {
                  const isBank = r._kind === 'bank';
                  const serial = isBank ? r.gold_bars?.serial_number : r.gold_market_listings?.gold_bars?.serial_number;
                  const weight = isBank ? r.gold_bars?.weight_grams : r.gold_market_listings?.gold_bars?.weight_grams;
                  const price = isBank ? r.price : r.gold_market_listings?.listed_price;
                  return `
          <div style="padding:14px 0; border-bottom:1px solid var(--card-border);">
            <div class="flex justify-between items-center" style="margin-bottom:8px;">
              <div>
                <span class="badge ${isBank ? 'badge-neutral' : 'badge-pending'}" style="margin-right:8px; font-size:11px;">${isBank ? 'Achat banque' : 'Achat marché'}</span>
                <div style="font-weight:600; display:inline;">${escapeHtml(r.profiles?.display_name || '')} — N° ${escapeHtml(serial || '')}</div>
                <div class="muted" style="font-size:12px;">${weight ? weight + ' g — ' : ''}${formatDateTime(r.requested_at)}</div>
              </div>
              ${statusBadge(r.status)}
            </div>
            <div style="font-size:14px; margin-bottom:10px;">
              Prix : <strong class="gold">${formatMoney(price)}</strong>
            </div>
            <div class="flex gap-sm">
              <button class="btn btn-primary ${isBank ? 'bank-approve' : 'market-approve'}" data-id="${r.id}">Valider</button>
              <button class="btn btn-danger ${isBank ? 'bank-reject' : 'market-reject'}" data-id="${r.id}">Refuser</button>
            </div>
          </div>
        `;
                })
                .join('')
            : `<p class="muted">Aucune demande en attente.</p>`
        }
      </div>

      <h3 style="margin-bottom:12px;">Lingots actuellement en vente sur le marché (${marketListings.length})</h3>
      <div class="card">
        ${
          marketListings.length
            ? marketListings
                .map(
                  (l) => `
          <div style="padding:14px 0; border-bottom:1px solid var(--card-border);" class="flex justify-between items-center">
            <div>
              <div style="font-weight:600;">N° ${escapeHtml(l.gold_bars?.serial_number || '')} — ${l.gold_bars?.weight_grams} g</div>
              <div class="muted" style="font-size:12px;">
                Vendeur : ${escapeHtml(l.profiles?.display_name || 'Banque')} — mis en vente le ${formatDateTime(l.created_at)}
              </div>
            </div>
            <div class="flex items-center gap-md">
              <strong class="gold">${formatMoney(l.listed_price)}</strong>
              <button class="btn btn-danger listing-cancel" data-id="${l.id}" style="padding:4px 10px; font-size:12px;">Retirer</button>
            </div>
          </div>
        `
                )
                .join('')
            : `<p class="muted">Aucun lingot en vente actuellement.</p>`
        }
      </div>
    `;

    content.querySelectorAll('.listing-cancel').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!await showConfirm('Retirer ce lingot de la vente ?')) return;
        try { await cancelMarketListing(btn.getAttribute('data-id')); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });

    content.querySelectorAll('.bank-approve').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await decideGoldBankPurchase(btn.getAttribute('data-id'), true, null); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.bank-reject').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = await showPrompt('Motif du refus (optionnel) :') || null;
        try { await decideGoldBankPurchase(btn.getAttribute('data-id'), false, note); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.market-approve').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await decideMarketPurchase(btn.getAttribute('data-id'), true, null); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.market-reject').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = await showPrompt('Motif du refus (optionnel) :') || null;
        try { await decideMarketPurchase(btn.getAttribute('data-id'), false, note); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

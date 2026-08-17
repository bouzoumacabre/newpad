import { renderAdminShell } from './shell.js';
import {
  getGoldBankQueue,
  decideGoldBankPurchase,
  getGoldMarketQueue,
  decideMarketPurchase,
  getAllGoldBars,
  mintGoldBar,
  adminUpdateGoldBar,
} from '../../lib/adminApi.js';
import { formatMoney, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';

const GOLD_BAR_STATUSES = ['in_vault', 'listed', 'reserved', 'sold'];

export async function renderAdminGold(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'gold');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const [bankQueue, marketQueue, allBars] = await Promise.all([
      getGoldBankQueue().catch(() => []),
      getGoldMarketQueue().catch(() => []),
      getAllGoldBars().catch(() => []),
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
      <div class="card" style="margin-bottom:24px;">
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

      <h3 style="margin-bottom:12px;">Frapper un nouveau lingot</h3>
      <div class="card" style="margin-bottom:24px;">
        <div class="grid" style="grid-template-columns: 1fr 1fr 2fr auto; gap:10px; align-items:end;">
          <div class="field" style="margin:0;">
            <label>N° de série</label>
            <input type="text" id="mint-serial" placeholder="Ex: NB-000123" />
          </div>
          <div class="field" style="margin:0;">
            <label>Poids (g)</label>
            <input type="number" id="mint-weight" min="0" step="0.01" />
          </div>
          <div class="field" style="margin:0;">
            <label>Notes</label>
            <input type="text" id="mint-notes" placeholder="Optionnel" />
          </div>
          <button id="mint-submit" class="btn btn-primary">Frapper</button>
        </div>
        <div id="mint-error" class="text-danger" style="font-size:13px; margin-top:8px; display:none;"></div>
      </div>

      <h3 style="margin-bottom:12px;">Registre complet des lingots (${allBars.length})</h3>
      <div class="card">
        ${
          allBars.length
            ? `<table>
                <thead><tr><th>N° de série</th><th>Poids</th><th>Statut</th><th>Emplacement</th><th>Propriétaire (UUID)</th><th>Notes</th><th></th></tr></thead>
                <tbody>
                  ${allBars
                    .map(
                      (b) => `
                    <tr>
                      <td>${escapeHtml(b.serial_number)}</td>
                      <td>${b.weight_grams} g</td>
                      <td>
                        <select class="bar-status" data-id="${b.id}" style="width:auto; padding:4px 8px; font-size:12px;">
                          ${GOLD_BAR_STATUSES.map((s) => `<option value="${s}" ${s === b.status ? 'selected' : ''}>${s}</option>`).join('')}
                        </select>
                      </td>
                      <td><input type="text" class="bar-location" data-id="${b.id}" value="${escapeHtml(b.location || '')}" style="width:160px; padding:4px 8px; font-size:12px;" /></td>
                      <td>
                        <input type="text" class="bar-owner" data-id="${b.id}" value="${escapeHtml(b.owner_client_id || '')}" placeholder="Banque si vide" title="${escapeHtml(b.profiles?.display_name || 'Banque')}" style="width:130px; padding:4px 8px; font-size:12px;" />
                      </td>
                      <td><input type="text" class="bar-notes" data-id="${b.id}" value="${escapeHtml(b.notes || '')}" style="width:140px; padding:4px 8px; font-size:12px;" /></td>
                      <td><button class="btn btn-secondary bar-save" data-id="${b.id}" style="padding:4px 10px; font-size:12px;">Enregistrer</button></td>
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

    document.getElementById('mint-submit').addEventListener('click', async () => {
      const errorEl = document.getElementById('mint-error');
      errorEl.style.display = 'none';
      const serial = document.getElementById('mint-serial').value.trim();
      const weight = parseFloat(document.getElementById('mint-weight').value);
      const notes = document.getElementById('mint-notes').value.trim();
      if (!serial || !weight || weight <= 0) {
        errorEl.textContent = 'Veuillez renseigner un numéro de série et un poids valide.';
        errorEl.style.display = 'block';
        return;
      }
      try {
        await mintGoldBar({ serial, weightGrams: weight, notes: notes || null });
        await draw();
      } catch (err) {
        errorEl.textContent = err.message || 'Erreur lors de la frappe.';
        errorEl.style.display = 'block';
      }
    });

    content.querySelectorAll('.bar-save').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const status = content.querySelector(`.bar-status[data-id="${id}"]`).value;
        const location = content.querySelector(`.bar-location[data-id="${id}"]`).value.trim();
        const owner = content.querySelector(`.bar-owner[data-id="${id}"]`).value.trim();
        const notes = content.querySelector(`.bar-notes[data-id="${id}"]`).value.trim();
        try {
          await adminUpdateGoldBar(id, { status, location: location || null, ownerClientId: owner || null, notes: notes || null });
          await draw();
        } catch (err) { alert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

import { renderAdminShell } from './shell.js';
import {
  getGoldBankQueue,
  decideGoldBankPurchase,
  getGoldMarketQueue,
  decideMarketPurchase,
  getAllGoldBars,
  mintGoldBar,
  adminUpdateGoldBar,
  getAllMarketListings,
  adminCreateMarketListing,
  adminCancelMarketListing,
} from '../../lib/adminApi.js';
import { formatMoney, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';
import { getFeatureFlags } from '../../lib/features.js';

const GOLD_BAR_STATUSES = ['in_vault', 'listed', 'reserved', 'sold'];

export async function renderAdminGold(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'gold');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  // Les clés `admin.gold.mint` et `admin.gold.edit_registry` existaient au
  // registre depuis l'origine mais n'étaient lues nulle part : les désactiver
  // depuis /admin/permissions n'avait strictement aucun effet, ce qui est pire
  // qu'une absence de bascule (l'admin croyait avoir restreint quelque chose).
  let flags = {};
  try {
    flags = await getFeatureFlags('admin', 'admin');
  } catch (_) { /* en cas d'échec réseau, on n'ampute rien : tout reste affiché */ }
  const has = (key) => (key in flags ? flags[key] : true);
  const canMint = has('admin.gold.mint');
  const canEditRegistry = has('admin.gold.edit_registry');

  async function draw() {
    const [bankQueue, marketQueue, allBars, marketListings] = await Promise.all([
      getGoldBankQueue().catch(() => []),
      getGoldMarketQueue().catch(() => []),
      getAllGoldBars().catch(() => []),
      getAllMarketListings().catch(() => []),
    ]);
    const bankPending = bankQueue.filter((r) => r.status === 'pending' || r.status === 'processing').map((r) => ({ ...r, _kind: 'bank' }));
    const marketPending = marketQueue.filter((r) => r.status === 'pending' || r.status === 'processing').map((r) => ({ ...r, _kind: 'market' }));
    // Vue 360 : une seule liste combinée, triée par date, pour éviter d'avoir
    // à parcourir deux panneaux quasi identiques (achats banque / achats
    // marché) — chaque ligne indique sa nature via une étiquette.
    const allPending = [...bankPending, ...marketPending].sort((a, b) => new Date(b.requested_at) - new Date(a.requested_at));
    const inCirculation = allBars.filter((b) => b.status === 'sold');
    const inCirculationWeight = inCirculation.reduce((s, b) => s + Number(b.weight_grams), 0);
    const availableForListing = allBars.filter((b) => b.status === 'in_vault');

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Lingots & marché de revente</h1>
      <p class="muted" style="margin-bottom:20px;">
        Lingots en circulation (possédés par des clients) :
        <span class="gold" style="font-weight:600;">${inCirculation.length}</span>
        — poids total : ${inCirculationWeight} g
      </p>

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

      <h3 style="margin-bottom:12px;">Mettre un lingot en vente sur le marché</h3>
      <div class="card" style="margin-bottom:24px;">
        <p class="muted" style="font-size:13px; margin-bottom:12px;">
          Liste directement un lingot disponible (« in_vault ») sur le marché de revente, comme un client le ferait
          pour son propre lingot. Si le lingot appartient à la banque (propriétaire vide), le prix intégral de la
          vente revient à la trésorerie, sans commission.
        </p>
        <div class="grid" style="grid-template-columns: 2fr 1fr auto; gap:10px; align-items:end;">
          <div class="field" style="margin:0;">
            <label>Lingot à mettre en vente</label>
            <select id="listing-bar">
              ${
                availableForListing.length
                  ? availableForListing
                      .map(
                        (b) =>
                          `<option value="${b.id}">N° ${escapeHtml(b.serial_number)} — ${b.weight_grams} g — ${escapeHtml(b.profiles?.display_name || 'Banque')}</option>`
                      )
                      .join('')
                  : '<option value="">Aucun lingot disponible</option>'
              }
            </select>
          </div>
          <div class="field" style="margin:0;">
            <label>Prix ($)</label>
            <input type="number" id="listing-price" min="0" step="0.01" />
          </div>
          <button id="listing-submit" class="btn btn-primary" ${availableForListing.length ? '' : 'disabled'}>Mettre en vente</button>
        </div>
        <div id="listing-error" class="text-danger" style="font-size:13px; margin-top:8px; display:none;"></div>
      </div>

      <h3 style="margin-bottom:12px;">Lingots actuellement en vente (${marketListings.length})</h3>
      <div class="card" style="margin-bottom:24px;">
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

      ${
        canMint
          ? `<h3 style="margin-bottom:12px;">Frapper un nouveau lingot</h3>
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
      </div>`
          : ''
      }

      <h3 style="margin-bottom:12px;">Registre complet des lingots (${allBars.length})</h3>
      <div class="card">
        ${
          allBars.length
            ? `<table>
                <thead><tr><th>N° de série</th><th>Poids</th><th>Statut</th><th>Emplacement</th><th>${canEditRegistry ? 'Propriétaire (UUID)' : 'Propriétaire'}</th><th>Notes</th><th></th></tr></thead>
                <tbody>
                  ${allBars
                    .map(
                      (b) => `
                    <tr>
                      <td>${escapeHtml(b.serial_number)}</td>
                      <td>${b.weight_grams} g</td>
                      <td>
                        ${
                          canEditRegistry
                            ? `<select class="bar-status" data-id="${b.id}" style="width:auto; padding:4px 8px; font-size:12px;">
                          ${GOLD_BAR_STATUSES.map((s) => `<option value="${s}" ${s === b.status ? 'selected' : ''}>${s}</option>`).join('')}
                        </select>`
                            : statusBadge(b.status)
                        }
                      </td>
                      <td>${
                        canEditRegistry
                          ? `<input type="text" class="bar-location" data-id="${b.id}" value="${escapeHtml(b.location || '')}" style="width:160px; padding:4px 8px; font-size:12px;" />`
                          : `<span class="muted">${escapeHtml(b.location || '—')}</span>`
                      }</td>
                      <td>
                        ${
                          canEditRegistry
                            ? `<input type="text" class="bar-owner" data-id="${b.id}" value="${escapeHtml(b.owner_client_id || '')}" placeholder="Banque si vide" title="${escapeHtml(b.profiles?.display_name || 'Banque')}" style="width:130px; padding:4px 8px; font-size:12px;" />`
                            : `<span class="muted">${escapeHtml(b.profiles?.display_name || 'Banque')}</span>`
                        }
                      </td>
                      <td>${
                        canEditRegistry
                          ? `<input type="text" class="bar-notes" data-id="${b.id}" value="${escapeHtml(b.notes || '')}" style="width:140px; padding:4px 8px; font-size:12px;" />`
                          : `<span class="muted">${escapeHtml(b.notes || '—')}</span>`
                      }</td>
                      <td>${canEditRegistry ? `<button class="btn btn-secondary bar-save" data-id="${b.id}" style="padding:4px 10px; font-size:12px;">Enregistrer</button>` : ''}</td>
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

    const listingSubmitBtn = document.getElementById('listing-submit');
    if (listingSubmitBtn) {
      listingSubmitBtn.addEventListener('click', async () => {
        const errorEl = document.getElementById('listing-error');
        errorEl.style.display = 'none';
        const barId = document.getElementById('listing-bar').value;
        const price = parseFloat(document.getElementById('listing-price').value);
        if (!barId || !price || price <= 0) {
          errorEl.textContent = 'Veuillez choisir un lingot et un prix valide.';
          errorEl.style.display = 'block';
          return;
        }
        try {
          await adminCreateMarketListing(barId, price);
          await draw();
        } catch (err) {
          errorEl.textContent = err.message || 'Erreur lors de la mise en vente.';
          errorEl.style.display = 'block';
        }
      });
    }

    content.querySelectorAll('.listing-cancel').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!await showConfirm('Retirer ce lingot de la vente ?')) return;
        try { await adminCancelMarketListing(btn.getAttribute('data-id')); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });

    // `?.` indispensable : le bloc de frappe n'est plus rendu du tout quand la
    // fonctionnalité `admin.gold.mint` est désactivée — sans lui, l'écran
    // entier planterait sur un TypeError.
    document.getElementById('mint-submit')?.addEventListener('click', async () => {
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
        } catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

// ============================================================================
// NEWPAD — Historique des transactions, partagé Employé/Admin.
// Recherche texte + filtre par type de service + filtre par catégorie de
// clientèle (VIP, Entreprise, etc.) — aucun des deux rôles n'avait cet écran
// jusqu'ici (seul le rôle IRS disposait d'un registre équivalent).
// ============================================================================

import { listStaffTransactions, listDistinctTxTypes, getClientCategories } from '../../lib/employeeApi.js';
import { adminUpdateTransactionDescription } from '../../lib/adminApi.js';
import { formatMoney, formatDateTime, statusBadge, escapeHtml, txTypeLabel } from '../../lib/format.js';
import { showPrompt, showAlert } from '../../lib/uiDialogs.js';

export async function renderTransactionsScreen(content, { canEdit = false } = {}) {
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  let search = '';
  let txType = '';
  let categoryId = '';

  async function draw() {
    const [txs, txTypes, categories] = await Promise.all([
      listStaffTransactions({ search, txType: txType || null, categoryId: categoryId || null }).catch(() => []),
      listDistinctTxTypes().catch(() => []),
      getClientCategories().catch(() => []),
    ]);

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Historique des transactions</h1>
      <p class="muted" style="margin-bottom:20px;">
        Vue 360 de tous les mouvements d'argent de la banque — virements, frais, prêts, lingots, coffres...
        ${canEdit ? " Le montant, les comptes et le statut d'une transaction validée ne sont jamais modifiables (intégrité comptable) — seule sa description peut être corrigée." : ''}
      </p>

      <div class="card" style="margin-bottom:20px;">
        <div class="grid" style="grid-template-columns: 2fr 1fr 1fr; gap:10px;">
          <input type="text" id="tx-search" placeholder="Rechercher par description ou nom..." value="${escapeHtml(search)}" />
          <select id="tx-type-filter">
            <option value="">Tous les types de service</option>
            ${txTypes.map((t) => `<option value="${escapeHtml(t)}" ${t === txType ? 'selected' : ''}>${escapeHtml(txTypeLabel(t))}</option>`).join('')}
          </select>
          <select id="tx-category-filter">
            <option value="">Toutes les catégories de clientèle</option>
            ${categories.map((c) => `<option value="${c.id}" ${c.id === categoryId ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="card">
        ${
          txs.length
            ? `<table>
                <thead><tr><th>Date</th><th>Type</th><th>De</th><th>Vers</th><th style="text-align:right;">Montant</th><th style="text-align:right;">Frais</th><th>Statut</th><th>Description</th>${canEdit ? '<th></th>' : ''}</tr></thead>
                <tbody>
                  ${txs
                    .map(
                      (t) => `
                    <tr>
                      <td class="muted" style="white-space:nowrap;">${formatDateTime(t.created_at)}</td>
                      <td class="muted">${escapeHtml(txTypeLabel(t.tx_type))}</td>
                      <td>${escapeHtml(t.from_label)}</td>
                      <td>${escapeHtml(t.to_label)}</td>
                      <td style="text-align:right; font-weight:600;">${formatMoney(t.amount)}</td>
                      <td style="text-align:right;" class="muted">${formatMoney(t.fee_amount)}</td>
                      <td>${statusBadge(t.status)}</td>
                      <td class="muted">${escapeHtml(t.description || '—')}</td>
                      ${canEdit ? `<td><button class="btn btn-ghost tx-edit-desc" data-id="${t.id}" data-desc="${escapeHtml(t.description || '')}" style="padding:4px 8px; font-size:12px;">Modifier</button></td>` : ''}
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>`
            : `<p class="muted">Aucune transaction trouvée.</p>`
        }
      </div>
    `;

    let debounce;
    document.getElementById('tx-search').addEventListener('input', (e) => {
      clearTimeout(debounce);
      const value = e.target.value;
      debounce = setTimeout(() => { search = value; draw(); }, 300);
    });
    document.getElementById('tx-type-filter').addEventListener('change', (e) => { txType = e.target.value; draw(); });
    document.getElementById('tx-category-filter').addEventListener('change', (e) => { categoryId = e.target.value; draw(); });

    content.querySelectorAll('.tx-edit-desc').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const current = btn.getAttribute('data-desc');
        const next = await showPrompt('Nouvelle description de la transaction :', current);
        if (next === null) return;
        try {
          await adminUpdateTransactionDescription(id, next.trim());
          await draw();
        } catch (err) {
          await showAlert(err.message || 'Erreur.');
        }
      });
    });
  }

  await draw();
}

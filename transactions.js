import { renderIrsShell } from './shell.js';
import { listIrsTransactions } from '../../lib/irsApi.js';
import { formatMoney, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';

export async function renderIrsTransactions(app, profile) {
  const { content } = await renderIrsShell(app, profile, 'transactions');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  let query = '';

  async function draw() {
    const txs = await listIrsTransactions(query).catch(() => []);

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Transactions</h1>
      <p class="muted" style="margin-bottom:20px;">Registre en lecture seule — les transactions masquées par l'administration pour l'interface IRS n'apparaissent pas.</p>

      <div class="card" style="margin-bottom:20px;">
        <input type="text" id="search-input" placeholder="Rechercher par description ou nom..." value="${escapeHtml(query)}" style="max-width:360px;" />
      </div>

      <div class="card">
        ${
          txs.length
            ? `<table>
                <thead><tr><th>Date</th><th>Type</th><th>De</th><th>Vers</th><th style="text-align:right;">Montant</th><th style="text-align:right;">Frais</th><th>Statut</th><th>Description</th></tr></thead>
                <tbody>
                  ${txs
                    .map(
                      (t) => `
                    <tr>
                      <td class="muted" style="white-space:nowrap;">${formatDateTime(t.created_at)}</td>
                      <td class="muted">${escapeHtml(t.tx_type)}</td>
                      <td>${escapeHtml(t.from_label)}</td>
                      <td>${escapeHtml(t.to_label)}</td>
                      <td style="text-align:right; font-weight:600;">${formatMoney(t.amount)}</td>
                      <td style="text-align:right;" class="muted">${formatMoney(t.fee_amount)}</td>
                      <td>${statusBadge(t.status)}</td>
                      <td class="muted">${escapeHtml(t.description || '—')}</td>
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

    const searchInput = document.getElementById('search-input');
    let debounce;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { query = searchInput.value; draw(); }, 300);
    });
  }

  await draw();
}

import { renderClientShell } from './shell.js';
import { getMyAccounts, getAccountTransactions } from '../../lib/clientApi.js';
import { formatMoney, formatDateTime, escapeHtml } from '../../lib/format.js';

const ACCOUNT_TYPE_LABELS = { courant: 'Compte courant', epargne: 'Compte épargne', entreprise: 'Compte entreprise' };

export async function renderClientAccounts(app, profile, params = {}) {
  const { content } = await renderClientShell(app, profile, 'accounts');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const accounts = await getMyAccounts().catch(() => []);
  if (!accounts.length) {
    content.innerHTML = `<h1>Mes comptes</h1><div class="card"><p class="muted">Aucun compte trouvé.</p></div>`;
    return;
  }

  let activeId = params.id || accounts[0].id;

  async function renderAll() {
    const transactions = await getAccountTransactions(activeId, 30).catch(() => []);
    const active = accounts.find((a) => a.id === activeId) || accounts[0];

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Mes comptes</h1>
      <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); margin-bottom:24px;">
        ${accounts
          .map(
            (a) => `
          <div class="card card-tight account-card" data-id="${a.id}" style="cursor:pointer; ${a.id === activeId ? 'border-color: var(--gold); box-shadow: var(--shadow-gold-glow);' : ''}">
            <div class="muted" style="font-size:11px; text-transform:uppercase; letter-spacing:0.04em;">${ACCOUNT_TYPE_LABELS[a.account_type] || a.account_type}</div>
            <div class="font-display gold" style="font-size:22px; margin:6px 0;">${formatMoney(a.balance)}</div>
            <div class="muted" style="font-size:12px;">${escapeHtml(a.iban)}</div>
          </div>
        `
          )
          .join('')}
      </div>

      <div class="card">
        <div class="flex justify-between items-center" style="margin-bottom:12px;">
          <h3 style="margin:0;">Historique — ${ACCOUNT_TYPE_LABELS[active.account_type] || active.account_type}</h3>
          <span class="muted" style="font-size:13px;">${escapeHtml(active.iban)}</span>
        </div>
        ${
          transactions.length
            ? `<table>
                <thead><tr><th>Date</th><th>Description</th><th style="text-align:right;">Montant</th></tr></thead>
                <tbody>
                  ${transactions
                    .map((t) => {
                      const isCredit = t.to_account_id === activeId;
                      return `
                    <tr>
                      <td class="muted">${formatDateTime(t.created_at)}</td>
                      <td>${escapeHtml(t.description || t.tx_type)}</td>
                      <td style="text-align:right; font-weight:600;" class="${isCredit ? 'text-success' : 'text-danger'}">
                        ${isCredit ? '+' : '−'}${formatMoney(t.amount)}
                      </td>
                    </tr>
                  `;
                    })
                    .join('')}
                </tbody>
              </table>`
            : `<p class="muted">Aucune opération sur ce compte.</p>`
        }
      </div>
    `;

    content.querySelectorAll('.account-card').forEach((el) => {
      el.addEventListener('click', () => {
        activeId = el.getAttribute('data-id');
        renderAll();
      });
    });
  }

  await renderAll();
}

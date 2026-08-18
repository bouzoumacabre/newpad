import { renderIrsShell } from './shell.js';
import { listIrsAccounts } from '../../lib/irsApi.js';
import { formatMoney, statusBadge, escapeHtml } from '../../lib/format.js';

export async function renderIrsAccounts(app, profile) {
  const { content } = await renderIrsShell(app, profile, 'accounts');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  let query = '';

  async function draw() {
    const accounts = await listIrsAccounts(query).catch(() => []);

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Comptes</h1>
      <p class="muted" style="margin-bottom:20px;">Registre en lecture seule — la trésorerie de la banque n'apparaît pas ici. Les comptes masqués par l'administration pour l'interface IRS n'apparaissent pas non plus.</p>

      <div class="card" style="margin-bottom:20px;">
        <input type="text" id="search-input" placeholder="Rechercher par titulaire ou IBAN..." value="${escapeHtml(query)}" style="max-width:360px;" />
      </div>

      <div class="card">
        ${
          accounts.length
            ? `<table>
                <thead><tr><th>Titulaire</th><th>Type</th><th>IBAN</th><th style="text-align:right;">Solde</th><th>Statut</th></tr></thead>
                <tbody>
                  ${accounts
                    .map(
                      (a) => `
                    <tr>
                      <td style="font-weight:600;">${escapeHtml(a.owner_name)}</td>
                      <td class="muted">${escapeHtml(a.account_type)}</td>
                      <td class="muted" style="font-family:monospace; font-size:12px;">${escapeHtml(a.iban)}</td>
                      <td style="text-align:right; font-weight:600;">${formatMoney(a.balance)}</td>
                      <td>${statusBadge(a.status)}</td>
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>`
            : `<p class="muted">Aucun compte trouvé.</p>`
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

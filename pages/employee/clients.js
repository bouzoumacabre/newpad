import { renderEmployeeShell } from './shell.js';
import {
  searchClients,
  getClientProfile,
  getClientAccounts,
  getClientCategories,
  getClientCategoryLinks,
  addClientCategoryLink,
  removeClientCategoryLink,
  getClientLoans,
} from '../../lib/employeeApi.js';
import { formatMoney, formatDate, statusBadge, escapeHtml } from '../../lib/format.js';

export async function renderEmployeeClients(app, profile, params = {}) {
  const { content } = await renderEmployeeShell(app, profile, 'clients');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  let selectedId = params.id || null;
  let query = '';

  async function draw() {
    const [results, allCategories] = await Promise.all([
      searchClients(query).catch(() => []),
      getClientCategories().catch(() => []),
    ]);

    let detailHtml = '<div class="card"><p class="muted">Sélectionnez un client dans la liste pour voir sa fiche.</p></div>';
    if (selectedId) {
      const [detail, accounts, links, loans] = await Promise.all([
        getClientProfile(selectedId).catch(() => null),
        getClientAccounts(selectedId).catch(() => []),
        getClientCategoryLinks(selectedId).catch(() => []),
        getClientLoans(selectedId).catch(() => []),
      ]);
      if (detail) {
        const total = accounts.reduce((s, a) => s + Number(a.balance), 0);
        const linkedIds = new Set(links.map((l) => l.category_id));
        detailHtml = `
          <div class="card">
            <div class="flex justify-between items-center" style="margin-bottom:16px;">
              <div>
                <h3 style="margin:0;">${escapeHtml(detail.display_name)}</h3>
                <div class="muted" style="font-size:13px;">@${escapeHtml(detail.username)} — client depuis le ${detail.client_since ? formatDate(detail.client_since) : '—'}</div>
              </div>
              <div class="font-display gold" style="font-size:22px;">${formatMoney(total)}</div>
            </div>

            <div style="margin-bottom:16px;">
              <div class="muted" style="font-size:12px; margin-bottom:6px;">Note de confiance : ${detail.trust_score}/100 — Statut : ${escapeHtml(detail.status)}</div>
            </div>

            <div style="margin-bottom:16px;">
              <div class="muted" style="font-size:12px; margin-bottom:8px;">Catégories</div>
              <div class="flex gap-sm" style="flex-wrap:wrap;">
                ${allCategories
                  .map((c) => {
                    const active = linkedIds.has(c.id);
                    return `<button class="badge cat-toggle" data-id="${c.id}" data-active="${active}" style="cursor:pointer; border:1px solid ${c.color}; ${active ? `background:${c.color}22; color:${c.color};` : 'background:transparent; color:var(--text-muted);'}">${escapeHtml(c.name)}</button>`;
                  })
                  .join('')}
              </div>
            </div>

            <div style="margin-bottom:16px;">
              <div class="muted" style="font-size:12px; margin-bottom:8px;">Comptes (${accounts.length})</div>
              ${
                accounts.length
                  ? `<table><tbody>${accounts
                      .map((a) => `<tr><td>${escapeHtml(a.account_type)} — ${escapeHtml(a.iban)}</td><td style="text-align:right;">${formatMoney(a.balance)}</td></tr>`)
                      .join('')}</tbody></table>`
                  : `<p class="muted">Aucun compte.</p>`
              }
            </div>

            <div>
              <div class="muted" style="font-size:12px; margin-bottom:8px;">Prêts (${loans.length})</div>
              ${
                loans.length
                  ? `<table><tbody>${loans
                      .map((l) => `<tr><td>${formatMoney(l.requested_amount)}</td><td style="text-align:right;">${statusBadge(l.status)}</td></tr>`)
                      .join('')}</tbody></table>`
                  : `<p class="muted">Aucun prêt.</p>`
              }
            </div>
          </div>
        `;
      }
    }

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Recherche clients</h1>
      <div class="grid" style="grid-template-columns: 1fr 1.4fr; align-items:start;">
        <div class="card">
          <div class="field">
            <input type="text" id="search-input" placeholder="Nom ou identifiant..." value="${escapeHtml(query)}" />
          </div>
          <div style="max-height:520px; overflow-y:auto;">
            ${
              results.length
                ? results
                    .map(
                      (c) => `
              <div class="client-row" data-id="${c.id}" style="padding:10px 8px; border-radius:var(--radius-sm); cursor:pointer; ${c.id === selectedId ? 'background: rgba(201,162,39,0.1);' : ''}">
                <div style="font-weight:600; font-size:14px;">${escapeHtml(c.display_name)}</div>
                <div class="muted" style="font-size:12px;">@${escapeHtml(c.username)}</div>
              </div>
            `
                    )
                    .join('')
                : `<p class="muted" style="padding:8px;">Aucun résultat.</p>`
            }
          </div>
        </div>
        <div id="client-detail">${detailHtml}</div>
      </div>
    `;

    const searchInput = document.getElementById('search-input');
    let debounce;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { query = searchInput.value; draw(); }, 300);
    });
    searchInput.focus();
    searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);

    content.querySelectorAll('.client-row').forEach((el) => {
      el.addEventListener('click', () => { selectedId = el.getAttribute('data-id'); draw(); });
    });

    content.querySelectorAll('.cat-toggle').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const catId = btn.getAttribute('data-id');
        const active = btn.getAttribute('data-active') === 'true';
        try {
          if (active) await removeClientCategoryLink(selectedId, catId);
          else await addClientCategoryLink(selectedId, catId);
          await draw();
        } catch (err) {
          alert(err.message || 'Erreur.');
        }
      });
    });
  }

  await draw();
}

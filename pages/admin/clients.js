import { renderAdminShell } from './shell.js';
import {
  searchClients,
  getClientProfile,
  getClientAccounts,
  getClientCategories,
  getClientCategoryLinks,
  addClientCategoryLink,
  removeClientCategoryLink,
  getClientLoans,
  adminSetProfileStatus,
  adminSetAccountStatus,
  updateProfileOverrides,
} from '../../lib/adminApi.js';
import { formatMoney, formatDate, statusBadge, escapeHtml } from '../../lib/format.js';

const PROFILE_STATUSES = ['active', 'suspended', 'frozen'];
const ACCOUNT_STATUSES = ['active', 'frozen', 'closed'];

export async function renderAdminClients(app, profile, params = {}) {
  const { content } = await renderAdminShell(app, profile, 'clients');
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
                      .map(
                        (a) => `
                    <tr>
                      <td>${escapeHtml(a.account_type)} — ${escapeHtml(a.iban)}</td>
                      <td style="text-align:right;">${formatMoney(a.balance)}</td>
                      <td style="text-align:right;">${statusBadge(a.status)}</td>
                      <td style="text-align:right;">
                        <select class="account-status-select" data-id="${a.id}" style="width:auto; display:inline-block; padding:4px 8px; font-size:12px;">
                          ${ACCOUNT_STATUSES.map((s) => `<option value="${s}" ${s === a.status ? 'selected' : ''}>${s}</option>`).join('')}
                        </select>
                        <button class="btn btn-secondary account-status-save" data-id="${a.id}" style="padding:4px 10px; font-size:12px;">Appliquer</button>
                      </td>
                    </tr>
                  `
                      )
                      .join('')}</tbody></table>`
                  : `<p class="muted">Aucun compte.</p>`
              }
            </div>

            <div style="margin-bottom:16px;">
              <div class="muted" style="font-size:12px; margin-bottom:8px;">Prêts (${loans.length})</div>
              ${
                loans.length
                  ? `<table><tbody>${loans
                      .map((l) => `<tr><td>${formatMoney(l.requested_amount)}</td><td style="text-align:right;">${statusBadge(l.status)}</td></tr>`)
                      .join('')}</tbody></table>`
                  : `<p class="muted">Aucun prêt.</p>`
              }
            </div>

            <div style="margin-bottom:16px; padding-top:12px; border-top:1px solid var(--card-border);">
              <div class="muted" style="font-size:12px; margin-bottom:8px;">Statut du profil (admin)</div>
              <div class="flex gap-sm items-center">
                <select id="profile-status-select" style="width:auto;">
                  ${PROFILE_STATUSES.map((s) => `<option value="${s}" ${s === detail.status ? 'selected' : ''}>${s}</option>`).join('')}
                </select>
                <button id="profile-status-save" class="btn btn-secondary">Appliquer</button>
              </div>
            </div>

            <div style="padding-top:12px; border-top:1px solid var(--card-border);">
              <div class="muted" style="font-size:12px; margin-bottom:8px;">Exceptions individuelles</div>
              <div class="grid" style="grid-template-columns: 1fr 1fr 1fr; gap:10px; align-items:end;">
                <div class="field" style="margin:0;">
                  <label>Solde minimum (override)</label>
                  <input type="number" id="override-min-balance" step="0.01" value="${detail.min_balance_override ?? ''}" placeholder="—" />
                </div>
                <div class="field" style="margin:0;">
                  <label>Virement minimum (override)</label>
                  <input type="number" id="override-min-transfer" step="0.01" value="${detail.min_transfer_override ?? ''}" placeholder="—" />
                </div>
                <div class="field" style="margin:0;">
                  <label>Note de confiance</label>
                  <input type="number" id="override-trust-score" step="0.01" min="0" max="100" value="${detail.trust_score ?? ''}" />
                </div>
              </div>
              <button id="overrides-save" class="btn btn-primary" style="margin-top:10px;">Enregistrer les exceptions</button>
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

    content.querySelectorAll('.account-status-save').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const select = content.querySelector(`.account-status-select[data-id="${id}"]`);
        try { await adminSetAccountStatus(id, select.value); await draw(); }
        catch (err) { alert(err.message || 'Erreur.'); }
      });
    });

    document.getElementById('profile-status-save')?.addEventListener('click', async () => {
      const status = document.getElementById('profile-status-select').value;
      try { await adminSetProfileStatus(selectedId, status); await draw(); }
      catch (err) { alert(err.message || 'Erreur.'); }
    });

    document.getElementById('overrides-save')?.addEventListener('click', async () => {
      const minBalanceRaw = document.getElementById('override-min-balance').value;
      const minTransferRaw = document.getElementById('override-min-transfer').value;
      const trustScoreRaw = document.getElementById('override-trust-score').value;
      try {
        await updateProfileOverrides(selectedId, {
          minBalanceOverride: minBalanceRaw === '' ? null : parseFloat(minBalanceRaw),
          minTransferOverride: minTransferRaw === '' ? null : parseFloat(minTransferRaw),
          trustScore: trustScoreRaw === '' ? undefined : parseFloat(trustScoreRaw),
        });
        await draw();
      } catch (err) { alert(err.message || 'Erreur.'); }
    });
  }

  await draw();
}

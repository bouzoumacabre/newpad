import { renderAdminShell } from './shell.js';
import { getIrsAccounts, grantIrsAccount, revokeIrsAccount, searchProfilesAnyRole } from '../../lib/adminApi.js';
import { formatDateTime, escapeHtml } from '../../lib/format.js';

export async function renderAdminIrsAccounts(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'irs-accounts');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  let query = '';
  let results = [];

  async function draw() {
    const accounts = await getIrsAccounts().catch(() => []);
    const active = accounts.filter((a) => !a.revoked_at);
    const revoked = accounts.filter((a) => a.revoked_at);

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Comptes IRS</h1>
      <p class="muted" style="margin-bottom:20px;">Accès binaire (non modulable par permission) réservé aux profils de rôle IRS. Recherchez un profil et accordez-lui l'accès.</p>

      <div class="card" style="margin-bottom:20px;">
        <h3 style="margin-bottom:12px;">Accorder un accès</h3>
        <div class="field">
          <input type="text" id="search-input" placeholder="Nom ou identifiant..." value="${escapeHtml(query)}" />
        </div>
        <div style="max-height:240px; overflow-y:auto;">
          ${
            results.length
              ? results
                  .map(
                    (r) => `
            <div class="flex justify-between items-center" style="padding:8px;">
              <div>
                <div style="font-weight:600; font-size:14px;">${escapeHtml(r.display_name)}</div>
                <div class="muted" style="font-size:12px;">@${escapeHtml(r.username)} — rôle : ${escapeHtml(r.role)}</div>
              </div>
              <button class="btn btn-secondary grant-btn" data-id="${r.id}" style="padding:4px 12px; font-size:12px;">Accorder l'accès IRS</button>
            </div>
          `
                  )
                  .join('')
              : `<p class="muted" style="padding:8px;">${query.trim().length < 2 ? 'Saisissez au moins 2 caractères.' : 'Aucun résultat.'}</p>`
          }
        </div>
      </div>

      <h3 style="margin-bottom:12px;">Accès actifs (${active.length})</h3>
      <div class="card" style="margin-bottom:24px;">
        ${
          active.length
            ? `<table>
                <thead><tr><th>Compte</th><th>Accordé le</th><th></th></tr></thead>
                <tbody>
                  ${active
                    .map(
                      (a) => `
                    <tr>
                      <td>${escapeHtml(a.profiles?.display_name || a.profile_id)} <span class="muted" style="font-size:12px;">(@${escapeHtml(a.profiles?.username || '')})</span></td>
                      <td class="muted">${formatDateTime(a.granted_at)}</td>
                      <td><button class="btn btn-danger revoke-btn" data-id="${a.profile_id}" style="padding:4px 12px; font-size:12px;">Révoquer</button></td>
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>`
            : `<p class="muted">Aucun accès actif.</p>`
        }
      </div>

      ${
        revoked.length
          ? `
      <h3 style="margin-bottom:12px;">Historique des révocations</h3>
      <div class="card">
        <table>
          <thead><tr><th>Compte</th><th>Accordé le</th><th>Révoqué le</th></tr></thead>
          <tbody>
            ${revoked
              .map(
                (a) => `
              <tr>
                <td>${escapeHtml(a.profiles?.display_name || a.profile_id)}</td>
                <td class="muted">${formatDateTime(a.granted_at)}</td>
                <td class="muted">${formatDateTime(a.revoked_at)}</td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
      `
          : ''
      }
    `;

    const searchInput = document.getElementById('search-input');
    let debounce;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        query = searchInput.value;
        results = await searchProfilesAnyRole(query).catch(() => []);
        draw();
      }, 300);
    });

    content.querySelectorAll('.grant-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await grantIrsAccount(btn.getAttribute('data-id')); await draw(); }
        catch (err) { alert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.revoke-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await revokeIrsAccount(btn.getAttribute('data-id')); await draw(); }
        catch (err) { alert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

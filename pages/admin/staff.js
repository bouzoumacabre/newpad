import { renderAdminShell } from './shell.js';
import { searchProfilesAnyRole, updateProfileRole, adminSetProfileStatus } from '../../lib/adminApi.js';
import { escapeHtml } from '../../lib/format.js';

const ROLES = ['prospect', 'client', 'employee', 'admin', 'irs'];
const STATUSES = ['active', 'suspended', 'frozen'];

export async function renderAdminStaff(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'staff');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  let query = '';
  let results = [];
  let selected = null;

  async function draw() {
    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Employés & rôles</h1>
      <p class="muted" style="margin-bottom:20px;">
        Il n'existe pas de formulaire de création directe de compte employé/admin/IRS (cela nécessiterait une fonction
        serveur avec clé service_role, non déployée). La marche à suivre : la personne s'inscrit normalement depuis la
        page d'accueil (ce qui crée un profil « prospect »), puis vous la retrouvez ici par sa recherche et lui
        attribuez le rôle et, le cas échéant, la fonction souhaités.
      </p>

      <div class="grid" style="grid-template-columns: 1fr 1.3fr; align-items:start;">
        <div class="card">
          <div class="field">
            <input type="text" id="search-input" placeholder="Nom ou identifiant..." value="${escapeHtml(query)}" />
          </div>
          <div style="max-height:520px; overflow-y:auto;">
            ${
              results.length
                ? results
                    .map(
                      (r) => `
              <div class="staff-row" data-id="${r.id}" style="padding:10px 8px; border-radius:var(--radius-sm); cursor:pointer; ${selected?.id === r.id ? 'background: rgba(201,162,39,0.1);' : ''}">
                <div style="font-weight:600; font-size:14px;">${escapeHtml(r.display_name)}</div>
                <div class="muted" style="font-size:12px;">@${escapeHtml(r.username)} — ${escapeHtml(r.role)}</div>
              </div>
            `
                    )
                    .join('')
                : `<p class="muted" style="padding:8px;">${query.trim().length < 2 ? 'Saisissez au moins 2 caractères.' : 'Aucun résultat.'}</p>`
            }
          </div>
        </div>

        <div class="card">
          ${
            selected
              ? `
            <h3 style="margin:0 0 4px;">${escapeHtml(selected.display_name)}</h3>
            <div class="muted" style="font-size:13px; margin-bottom:20px;">@${escapeHtml(selected.username)}</div>

            <div class="field">
              <label>Rôle</label>
              <select id="edit-role">
                ${ROLES.map((r) => `<option value="${r}" ${r === selected.role ? 'selected' : ''}>${r}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>Fonction (employé/admin)</label>
              <input type="text" id="edit-title" value="${escapeHtml(selected.employee_title || '')}" placeholder="Ex: Guichetier, Directeur d'agence..." />
            </div>
            <div class="field">
              <label>Statut du profil</label>
              <select id="edit-status">
                ${STATUSES.map((s) => `<option value="${s}" ${s === selected.status ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
            </div>
            <div id="staff-msg" style="font-size:13px; margin-bottom:12px; display:none;"></div>
            <button id="staff-save" class="btn btn-primary">Enregistrer</button>
          `
              : `<p class="muted">Sélectionnez un profil dans la liste pour modifier son rôle.</p>`
          }
        </div>
      </div>
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
    searchInput.focus();
    searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);

    content.querySelectorAll('.staff-row').forEach((el) => {
      el.addEventListener('click', () => {
        selected = results.find((r) => r.id === el.getAttribute('data-id')) || null;
        draw();
      });
    });

    document.getElementById('staff-save')?.addEventListener('click', async () => {
      const msg = document.getElementById('staff-msg');
      const role = document.getElementById('edit-role').value;
      const title = document.getElementById('edit-title').value.trim();
      const status = document.getElementById('edit-status').value;
      try {
        await updateProfileRole(selected.id, { role, employeeTitle: title || null });
        if (status !== selected.status) await adminSetProfileStatus(selected.id, status);
        msg.textContent = 'Profil mis à jour.';
        msg.className = 'text-success';
        msg.style.display = 'block';
        results = await searchProfilesAnyRole(query).catch(() => results);
        selected = results.find((r) => r.id === selected.id) || selected;
      } catch (err) {
        msg.textContent = err.message || 'Erreur.';
        msg.className = 'text-danger';
        msg.style.display = 'block';
      }
    });
  }

  await draw();
}

import { renderAdminShell } from './shell.js';
import {
  getFeatureRegistry,
  upsertFeatureFlag,
  setFeatureEnabled,
  searchProfilesAnyRole,
  getPermissionGrants,
  upsertPermissionGrant,
  deletePermissionGrant,
} from '../../lib/adminApi.js';
import { formatDateTime, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';

const ROLES = ['prospect', 'client', 'employee', 'admin', 'irs'];
const AREAS = ['client', 'employee', 'admin', 'irs', 'public'];

export async function renderAdminPermissions(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'permissions');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  let query = '';
  let results = [];
  let selectedAccount = null;

  function groupByArea(features) {
    const groups = {};
    for (const f of features) {
      if (!groups[f.area]) groups[f.area] = [];
      groups[f.area].push(f);
    }
    return groups;
  }

  async function draw() {
    const [features, grants] = await Promise.all([
      getFeatureRegistry().catch(() => []),
      selectedAccount ? getPermissionGrants(selectedAccount.id).catch(() => []) : Promise.resolve([]),
    ]);
    const grouped = groupByArea(features);

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Permissions</h1>

      <h3 style="margin-bottom:12px;">Registre de fonctionnalités</h3>
      ${AREAS.filter((a) => grouped[a]?.length)
        .map(
          (area) => `
        <div class="card" style="margin-bottom:16px;">
          <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:10px;">${area}</div>
          <table>
            <thead><tr><th>Clé</th><th>Libellé</th><th>Catégorie</th><th>Rôles par défaut</th><th>Actif</th></tr></thead>
            <tbody>
              ${grouped[area]
                .map(
                  (f) => `
                <tr>
                  <td class="muted" style="font-size:12px;">${escapeHtml(f.key)}</td>
                  <td><input type="text" class="feat-label" data-key="${f.key}" value="${escapeHtml(f.label)}" style="padding:4px 8px; font-size:13px;" /></td>
                  <td><input type="text" class="feat-category" data-key="${f.key}" value="${escapeHtml(f.category || '')}" style="width:110px; padding:4px 8px; font-size:13px;" /></td>
                  <td class="muted" style="font-size:12px;">${(f.default_roles || []).join(', ')}</td>
                  <td>
                    <input type="checkbox" class="feat-enabled" data-key="${f.key}" ${f.enabled ? 'checked' : ''} ${f.is_core ? 'disabled title="Fonctionnalité essentielle — ne peut pas être désactivée"' : ''} />
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `
        )
        .join('')}

      <div class="card" style="margin-bottom:24px;">
        <h3 style="margin-bottom:16px;">Ajouter une fonctionnalité</h3>
        <div class="grid" style="grid-template-columns: 1fr 1fr 1fr 1fr; gap:10px;">
          <div class="field" style="margin:0;"><label>Clé (unique)</label><input type="text" id="new-feat-key" placeholder="ex: client.example" /></div>
          <div class="field" style="margin:0;"><label>Libellé</label><input type="text" id="new-feat-label" /></div>
          <div class="field" style="margin:0;">
            <label>Zone</label>
            <select id="new-feat-area">${AREAS.map((a) => `<option value="${a}">${a}</option>`).join('')}</select>
          </div>
          <div class="field" style="margin:0;"><label>Catégorie</label><input type="text" id="new-feat-category" /></div>
        </div>
        <div class="field">
          <label>Rôles par défaut (séparés par virgule)</label>
          <input type="text" id="new-feat-roles" placeholder="ex: client,employee" />
        </div>
        <div id="new-feat-error" class="text-danger" style="font-size:13px; margin-bottom:10px; display:none;"></div>
        <button id="new-feat-submit" class="btn btn-primary">Ajouter</button>
      </div>

      <h3 style="margin-bottom:12px;">Exceptions par compte</h3>
      <div class="grid" style="grid-template-columns: 1fr 1.3fr; align-items:start;">
        <div class="card">
          <div class="field">
            <input type="text" id="search-input" placeholder="Nom ou identifiant..." value="${escapeHtml(query)}" />
          </div>
          <div style="max-height:400px; overflow-y:auto;">
            ${
              results.length
                ? results
                    .map(
                      (r) => `
              <div class="account-row" data-id="${r.id}" style="padding:10px 8px; border-radius:var(--radius-sm); cursor:pointer; ${selectedAccount?.id === r.id ? 'background: rgba(201,162,39,0.1);' : ''}">
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
            selectedAccount
              ? `
            <h4 style="margin:0 0 4px;">${escapeHtml(selectedAccount.display_name)}</h4>
            <div class="muted" style="font-size:12px; margin-bottom:16px;">@${escapeHtml(selectedAccount.username)}</div>

            ${
              grants.length
                ? `<table>
                    <thead><tr><th>Fonctionnalité</th><th>Accordé</th><th>Note</th><th>Le</th><th></th></tr></thead>
                    <tbody>
                      ${grants
                        .map(
                          (g) => `
                        <tr>
                          <td>${escapeHtml(g.feature_registry?.label || g.feature_key)}</td>
                          <td>${g.granted ? '<span class="badge badge-success">Oui</span>' : '<span class="badge badge-danger">Non</span>'}</td>
                          <td class="muted" style="font-size:12px;">${escapeHtml(g.note || '—')}</td>
                          <td class="muted" style="font-size:12px;">${formatDateTime(g.granted_at)}</td>
                          <td><button class="btn btn-ghost grant-delete" data-id="${g.id}" style="padding:4px 8px; font-size:12px; color:var(--status-danger);">Retirer</button></td>
                        </tr>
                      `
                        )
                        .join('')}
                    </tbody>
                  </table>`
                : `<p class="muted" style="margin-bottom:16px;">Aucune exception pour ce compte.</p>`
            }

            <div style="margin-top:16px; padding-top:16px; border-top:1px solid var(--card-border);">
              <div class="field">
                <label>Fonctionnalité</label>
                <select id="grant-feature">
                  ${features.map((f) => `<option value="${f.key}">${escapeHtml(f.label)} (${f.key})</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label>Accordé</label>
                <select id="grant-granted">
                  <option value="true">Oui — accès accordé explicitement</option>
                  <option value="false">Non — accès retiré explicitement</option>
                </select>
              </div>
              <div class="field">
                <label>Note</label>
                <input type="text" id="grant-note" placeholder="Optionnel" />
              </div>
              <button id="grant-submit" class="btn btn-primary">Enregistrer l'exception</button>
            </div>
          `
              : `<p class="muted">Sélectionnez un compte pour gérer ses exceptions.</p>`
          }
        </div>
      </div>
    `;

    content.querySelectorAll('.feat-enabled').forEach((el) => {
      el.addEventListener('change', async () => {
        try { await setFeatureEnabled(el.getAttribute('data-key'), el.checked); }
        catch (err) { await showAlert(err.message || 'Erreur.'); el.checked = !el.checked; }
      });
    });
    content.querySelectorAll('.feat-label, .feat-category').forEach((el) => {
      el.addEventListener('change', async () => {
        const key = el.getAttribute('data-key');
        const f = features.find((x) => x.key === key);
        if (!f) return;
        const label = content.querySelector(`.feat-label[data-key="${key}"]`).value.trim();
        const category = content.querySelector(`.feat-category[data-key="${key}"]`).value.trim();
        try {
          await upsertFeatureFlag({
            key,
            label,
            description: f.description,
            area: f.area,
            category: category || null,
            defaultRoles: f.default_roles,
            enabled: f.enabled,
            isCore: f.is_core,
          });
        } catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });

    document.getElementById('new-feat-submit').addEventListener('click', async () => {
      const errorEl = document.getElementById('new-feat-error');
      errorEl.style.display = 'none';
      const key = document.getElementById('new-feat-key').value.trim();
      const label = document.getElementById('new-feat-label').value.trim();
      const area = document.getElementById('new-feat-area').value;
      const category = document.getElementById('new-feat-category').value.trim();
      const roles = document.getElementById('new-feat-roles').value.split(',').map((r) => r.trim()).filter(Boolean);
      if (!key || !label) {
        errorEl.textContent = 'Veuillez renseigner au moins la clé et le libellé.';
        errorEl.style.display = 'block';
        return;
      }
      try {
        await upsertFeatureFlag({ key, label, area, category: category || null, defaultRoles: roles, enabled: true, isCore: false });
        await draw();
      } catch (err) {
        errorEl.textContent = err.message || "Erreur lors de l'ajout.";
        errorEl.style.display = 'block';
      }
    });

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

    content.querySelectorAll('.account-row').forEach((el) => {
      el.addEventListener('click', () => {
        selectedAccount = results.find((r) => r.id === el.getAttribute('data-id')) || null;
        draw();
      });
    });

    document.getElementById('grant-submit')?.addEventListener('click', async () => {
      const featureKey = document.getElementById('grant-feature').value;
      const granted = document.getElementById('grant-granted').value === 'true';
      const note = document.getElementById('grant-note').value.trim();
      try {
        await upsertPermissionGrant({ accountId: selectedAccount.id, featureKey, granted, note: note || null });
        await draw();
      } catch (err) { await showAlert(err.message || 'Erreur.'); }
    });

    content.querySelectorAll('.grant-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await deletePermissionGrant(btn.getAttribute('data-id')); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

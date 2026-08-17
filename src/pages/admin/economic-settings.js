import { renderAdminShell } from './shell.js';
import {
  getEconomicSettings,
  upsertEconomicSetting,
  searchProfilesAnyRole,
  getClientOverrides,
  upsertClientOverride,
  deleteClientOverride,
} from '../../lib/adminApi.js';
import { escapeHtml } from '../../lib/format.js';

const SYSTEM_CATEGORY = 'système';

function valueInputHtml(setting, cls) {
  const key = setting.key;
  if (setting.value_type === 'boolean') {
    return `<input type="checkbox" class="${cls}" data-key="${key}" ${setting.value?.enabled ? 'checked' : ''} />`;
  }
  if (setting.value_type === 'number' || setting.value_type === 'percent' || setting.value_type === 'money') {
    return `<input type="number" step="0.01" class="${cls}" data-key="${key}" value="${setting.value?.amount ?? ''}" style="width:150px;" />`;
  }
  return `<textarea class="${cls}" data-key="${key}" rows="2" style="width:260px; font-family:monospace; font-size:12px;">${escapeHtml(JSON.stringify(setting.value, null, 2))}</textarea>`;
}

function readValueInput(container, cls, key, valueType) {
  const el = container.querySelector(`.${cls}[data-key="${key}"]`);
  if (valueType === 'boolean') return { enabled: el.checked };
  if (valueType === 'number' || valueType === 'percent' || valueType === 'money') return { amount: parseFloat(el.value) || 0 };
  return JSON.parse(el.value);
}

export async function renderAdminEconomicSettings(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'economic-settings');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  let query = '';
  let results = [];
  let selectedClient = null;

  function groupByCategory(settings) {
    const groups = {};
    for (const s of settings) {
      const cat = s.category || 'Autre';
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(s);
    }
    return groups;
  }

  async function draw() {
    const allSettings = await getEconomicSettings().catch(() => []);
    const settings = allSettings.filter((s) => s.category !== SYSTEM_CATEGORY);
    const grouped = groupByCategory(settings);
    const overrides = selectedClient ? await getClientOverrides(selectedClient.id).catch(() => []) : [];

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Pilotage économique</h1>
      <p class="muted" style="margin-bottom:20px;">Tous les seuils et taux globaux de la banque. La configuration système (maintenance, bannière) se gère depuis « Configuration système ».</p>

      ${Object.keys(grouped)
        .sort()
        .map(
          (cat) => `
        <div class="card" style="margin-bottom:16px;">
          <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.04em; margin-bottom:10px;">${escapeHtml(cat)}</div>
          <table>
            <thead><tr><th>Paramètre</th><th>Valeur</th><th></th></tr></thead>
            <tbody>
              ${grouped[cat]
                .map(
                  (s) => `
                <tr>
                  <td>${escapeHtml(s.label)}<div class="muted" style="font-size:11px;">${escapeHtml(s.key)}</div></td>
                  <td>${valueInputHtml(s, 'setting-value')}</td>
                  <td><button class="btn btn-secondary setting-save" data-key="${s.key}" data-type="${s.value_type}" style="padding:4px 10px; font-size:12px;">Enregistrer</button></td>
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

      <h3 style="margin:28px 0 12px;">Exceptions par client</h3>
      <div class="grid" style="grid-template-columns: 1fr 1.3fr; align-items:start;">
        <div class="card">
          <div class="field">
            <input type="text" id="search-input" placeholder="Nom ou identifiant..." value="${escapeHtml(query)}" />
          </div>
          <div style="max-height:340px; overflow-y:auto;">
            ${
              results.length
                ? results
                    .map(
                      (r) => `
              <div class="client-row" data-id="${r.id}" style="padding:10px 8px; border-radius:var(--radius-sm); cursor:pointer; ${selectedClient?.id === r.id ? 'background: rgba(201,162,39,0.1);' : ''}">
                <div style="font-weight:600; font-size:14px;">${escapeHtml(r.display_name)}</div>
                <div class="muted" style="font-size:12px;">@${escapeHtml(r.username)}</div>
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
            selectedClient
              ? `
            <h4 style="margin:0 0 16px;">${escapeHtml(selectedClient.display_name)}</h4>
            ${
              overrides.length
                ? `<table>
                    <thead><tr><th>Paramètre</th><th>Valeur</th><th>Note</th><th></th></tr></thead>
                    <tbody>
                      ${overrides
                        .map(
                          (o) => `
                        <tr>
                          <td>${escapeHtml(o.economic_settings?.label || o.setting_key)}</td>
                          <td class="muted" style="font-size:12px;">${escapeHtml(JSON.stringify(o.value))}</td>
                          <td class="muted" style="font-size:12px;">${escapeHtml(o.note || '—')}</td>
                          <td><button class="btn btn-ghost override-delete" data-id="${o.id}" style="padding:4px 8px; font-size:12px; color:var(--status-danger);">Retirer</button></td>
                        </tr>
                      `
                        )
                        .join('')}
                    </tbody>
                  </table>`
                : `<p class="muted" style="margin-bottom:16px;">Aucune exception pour ce client.</p>`
            }
            <div style="margin-top:16px; padding-top:16px; border-top:1px solid var(--card-border);">
              <div class="field">
                <label>Paramètre</label>
                <select id="override-setting">
                  ${settings.map((s) => `<option value="${s.key}" data-type="${s.value_type}">${escapeHtml(s.label)}</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label>Valeur (JSON — ex: {"amount": 500000} ou {"enabled": true})</label>
                <input type="text" id="override-value" placeholder='{"amount": 500000}' />
              </div>
              <div class="field">
                <label>Note</label>
                <input type="text" id="override-note" placeholder="Optionnel" />
              </div>
              <div id="override-error" class="text-danger" style="font-size:13px; margin-bottom:10px; display:none;"></div>
              <button id="override-submit" class="btn btn-primary">Enregistrer l'exception</button>
            </div>
          `
              : `<p class="muted">Sélectionnez un client pour gérer ses exceptions.</p>`
          }
        </div>
      </div>
    `;

    content.querySelectorAll('.setting-save').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-key');
        const type = btn.getAttribute('data-type');
        try {
          const value = readValueInput(content, 'setting-value', key, type);
          await upsertEconomicSetting({ key, value });
          await draw();
        } catch (err) {
          alert(err.message || 'Valeur JSON invalide.');
        }
      });
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

    content.querySelectorAll('.client-row').forEach((el) => {
      el.addEventListener('click', () => {
        selectedClient = results.find((r) => r.id === el.getAttribute('data-id')) || null;
        draw();
      });
    });

    document.getElementById('override-submit')?.addEventListener('click', async () => {
      const errorEl = document.getElementById('override-error');
      errorEl.style.display = 'none';
      const settingKey = document.getElementById('override-setting').value;
      const note = document.getElementById('override-note').value.trim();
      const rawValue = document.getElementById('override-value').value.trim();
      try {
        const value = JSON.parse(rawValue);
        await upsertClientOverride({ clientId: selectedClient.id, settingKey, value, note: note || null });
        await draw();
      } catch (err) {
        errorEl.textContent = err.message || 'Valeur JSON invalide.';
        errorEl.style.display = 'block';
      }
    });

    content.querySelectorAll('.override-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await deleteClientOverride(btn.getAttribute('data-id')); await draw(); }
        catch (err) { alert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

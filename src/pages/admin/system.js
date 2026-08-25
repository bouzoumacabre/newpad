import { renderAdminShell } from './shell.js';
import { getEconomicSettings, upsertEconomicSetting } from '../../lib/adminApi.js';
import { escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';

const SYSTEM_CATEGORY = 'système';
const KNOWN_KEYS = ['maintenance_mode', 'announcement_banner'];

export async function renderAdminSystem(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'system');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const allSettings = await getEconomicSettings().catch(() => []);
    const systemSettings = allSettings.filter((s) => s.category === SYSTEM_CATEGORY);
    const maintenance = systemSettings.find((s) => s.key === 'maintenance_mode');
    const banner = systemSettings.find((s) => s.key === 'announcement_banner');
    const others = systemSettings.filter((s) => !KNOWN_KEYS.includes(s.key));

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Configuration système</h1>
      <p class="muted" style="margin-bottom:20px;">Paramètres transverses stockés dans la table générique <code>economic_settings</code> (catégorie « système »), afin de ne rien figer en dur.</p>

      ${
        maintenance
          ? `
      <div class="card" style="margin-bottom:20px;">
        <h3 style="margin-bottom:8px;">Mode maintenance</h3>
        <label class="flex items-center gap-sm" style="font-size:14px; font-weight:400; margin-bottom:8px;">
          <input type="checkbox" id="maintenance-toggle" ${maintenance.value?.enabled ? 'checked' : ''} /> Activer le mode maintenance
        </label>
        <p class="muted" style="font-size:12px; margin-bottom:12px;">
          Effet réel : suspend l'ouverture de nouveaux comptes depuis l'accueil public et affiche une notice de
          maintenance sur l'accueil public ainsi que sur les interfaces Client, Employé et IRS. Les connexions déjà
          existantes (clients, employés, admin, IRS) restent fonctionnelles — l'accès admin n'est jamais bloqué, pour
          toujours pouvoir désactiver ce mode depuis cet écran. Pour bloquer une fonctionnalité précise sur une
          interface précise, utilisez plutôt « Permissions ».
        </p>
        <button id="maintenance-save" class="btn btn-primary">Enregistrer</button>
      </div>
      `
          : ''
      }

      ${
        banner
          ? `
      <div class="card" style="margin-bottom:20px;">
        <h3 style="margin-bottom:8px;">Bannière d'annonce</h3>
        <label class="flex items-center gap-sm" style="font-size:14px; font-weight:400; margin-bottom:8px;">
          <input type="checkbox" id="banner-enabled" ${banner.value?.enabled ? 'checked' : ''} /> Bannière active
        </label>
        <div class="field">
          <label>Message</label>
          <input type="text" id="banner-message" value="${escapeHtml(banner.value?.message || '')}" placeholder="Message affiché aux utilisateurs..." />
        </div>
        <p class="muted" style="font-size:12px; margin-bottom:12px;">Effet réel : affichée en haut de l'accueil public et de toutes les interfaces internes (Client, Employé, Admin, IRS) tant qu'elle est active.</p>
        <button id="banner-save" class="btn btn-primary">Enregistrer</button>
      </div>
      `
          : ''
      }

      ${
        others.length
          ? `
      <h3 style="margin-bottom:12px;">Autres paramètres système</h3>
      <div class="card">
        <table>
          <thead><tr><th>Paramètre</th><th>Valeur (JSON)</th><th></th></tr></thead>
          <tbody>
            ${others
              .map(
                (s) => `
              <tr>
                <td>${escapeHtml(s.label)}<div class="muted" style="font-size:11px;">${escapeHtml(s.key)}</div></td>
                <td><textarea class="other-value" data-key="${s.key}" rows="2" style="width:260px; font-family:monospace; font-size:12px;">${escapeHtml(JSON.stringify(s.value, null, 2))}</textarea></td>
                <td><button class="btn btn-secondary other-save" data-key="${s.key}" style="padding:4px 10px; font-size:12px;">Enregistrer</button></td>
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

      ${!systemSettings.length ? `<p class="muted">Aucun paramètre système enregistré.</p>` : ''}
    `;

    // Comme sur /admin/economic-settings : un upsert qui n'envoie pas les
    // colonnes NOT NULL existantes (label, value_type, category) échoue
    // toujours avec "null value in column label", même sur une ligne
    // existante — il faut les renvoyer à chaque sauvegarde.
    document.getElementById('maintenance-save')?.addEventListener('click', async () => {
      try {
        await upsertEconomicSetting({
          key: 'maintenance_mode',
          value: { enabled: document.getElementById('maintenance-toggle').checked },
          label: maintenance?.label,
          valueType: maintenance?.value_type,
          category: maintenance?.category,
        });
        await draw();
      } catch (err) { await showAlert(err.message || 'Erreur.'); }
    });

    document.getElementById('banner-save')?.addEventListener('click', async () => {
      try {
        await upsertEconomicSetting({
          key: 'announcement_banner',
          value: { enabled: document.getElementById('banner-enabled').checked, message: document.getElementById('banner-message').value.trim() },
          label: banner?.label,
          valueType: banner?.value_type,
          category: banner?.category,
        });
        await draw();
      } catch (err) { await showAlert(err.message || 'Erreur.'); }
    });

    content.querySelectorAll('.other-save').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-key');
        const existing = others.find((s) => s.key === key);
        const textarea = content.querySelector(`.other-value[data-key="${key}"]`);
        try {
          const value = JSON.parse(textarea.value);
          await upsertEconomicSetting({ key, value, label: existing?.label, valueType: existing?.value_type, category: existing?.category });
          await draw();
        } catch (err) { await showAlert(err.message || 'JSON invalide.'); }
      });
    });
  }

  await draw();
}

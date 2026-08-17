import { renderAdminShell } from './shell.js';
import { getFraudAlerts, createManualFraudAlert, updateFraudAlertStatus, searchProfilesAnyRole } from '../../lib/employeeApi.js';
import { formatDateTime, escapeHtml } from '../../lib/format.js';

const SEVERITY_BADGE = { low: 'badge-neutral', medium: 'badge-pending', high: 'badge-danger' };

export async function renderAdminFraud(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'fraud');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  let matchedClientId = null;

  async function draw() {
    const alerts = await getFraudAlerts('open').catch(() => []);

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Alertes fraude</h1>

      <div class="card" style="margin-bottom:20px;">
        <h3 style="margin-bottom:16px;">Signaler manuellement</h3>
        <div class="grid" style="grid-template-columns: 1fr 1fr 2fr auto; gap:10px; align-items:end;">
          <div class="field" style="margin:0;">
            <label>Client (optionnel)</label>
            <input type="text" id="fraud-client" placeholder="Identifiant..." />
          </div>
          <div class="field" style="margin:0;">
            <label>Sévérité</label>
            <select id="fraud-severity">
              <option value="low">Faible</option>
              <option value="medium" selected>Moyenne</option>
              <option value="high">Élevée</option>
            </select>
          </div>
          <div class="field" style="margin:0;">
            <label>Description</label>
            <input type="text" id="fraud-description" placeholder="Décrivez le comportement suspect..." />
          </div>
          <button id="fraud-submit" class="btn btn-primary">Signaler</button>
        </div>
      </div>

      <div class="card">
        ${
          alerts.length
            ? alerts
                .map(
                  (a) => `
          <div style="padding:14px 0; border-bottom:1px solid var(--card-border);">
            <div class="flex justify-between items-center" style="margin-bottom:6px;">
              <div>
                <span class="badge ${SEVERITY_BADGE[a.severity]}">${a.severity === 'high' ? 'Élevée' : a.severity === 'medium' ? 'Moyenne' : 'Faible'}</span>
                <span class="muted" style="font-size:12px; margin-left:8px;">${a.origin === 'auto' ? 'Automatique' : 'Manuelle'} — ${formatDateTime(a.created_at)}</span>
              </div>
              ${a.profiles ? `<span class="muted" style="font-size:12px;">${escapeHtml(a.profiles.display_name)}</span>` : ''}
            </div>
            <div style="font-size:14px; margin-bottom:10px;">${escapeHtml(a.description)}</div>
            <div class="flex gap-sm">
              <button class="btn btn-secondary reviewed-btn" data-id="${a.id}">Marquer examiné</button>
              <button class="btn btn-ghost dismiss-btn" data-id="${a.id}" style="color:var(--text-muted);">Ignorer</button>
            </div>
          </div>
        `
                )
                .join('')
            : `<p class="muted">Aucune alerte ouverte.</p>`
        }
      </div>
    `;

    const clientInput = document.getElementById('fraud-client');
    let debounce;
    clientInput.addEventListener('input', () => {
      clearTimeout(debounce);
      matchedClientId = null;
      debounce = setTimeout(async () => {
        const matches = await searchProfilesAnyRole(clientInput.value).catch(() => []);
        const exact = matches.find((m) => m.username.toLowerCase() === clientInput.value.trim().toLowerCase());
        matchedClientId = exact ? exact.id : null;
      }, 300);
    });

    document.getElementById('fraud-submit').addEventListener('click', async () => {
      const severity = document.getElementById('fraud-severity').value;
      const description = document.getElementById('fraud-description').value.trim();
      if (!description) { alert('Veuillez décrire le comportement suspect.'); return; }
      try {
        await createManualFraudAlert({ severity, clientId: matchedClientId, description });
        await draw();
      } catch (err) { alert(err.message || 'Erreur.'); }
    });

    content.querySelectorAll('.reviewed-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await updateFraudAlertStatus(btn.getAttribute('data-id'), 'reviewed'); await draw(); }
        catch (err) { alert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.dismiss-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await updateFraudAlertStatus(btn.getAttribute('data-id'), 'dismissed'); await draw(); }
        catch (err) { alert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

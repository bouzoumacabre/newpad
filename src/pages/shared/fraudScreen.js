// ============================================================================
// NEWPAD — Alertes de fraude, partagé par les interfaces Employé et Admin.
// ============================================================================

import {
  getFraudAlerts,
  createManualFraudAlert,
  updateFraudAlertStatus,
  searchProfilesAnyRole,
} from '../../lib/employeeApi.js';
import { formatDateTime, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';
import { loadAll, loadErrorBanner } from '../../lib/loadState.js';

const SEVERITY_BADGE = { low: 'badge-neutral', medium: 'badge-pending', high: 'badge-danger' };
const SEVERITY_LABEL = { low: 'Faible', medium: 'Moyenne', high: 'Élevée' };
const STATUS_LABEL = { open: 'Ouverte', reviewed: 'Examinée', dismissed: 'Ignorée' };

export async function renderFraudScreen(content, profile, basePath) {
  content.innerHTML = `<p class="muted">Chargement…</p>`;
  let matchedClientId = null;
  let matchedClientName = '';

  async function draw() {
    const { data, errors } = await loadAll({ alerts: getFraudAlerts() });
    const alerts = data.alerts;
    const ouvertes = alerts.filter((a) => a.status === 'open');
    const traitees = alerts.filter((a) => a.status !== 'open').slice(0, 40);

    const bloc = (a, actions) => `
      <div style="padding:14px 0; border-bottom:1px solid var(--card-border);">
        <div class="flex justify-between items-center" style="margin-bottom:6px; gap:10px; flex-wrap:wrap;">
          <div>
            <span class="badge ${SEVERITY_BADGE[a.severity] || 'badge-neutral'}">${SEVERITY_LABEL[a.severity] || a.severity}</span>
            <span class="muted" style="font-size:12px; margin-left:8px;">
              ${a.origin === 'auto' ? 'Détectée automatiquement' : 'Signalée par le personnel'} — ${formatDateTime(a.created_at)}
              ${a.status !== 'open' ? ` — ${STATUS_LABEL[a.status] || a.status}` : ''}
            </span>
          </div>
          ${a.profiles ? `<span class="muted" style="font-size:12px;">${escapeHtml(a.profiles.display_name)}</span>` : ''}
        </div>
        <div style="font-size:14px; margin-bottom:8px; white-space:pre-wrap;">${escapeHtml(a.description)}</div>
        ${a.resolution_note ? `<div class="muted" style="font-size:12px; margin-bottom:8px; white-space:pre-wrap;">Traitement : ${escapeHtml(a.resolution_note)}</div>` : ''}
        ${actions}
      </div>
    `;

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Alertes fraude</h1>
      <p class="muted" style="margin-bottom:20px; font-size:13px;">
        La description d'une alerte n'est jamais modifiable, y compris par l'admin : classer une alerte n'écrit que son statut
        et la note de traitement.
      </p>
      ${loadErrorBanner(errors)}

      <div class="card" style="margin-bottom:20px;">
        <h3 style="margin-bottom:16px;">Signaler manuellement</h3>
        <div class="grid" style="grid-template-columns: 1fr 1fr 2fr auto; gap:10px; align-items:end;">
          <div class="field" style="margin:0;">
            <label for="fraud-client">Client (optionnel)</label>
            <input type="text" id="fraud-client" placeholder="Identifiant exact..." />
            <div id="fraud-client-match" class="muted" style="font-size:12px; margin-top:4px;">&nbsp;</div>
          </div>
          <div class="field" style="margin:0;">
            <label for="fraud-severity">Gravité</label>
            <select id="fraud-severity">
              <option value="low">Faible</option>
              <option value="medium" selected>Moyenne</option>
              <option value="high">Élevée</option>
            </select>
          </div>
          <div class="field" style="margin:0;">
            <label for="fraud-description">Description</label>
            <input type="text" id="fraud-description" maxlength="2000" placeholder="Décrivez le comportement suspect..." />
          </div>
          <button id="fraud-submit" class="btn btn-primary">Signaler</button>
        </div>
      </div>

      <h3 style="margin-bottom:12px;">Alertes ouvertes (${ouvertes.length})</h3>
      <div class="card" style="margin-bottom:24px;">
        ${
          ouvertes.length
            ? ouvertes
                .map((a) =>
                  bloc(
                    a,
                    `<div class="flex gap-sm">
                       <button class="btn btn-secondary reviewed-btn" data-id="${a.id}">Marquer examinée</button>
                       <button class="btn btn-ghost dismiss-btn" data-id="${a.id}" style="color:var(--text-muted);">Ignorer</button>
                     </div>`
                  )
                )
                .join('')
            : `<p class="muted">Aucune alerte ouverte.</p>`
        }
      </div>

      <h3 style="margin-bottom:12px;">Alertes traitées</h3>
      <div class="card">
        ${
          traitees.length
            ? traitees
                .map((a) =>
                  bloc(a, `<button class="btn btn-ghost reopen-btn" data-id="${a.id}" style="font-size:12px; padding:4px 10px;">Rouvrir</button>`)
                )
                .join('')
            : `<p class="muted">Aucune alerte traitée.</p>`
        }
      </div>
    `;

    const clientInput = document.getElementById('fraud-client');
    const matchEl = document.getElementById('fraud-client-match');
    let debounce;
    clientInput.addEventListener('input', () => {
      clearTimeout(debounce);
      matchedClientId = null;
      matchedClientName = '';
      matchEl.innerHTML = '&nbsp;';
      const typed = clientInput.value.trim();
      if (!typed) return;
      debounce = setTimeout(async () => {
        const matches = await searchProfilesAnyRole(typed).catch(() => []);
        const exact = matches.find((m) => m.username.toLowerCase() === typed.toLowerCase());
        matchedClientId = exact ? exact.id : null;
        matchedClientName = exact ? exact.display_name : '';
        // Le champ acceptait n'importe quoi en silence : une faute de frappe
        // produisait une alerte sans client rattaché, sans que l'on sache que
        // le rattachement avait échoué.
        matchEl.textContent = exact
          ? `Rattachée à ${exact.display_name}`
          : 'Aucun profil ne porte exactement cet identifiant — l’alerte sera enregistrée sans client rattaché.';
      }, 300);
    });

    document.getElementById('fraud-submit').addEventListener('click', async () => {
      const severity = document.getElementById('fraud-severity').value;
      const description = document.getElementById('fraud-description').value.trim();
      if (!description) { await showAlert('Veuillez décrire le comportement suspect.'); return; }
      if (clientInput.value.trim() && !matchedClientId) {
        if (!(await showConfirm("Aucun profil ne correspond exactement à cet identifiant. Enregistrer l'alerte sans client rattaché ?"))) return;
      }
      try {
        await createManualFraudAlert({ severity, clientId: matchedClientId, description });
        matchedClientId = null;
        matchedClientName = '';
        await draw();
      } catch (err) { await showAlert(err.message || 'Erreur.'); }
    });

    const classer = async (btn, status, question) => {
      const note = (await showPrompt(question)) || null;
      btn.disabled = true;
      try { await updateFraudAlertStatus(btn.getAttribute('data-id'), status, note); await draw(); }
      catch (err) { await showAlert(err.message || 'Erreur.'); btn.disabled = false; }
    };

    content.querySelectorAll('.reviewed-btn').forEach((btn) => {
      btn.addEventListener('click', () => classer(btn, 'reviewed', 'Note de traitement (optionnelle) — ce qui a été vérifié :'));
    });
    content.querySelectorAll('.dismiss-btn').forEach((btn) => {
      btn.addEventListener('click', () => classer(btn, 'dismissed', 'Motif du classement sans suite (optionnel) :'));
    });
    content.querySelectorAll('.reopen-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!(await showConfirm('Rouvrir cette alerte ?'))) return;
        btn.disabled = true;
        try { await updateFraudAlertStatus(btn.getAttribute('data-id'), 'open', null); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); btn.disabled = false; }
      });
    });
  }

  await draw();
}

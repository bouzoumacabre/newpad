import { renderEmployeeShell } from './shell.js';
import { getAuditLog } from '../../lib/employeeApi.js';
import { formatDateTime, escapeHtml, auditActionLabel, auditDetailsText } from '../../lib/format.js';

export async function renderEmployeeAudit(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'audit');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const entries = await getAuditLog(150).catch(() => []);

  content.innerHTML = `
    <h1 style="margin-bottom:6px;">Journal d'activité</h1>
    <p class="muted" style="margin-bottom:20px;">Qui a validé, refusé ou modifié quoi, et pour quel client — les 150 dernières actions du personnel.</p>
    <div class="card" style="overflow-x:auto;">
      ${
        entries.length
          ? `<table>
              <thead><tr><th>Date</th><th>Auteur</th><th>Rôle</th><th>Action</th><th>Détails</th></tr></thead>
              <tbody>
                ${entries
                  .map(
                    (e) => `
                  <tr>
                    <td class="muted" style="white-space:nowrap;">${formatDateTime(e.created_at)}</td>
                    <td>${escapeHtml(e.profiles?.display_name || 'Système')}</td>
                    <td class="muted">${escapeHtml(e.actor_role || '—')}</td>
                    <td>${escapeHtml(auditActionLabel(e.action))}</td>
                    <td class="muted" style="font-size:13px;">${escapeHtml(auditDetailsText(e.details)) || '—'}</td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>`
          : `<p class="muted">Aucune entrée.</p>`
      }
    </div>
  `;
}

import { renderEmployeeShell } from './shell.js';
import { getAuditLog } from '../../lib/employeeApi.js';
import { formatDateTime, escapeHtml } from '../../lib/format.js';

export async function renderEmployeeAudit(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'audit');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const entries = await getAuditLog(150).catch(() => []);

  content.innerHTML = `
    <h1 style="margin-bottom:20px;">Journal d'activité</h1>
    <div class="card">
      ${
        entries.length
          ? `<table>
              <thead><tr><th>Date</th><th>Auteur</th><th>Action</th><th>Cible</th></tr></thead>
              <tbody>
                ${entries
                  .map(
                    (e) => `
                  <tr>
                    <td class="muted">${formatDateTime(e.created_at)}</td>
                    <td>${escapeHtml(e.profiles?.display_name || 'Système')}</td>
                    <td>${escapeHtml(e.action)}</td>
                    <td class="muted">${escapeHtml(e.target_type || '—')}</td>
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

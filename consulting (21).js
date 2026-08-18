import { renderEmployeeShell } from './shell.js';
import { getConsultingQueue, assignConsultingRequest } from '../../lib/employeeApi.js';
import { formatDateTime, escapeHtml } from '../../lib/format.js';

const STATUS_LABELS = { pending: 'En attente', assigned: 'Assigné', closed: 'Clôturé' };

export async function renderEmployeeConsulting(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'consulting');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const requests = await getConsultingQueue().catch(() => []);

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Consulting Premium</h1>
      <div class="card">
        ${
          requests.length
            ? requests
                .map(
                  (r) => `
          <div style="padding:14px 0; border-bottom:1px solid var(--card-border);">
            <div class="flex justify-between items-center" style="margin-bottom:6px;">
              <div>
                <div style="font-weight:600;">${escapeHtml(r.profiles?.display_name || '')}</div>
                <div class="muted" style="font-size:12px;">${formatDateTime(r.created_at)}</div>
              </div>
              <span class="badge ${r.status === 'pending' ? 'badge-pending' : r.status === 'assigned' ? 'badge-success' : 'badge-neutral'}">${STATUS_LABELS[r.status]}</span>
            </div>
            <div style="font-size:14px; margin-bottom:10px;">${escapeHtml(r.message || '')}</div>
            ${r.status === 'pending' ? `<button class="btn btn-secondary assign-btn" data-id="${r.id}">Prendre en charge</button>` : r.assigned_advisor_id === profile.id ? `<span class="muted" style="font-size:12px;">Assigné à vous</span>` : ''}
          </div>
        `
                )
                .join('')
            : `<p class="muted">Aucune demande.</p>`
        }
      </div>
    `;

    content.querySelectorAll('.assign-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await assignConsultingRequest(btn.getAttribute('data-id'), profile.id); await draw(); }
        catch (err) { alert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

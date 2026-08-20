import { renderEmployeeShell } from './shell.js';
import { getMembershipRequests, claimMembershipRequest, decideMembershipRequest } from '../../lib/employeeApi.js';
import { formatMoney, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';

export async function renderEmployeeMembership(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'membership');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const requests = await getMembershipRequests(['pending', 'processing']).catch(() => []);

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Demandes d'adhésion</h1>
      <div class="card">
        ${
          requests.length
            ? requests
                .map(
                  (r) => `
          <div class="request-row" style="padding:16px 0; border-bottom:1px solid var(--card-border);">
            <div class="flex justify-between items-center" style="margin-bottom:8px;">
              <div>
                <div style="font-weight:600;">${escapeHtml(r.profiles?.display_name || r.applicant_id)}</div>
                <div class="muted" style="font-size:12px;">@${escapeHtml(r.profiles?.username || '')} — ${formatDateTime(r.created_at)}</div>
              </div>
              ${statusBadge(r.status)}
            </div>
            <div style="font-size:14px; margin-bottom:4px;">
              Type : <strong>${escapeHtml(r.requested_account_type || 'courant')}</strong> —
              Dépôt initial : <strong class="gold">${formatMoney(r.initial_deposit)}</strong>
              ${r.requires_admin_override ? ' — <span class="text-danger">nécessite une autorisation admin (sous le solde minimum)</span>' : ''}
            </div>
            ${r.motivation ? `<div class="muted" style="font-size:13px; margin-bottom:10px;">${escapeHtml(r.motivation)}</div>` : ''}
            <div class="flex gap-sm">
              ${
                r.status === 'pending'
                  ? `<button class="btn btn-secondary claim-btn" data-id="${r.id}">Prendre en charge</button>`
                  : `
                <button class="btn btn-primary approve-btn" data-id="${r.id}">Approuver</button>
                <button class="btn btn-danger reject-btn" data-id="${r.id}">Refuser</button>
              `
              }
            </div>
          </div>
        `
                )
                .join('')
            : `<p class="muted">Aucune demande en attente.</p>`
        }
      </div>
    `;

    content.querySelectorAll('.claim-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await claimMembershipRequest(btn.getAttribute('data-id')); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.approve-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await decideMembershipRequest(btn.getAttribute('data-id'), true, null);
          await draw();
        } catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.reject-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = await showPrompt('Motif du refus (optionnel) :') || null;
        try {
          await decideMembershipRequest(btn.getAttribute('data-id'), false, note);
          await draw();
        } catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

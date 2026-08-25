import { renderEmployeeShell } from './shell.js';
import { getSafeRequestsQueue, getAvailableSafeBoxesForAssignment, claimSafeRequest, confirmSafeRental, rejectSafeRequest, decideSafeRequestSimple } from '../../lib/employeeApi.js';
import { formatMoney, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';

export async function renderEmployeeSafes(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'safes');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const [requests, availableBoxes] = await Promise.all([
      getSafeRequestsQueue().catch(() => []),
      getAvailableSafeBoxesForAssignment().catch(() => []),
    ]);
    const relevant = requests.filter((r) => r.status === 'pending' || r.status === 'processing');

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Coffres-forts à traiter</h1>
      <div class="card">
        ${
          relevant.length
            ? relevant
                .map((r) => {
                  if (r.status === 'pending') {
                    return `
              <div style="padding:16px 0; border-bottom:1px solid var(--card-border);">
                <div class="flex justify-between items-center" style="margin-bottom:10px;">
                  <div>
                    <div style="font-weight:600;">${escapeHtml(r.profiles?.display_name || '')}</div>
                    <div class="muted" style="font-size:12px;">Demandé le ${formatDateTime(r.requested_at)}</div>
                  </div>
                  ${statusBadge(r.status)}
                </div>
                <div class="grid" style="grid-template-columns: 1fr auto auto; gap:8px; align-items:end; margin-bottom:10px;">
                  <select class="simple-assign-box" data-id="${r.id}">
                    ${availableBoxes.length ? availableBoxes.map((b) => `<option value="${b.id}">${escapeHtml(b.code)} — ${formatMoney(b.weekly_fee)}/semaine</option>`).join('') : '<option value="">Aucun coffre disponible</option>'}
                  </select>
                  <button class="btn btn-primary simple-approve-btn" data-id="${r.id}" ${availableBoxes.length ? '' : 'disabled'}>Autoriser</button>
                  <button class="btn btn-danger reject-btn" data-id="${r.id}">Refuser</button>
                </div>
                <details>
                  <summary class="muted" style="font-size:12px; cursor:pointer;">Programmer un rendez-vous à la place (optionnel)</summary>
                  <div class="grid" style="grid-template-columns: 1fr 1fr 1fr; gap:8px; margin:10px 0;">
                    <select class="assign-box" data-id="${r.id}">
                      ${availableBoxes.map((b) => `<option value="${b.id}">${escapeHtml(b.code)} — ${formatMoney(b.weekly_fee)}/semaine</option>`).join('')}
                    </select>
                    <input type="datetime-local" class="assign-datetime" data-id="${r.id}" />
                    <input type="text" class="assign-location" data-id="${r.id}" placeholder="Lieu du rendez-vous" />
                  </div>
                  <button class="btn btn-secondary claim-btn" data-id="${r.id}">Programmer le rendez-vous</button>
                </details>
              </div>
            `;
                  }
                  return `
              <div style="padding:16px 0; border-bottom:1px solid var(--card-border);">
                <div class="flex justify-between items-center" style="margin-bottom:8px;">
                  <div>
                    <div style="font-weight:600;">${escapeHtml(r.profiles?.display_name || '')} — Coffre ${escapeHtml(r.safe_deposit_boxes?.code || '')}</div>
                    <div class="muted" style="font-size:12px;">Rendez-vous : ${r.appointment_at ? formatDateTime(r.appointment_at) : '—'} ${r.appointment_location ? '— ' + escapeHtml(r.appointment_location) : ''}</div>
                  </div>
                  ${statusBadge(r.status)}
                </div>
                <div class="flex gap-sm">
                  <button class="btn btn-primary confirm-btn" data-id="${r.id}">Confirmer la location</button>
                  <button class="btn btn-danger reject-btn" data-id="${r.id}">Refuser</button>
                </div>
              </div>
            `;
                })
                .join('')
            : `<p class="muted">Aucune demande en attente.</p>`
        }
      </div>
    `;

    content.querySelectorAll('.simple-approve-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const boxId = content.querySelector(`.simple-assign-box[data-id="${id}"]`).value;
        if (!(await showConfirm('Autoriser cette demande de coffre-fort maintenant ? Le client sera notifié et le loyer de la première semaine sera prélevé immédiatement.'))) return;
        try {
          await decideSafeRequestSimple(id, true, boxId || null, null);
          await draw();
        } catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });

    content.querySelectorAll('.claim-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const boxId = content.querySelector(`.assign-box[data-id="${id}"]`).value;
        const datetime = content.querySelector(`.assign-datetime[data-id="${id}"]`).value;
        const location = content.querySelector(`.assign-location[data-id="${id}"]`).value.trim();
        if (!boxId || !datetime) { await showAlert('Veuillez choisir un coffre et une date de rendez-vous.'); return; }
        try {
          await claimSafeRequest(id, boxId, new Date(datetime).toISOString(), location || null);
          await draw();
        } catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.confirm-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await confirmSafeRental(btn.getAttribute('data-id')); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.reject-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = await showPrompt('Motif du refus (optionnel) :') || null;
        try { await rejectSafeRequest(btn.getAttribute('data-id'), note); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

import { renderAdminShell } from './shell.js';
import { getSafeRequestsQueue, getAvailableSafeBoxesForAssignment, claimSafeRequest, confirmSafeRental, rejectSafeRequest, decideSafeRequestSimple, endSafeRental } from '../../lib/employeeApi.js';
import { getAllSafeBoxes, adminCreateSafeBox, adminUpdateSafeBox } from '../../lib/adminApi.js';
import { formatMoney, formatDate, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';

export async function renderAdminSafes(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'safes');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const [requests, availableBoxes, allBoxes] = await Promise.all([
      getSafeRequestsQueue().catch(() => []),
      getAvailableSafeBoxesForAssignment().catch(() => []),
      getAllSafeBoxes().catch(() => []),
    ]);
    const relevant = requests.filter((r) => r.status === 'pending' || r.status === 'processing');

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Coffres-forts à traiter</h1>
      <div class="card" style="margin-bottom:24px;">
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

      <h3 style="margin-bottom:12px;">Ajouter un coffre</h3>
      <div class="card" style="margin-bottom:24px;">
        <div class="grid" style="grid-template-columns: 1fr 1.5fr 1fr auto; gap:10px; align-items:end;">
          <div class="field" style="margin:0;">
            <label>Code</label>
            <input type="text" id="new-box-code" placeholder="Ex: CF-006" />
          </div>
          <div class="field" style="margin:0;">
            <label>Agence</label>
            <input type="text" id="new-box-branch" placeholder="Ex: Agence centrale — Los Santos" />
          </div>
          <div class="field" style="margin:0;">
            <label>Loyer hebdomadaire ($)</label>
            <input type="number" id="new-box-fee" min="0" step="0.01" />
          </div>
          <button id="new-box-submit" class="btn btn-primary">Créer</button>
        </div>
        <div id="new-box-error" class="text-danger" style="font-size:13px; margin-top:8px; display:none;"></div>
      </div>

      <h3 style="margin-bottom:12px;">Parc de coffres (${allBoxes.length})</h3>
      <div class="card">
        ${
          allBoxes.length
            ? `<table>
                <thead><tr><th>Code</th><th>Agence</th><th>Statut</th><th>Locataire</th><th>Prochain prélèvement</th><th style="text-align:right;">Loyer/semaine</th><th></th></tr></thead>
                <tbody>
                  ${allBoxes
                    .map((b) => {
                      const next = b.status === 'rented' && b.last_charged_at
                        ? new Date(new Date(b.last_charged_at).getTime() + 7 * 86400000)
                        : null;
                      return `
                    <tr>
                      <td style="font-weight:600;">${escapeHtml(b.code)}</td>
                      <td class="muted">
                        <input type="text" class="box-branch" data-id="${b.id}" value="${escapeHtml(b.branch || '')}" style="width:180px; padding:4px 8px; font-size:12px;" />
                      </td>
                      <td>${statusBadge(b.status)}</td>
                      <td class="muted">${escapeHtml(b.profiles?.display_name || '—')}</td>
                      <td class="muted">${next ? formatDate(next) : '—'}</td>
                      <td style="text-align:right;">
                        <input type="number" class="box-fee" data-id="${b.id}" value="${b.weekly_fee}" min="0" step="0.01" style="width:100px; padding:4px 8px; font-size:12px; text-align:right;" />
                      </td>
                      <td style="white-space:nowrap;">
                        <button class="btn btn-secondary box-save" data-id="${b.id}" style="padding:4px 10px; font-size:12px;">Enregistrer</button>
                        ${b.status === 'rented' ? `<button class="btn btn-danger end-rental" data-id="${b.id}" data-code="${escapeHtml(b.code)}" style="padding:4px 10px; font-size:12px; margin-left:6px;">Résilier</button>` : ''}
                        ${b.status === 'reserved' ? `<button class="btn btn-ghost box-free" data-id="${b.id}" style="padding:4px 10px; font-size:12px; margin-left:6px;">Libérer</button>` : ''}
                      </td>
                    </tr>
                  `;
                    })
                    .join('')}
                </tbody>
              </table>`
            : `<p class="muted">Aucun coffre enregistré.</p>`
        }
        <p class="muted" style="font-size:12px; margin:12px 0 0;">
          « Résilier » met fin à une location en cours : le prélèvement hebdomadaire s’arrête, le client est notifié et le coffre
          redevient disponible. « Libérer » annule une réservation restée en attente après un rendez-vous non honoré.
        </p>
      </div>
    `;

    content.querySelectorAll('.end-rental').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const code = btn.getAttribute('data-code');
        if (!(await showConfirm(`Résilier la location du coffre ${code} ? Le prélèvement hebdomadaire cessera immédiatement et le client sera notifié.`))) return;
        const note = await showPrompt('Motif communiqué au client (optionnel) :');
        btn.disabled = true;
        try {
          await endSafeRental(btn.getAttribute('data-id'), note || null);
          await draw();
        } catch (err) {
          await showAlert(err.message || 'Erreur lors de la résiliation.');
          btn.disabled = false;
        }
      });
    });

    content.querySelectorAll('.box-free').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!(await showConfirm('Remettre ce coffre en disponibilité ?'))) return;
        btn.disabled = true;
        try {
          await adminUpdateSafeBox(btn.getAttribute('data-id'), { status: 'available' });
          await draw();
        } catch (err) {
          await showAlert(err.message || 'Erreur.');
          btn.disabled = false;
        }
      });
    });

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

    document.getElementById('new-box-submit').addEventListener('click', async () => {
      const errorEl = document.getElementById('new-box-error');
      errorEl.style.display = 'none';
      const code = document.getElementById('new-box-code').value.trim();
      const branch = document.getElementById('new-box-branch').value.trim();
      const fee = parseFloat(document.getElementById('new-box-fee').value);
      if (!code || isNaN(fee) || fee < 0) {
        errorEl.textContent = 'Veuillez renseigner un code et un loyer hebdomadaire valide.';
        errorEl.style.display = 'block';
        return;
      }
      try {
        await adminCreateSafeBox({ code, branch: branch || null, weeklyFee: fee });
        await draw();
      } catch (err) {
        errorEl.textContent = err.message || 'Erreur lors de la création.';
        errorEl.style.display = 'block';
      }
    });

    content.querySelectorAll('.box-save').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const fee = parseFloat(content.querySelector(`.box-fee[data-id="${id}"]`).value);
        const branch = content.querySelector(`.box-branch[data-id="${id}"]`).value.trim();
        if (isNaN(fee) || fee < 0) { await showAlert('Loyer hebdomadaire invalide.'); return; }
        try { await adminUpdateSafeBox(id, { weeklyFee: fee, branch: branch || null }); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

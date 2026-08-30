// ============================================================================
// NEWPAD — File des demandes de consulting premium, partagée par les
// interfaces Employé et Admin.
// ============================================================================
// Les deux écrans étaient jusqu'ici deux copies littérales du même bloc, à la
// coquille près : toute correction devait être faite deux fois, et l'une des
// deux finissait par diverger. Un seul rendu ici, appelé par les deux pages.
// ============================================================================

import {
  getConsultingQueue,
  assignConsultingRequest,
  rejectConsultingRequest,
  closeConsultingRequest,
} from '../../lib/employeeApi.js';
import { formatDateTime, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';
import { loadAll, loadErrorBanner } from '../../lib/loadState.js';

const STATUS_LABELS = { pending: 'En attente', assigned: 'Assigné', closed: 'Clôturé', rejected: 'Refusé' };
const STATUS_BADGE = { pending: 'badge-pending', assigned: 'badge-success', rejected: 'badge-danger', closed: 'badge-neutral' };

export async function renderConsultingQueue(content, profile) {
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const { data, errors } = await loadAll({ requests: getConsultingQueue() });
    const requests = data.requests;
    const enCours = requests.filter((r) => r.status === 'pending' || r.status === 'assigned');
    const traitees = requests.filter((r) => r.status === 'rejected' || r.status === 'closed').slice(0, 20);

    const card = (r, actions) => `
      <div style="padding:14px 0; border-bottom:1px solid var(--card-border);">
        <div class="flex justify-between items-center" style="margin-bottom:6px;">
          <div>
            <div style="font-weight:600;">${escapeHtml(r.profiles?.display_name || '')}</div>
            <div class="muted" style="font-size:12px;">${formatDateTime(r.created_at)}</div>
          </div>
          <span class="badge ${STATUS_BADGE[r.status] || 'badge-neutral'}">${STATUS_LABELS[r.status] || r.status}</span>
        </div>
        <div style="font-size:14px; margin-bottom:10px; white-space:pre-wrap;">${escapeHtml(r.message || '')}</div>
        ${r.decision_note ? `<div class="muted" style="font-size:12px; margin-bottom:8px;">Note : ${escapeHtml(r.decision_note)}</div>` : ''}
        ${actions}
      </div>
    `;

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Consulting Premium</h1>
      <p class="muted" style="margin-bottom:20px; font-size:13px;">
        « Clôturer » termine un accompagnement mené à son terme ; « Refuser » indique au client que sa demande n’est pas retenue.
        Les deux sortent la demande de la file, mais le client ne lit pas la même chose.
      </p>
      ${loadErrorBanner(errors)}

      <h3 style="margin-bottom:12px;">À traiter (${enCours.length})</h3>
      <div class="card" style="margin-bottom:24px;">
        ${
          enCours.length
            ? enCours
                .map((r) => {
                  if (r.status === 'pending') {
                    return card(
                      r,
                      `<div class="flex gap-sm">
                         <button class="btn btn-secondary assign-btn" data-id="${r.id}">Prendre en charge</button>
                         <button class="btn btn-danger reject-btn" data-id="${r.id}">Refuser</button>
                       </div>`
                    );
                  }
                  const mine = r.assigned_advisor_id === profile.id;
                  return card(
                    r,
                    `<div class="flex gap-sm items-center" style="flex-wrap:wrap;">
                       <span class="muted" style="font-size:12px;">${mine ? 'Assigné à vous' : 'Assigné à un autre conseiller'}</span>
                       <button class="btn btn-primary close-btn" data-id="${r.id}">Clôturer</button>
                       <button class="btn btn-danger reject-btn" data-id="${r.id}">Refuser</button>
                     </div>`
                  );
                })
                .join('')
            : `<p class="muted">Aucune demande en attente.</p>`
        }
      </div>

      <h3 style="margin-bottom:12px;">Historique</h3>
      <div class="card">
        ${traitees.length ? traitees.map((r) => card(r, '')).join('') : `<p class="muted">Aucune demande traitée.</p>`}
      </div>
    `;

    content.querySelectorAll('.assign-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try { await assignConsultingRequest(btn.getAttribute('data-id'), profile.id); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); btn.disabled = false; }
      });
    });

    content.querySelectorAll('.close-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!(await showConfirm('Clôturer cet accompagnement ? Le client sera informé qu’il est arrivé à son terme.'))) return;
        const note = (await showPrompt('Mot de conclusion pour le client (optionnel) :')) || null;
        btn.disabled = true;
        try { await closeConsultingRequest(btn.getAttribute('data-id'), note); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); btn.disabled = false; }
      });
    });

    content.querySelectorAll('.reject-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!(await showConfirm('Refuser cette demande de consulting ? Le client lira « Demande refusée ».'))) return;
        const note = (await showPrompt('Motif du refus (optionnel) :')) || null;
        btn.disabled = true;
        try { await rejectConsultingRequest(btn.getAttribute('data-id'), note); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); btn.disabled = false; }
      });
    });
  }

  await draw();
}

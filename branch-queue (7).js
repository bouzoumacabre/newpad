import { renderEmployeeShell } from './shell.js';
import { getBranchQueue, addToBranchQueue, updateBranchQueueStatus } from '../../lib/employeeApi.js';
import { formatDateTime, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';

const STATUS_LABELS = { waiting: 'En attente', in_service: 'En cours', done: 'Terminé', cancelled: 'Annulé' };

export async function renderEmployeeBranchQueue(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'branch-queue');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const queue = await getBranchQueue().catch(() => []);
    const waiting = queue.filter((q) => q.status === 'waiting');
    const inService = queue.filter((q) => q.status === 'in_service');
    const done = queue.filter((q) => q.status === 'done' || q.status === 'cancelled').slice(0, 10);

    function row(q, actions) {
      return `
        <div style="padding:12px 0; border-bottom:1px solid var(--card-border);" class="flex justify-between items-center">
          <div>
            <div style="font-weight:600;">${escapeHtml(q.profiles?.display_name || q.visitor_name || 'Visiteur')}</div>
            <div class="muted" style="font-size:12px;">${escapeHtml(q.reason || 'Motif non précisé')} — arrivé à ${formatDateTime(q.joined_at)}</div>
          </div>
          <div class="flex gap-sm">${actions}</div>
        </div>
      `;
    }

    content.innerHTML = `
      <div class="flex justify-between items-center" style="margin-bottom:20px;">
        <h1 style="margin:0;">File d'attente</h1>
        <button id="add-visitor" class="btn btn-primary">Ajouter un visiteur</button>
      </div>

      <div id="add-form" class="card" style="margin-bottom:20px; display:none;">
        <div class="field"><label>Nom</label><input type="text" id="visitor-name" /></div>
        <div class="field"><label>Motif</label><input type="text" id="visitor-reason" placeholder="Ex: ouverture de compte, virement..." /></div>
        <button id="add-submit" class="btn btn-primary">Ajouter à la file</button>
      </div>

      <div class="grid" style="grid-template-columns: 1fr 1fr; align-items:start; margin-bottom:20px;">
        <div class="card">
          <h3 style="margin-bottom:8px;">En attente (${waiting.length})</h3>
          ${waiting.length ? waiting.map((q) => row(q, `<button class="btn btn-secondary call-btn" data-id="${q.id}" style="padding:6px 12px; font-size:13px;">Appeler</button>`)).join('') : `<p class="muted">Personne en attente.</p>`}
        </div>
        <div class="card">
          <h3 style="margin-bottom:8px;">En cours (${inService.length})</h3>
          ${
            inService.length
              ? inService
                  .map((q) =>
                    row(
                      q,
                      `<button class="btn btn-primary done-btn" data-id="${q.id}" style="padding:6px 12px; font-size:13px;">Terminer</button>
                     <button class="btn btn-ghost cancel-btn" data-id="${q.id}" style="padding:6px 12px; font-size:13px; color:var(--status-danger);">Annuler</button>`
                    )
                  )
                  .join('')
              : `<p class="muted">Personne en cours de service.</p>`
          }
        </div>
      </div>

      <div class="card">
        <h3 style="margin-bottom:8px;">Historique récent</h3>
        ${done.length ? done.map((q) => `<div class="muted" style="font-size:13px; padding:6px 0;">${escapeHtml(q.profiles?.display_name || q.visitor_name || 'Visiteur')} — ${STATUS_LABELS[q.status]}</div>`).join('') : `<p class="muted">Aucun historique.</p>`}
      </div>
    `;

    document.getElementById('add-visitor').addEventListener('click', () => {
      const form = document.getElementById('add-form');
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
    });
    document.getElementById('add-submit').addEventListener('click', async () => {
      const visitorName = document.getElementById('visitor-name').value.trim();
      const reason = document.getElementById('visitor-reason').value.trim();
      if (!visitorName) return;
      try { await addToBranchQueue({ visitorName, reason }); await draw(); }
      catch (err) { await showAlert(err.message || 'Erreur.'); }
    });

    content.querySelectorAll('.call-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await updateBranchQueueStatus(btn.getAttribute('data-id'), 'in_service'); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.done-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await updateBranchQueueStatus(btn.getAttribute('data-id'), 'done'); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.cancel-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await updateBranchQueueStatus(btn.getAttribute('data-id'), 'cancelled'); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

// ============================================================================
// NEWPAD — Écran support côté personnel, partagé par les interfaces Employé
// et Admin (liste des tickets + fil de discussion).
// ============================================================================
// Les deux écrans étaient deux copies littérales, à la coquille et au préfixe
// de route près. Un seul rendu ici, paramétré par `basePath`.
// ============================================================================

import {
  getAllSupportTickets,
  getSupportMessages,
  postSupportMessage,
  resolveSupportTicket,
  claimSupportTicket,
} from '../../lib/employeeApi.js';
import { formatDateTime, escapeHtml } from '../../lib/format.js';
import { navigate } from '../../lib/router.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { loadAll, loadErrorBanner } from '../../lib/loadState.js';

const STATUS_LABELS = { open: 'Ouvert', in_progress: 'En cours', resolved: 'Résolu' };
const STATUS_BADGE = { open: 'badge-pending', in_progress: 'badge-pending', resolved: 'badge-success' };

// « Ouvert » ne veut plus dire la même chose que « En cours » depuis la
// migration 0030 : le premier signale un ticket que personne n'a encore pris,
// le second un ticket déjà entre les mains d'un collègue. Auparavant aucune
// fonction ne posait jamais `in_progress` — tout restait « Ouvert » jusqu'à la
// résolution, et deux employés pouvaient répondre au même ticket sans le voir.
function assignmentLabel(ticket, profileId) {
  if (!ticket?.assigned_to) return 'Non pris en charge';
  return ticket.assigned_to === profileId ? 'Pris en charge par vous' : 'Pris en charge par un collègue';
}

export async function renderStaffSupportScreen(content, profile, basePath, ticketId) {
  content.innerHTML = `<p class="muted">Chargement…</p>`;
  if (ticketId) await drawThread(content, profile, basePath, ticketId);
  else await drawList(content, profile, basePath);
}

async function drawList(content, profile, basePath) {
  async function draw() {
    const { data, errors } = await loadAll({ tickets: getAllSupportTickets() });
    const tickets = data.tickets;
    const ouverts = tickets.filter((t) => t.status !== 'resolved');
    const resolus = tickets.filter((t) => t.status === 'resolved').slice(0, 30);

    const table = (rows) => `
      <table>
        <thead><tr><th>Client</th><th>Sujet</th><th>Catégorie</th><th>Statut</th><th>Prise en charge</th><th>Dernière activité</th></tr></thead>
        <tbody>
          ${rows
            .map(
              (t) => `
            <tr class="ticket-row" data-id="${t.id}" style="cursor:pointer;">
              <td>${escapeHtml(t.profiles?.display_name || '')}</td>
              <td style="font-weight:600;">${escapeHtml(t.subject)}</td>
              <td class="muted">${escapeHtml(t.category || '—')}</td>
              <td><span class="badge ${STATUS_BADGE[t.status] || 'badge-neutral'}">${STATUS_LABELS[t.status] || t.status}</span></td>
              <td class="muted">${escapeHtml(assignmentLabel(t, profile.id))}</td>
              <td class="muted">${formatDateTime(t.updated_at)}</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>`;

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Support — tous les tickets</h1>
      ${loadErrorBanner(errors)}

      <h3 style="margin-bottom:12px;">En cours (${ouverts.length})</h3>
      <div class="card" style="margin-bottom:24px;">
        ${ouverts.length ? table(ouverts) : `<p class="muted">Aucun ticket ouvert.</p>`}
      </div>

      <h3 style="margin-bottom:12px;">Résolus</h3>
      <div class="card">
        ${resolus.length ? table(resolus) : `<p class="muted">Aucun ticket résolu.</p>`}
      </div>
    `;

    content.querySelectorAll('.ticket-row').forEach((row) => {
      row.addEventListener('click', () => navigate(`${basePath}/${row.getAttribute('data-id')}`));
    });
  }
  await draw();
}

async function drawThread(content, profile, basePath, ticketId) {
  async function draw() {
    const [tickets, messages] = await Promise.all([
      getAllSupportTickets().catch(() => []),
      getSupportMessages(ticketId).catch(() => []),
    ]);
    const ticket = tickets.find((t) => t.id === ticketId);

    if (!ticket) {
      content.innerHTML = `
        <a href="#${basePath}" style="display:inline-block; margin-bottom:16px;">← Retour aux tickets</a>
        <p class="muted">Ce ticket est introuvable.</p>
      `;
      return;
    }

    const canClaim = ticket.status !== 'resolved' && ticket.assigned_to !== profile.id;

    content.innerHTML = `
      <a href="#${basePath}" style="display:inline-block; margin-bottom:16px;">← Retour aux tickets</a>
      <div class="card">
        <div class="flex justify-between items-center" style="margin-bottom:20px; flex-wrap:wrap; gap:10px;">
          <div>
            <h2 style="margin:0 0 4px;">${escapeHtml(ticket.subject)}</h2>
            <span class="muted" style="font-size:13px;">
              ${escapeHtml(ticket.profiles?.display_name || '')}
              ${ticket.category ? ' — ' + escapeHtml(ticket.category) : ''}
              — ${escapeHtml(assignmentLabel(ticket, profile.id))}
            </span>
          </div>
          <div class="flex gap-sm items-center">
            <span class="badge ${STATUS_BADGE[ticket.status] || 'badge-neutral'}">${STATUS_LABELS[ticket.status] || ticket.status}</span>
            ${canClaim ? `<button id="claim-btn" class="btn btn-secondary" style="padding:6px 12px; font-size:13px;">Prendre en charge</button>` : ''}
            ${ticket.status !== 'resolved' ? `<button id="resolve-btn" class="btn btn-primary" style="padding:6px 12px; font-size:13px;">Résoudre</button>` : ''}
          </div>
        </div>
        <div id="thread-messages" style="max-height:420px; overflow-y:auto; margin-bottom:20px;">
          ${
            messages.length
              ? messages
                  .map(
                    (m) => `
              <div style="padding:10px 14px; margin-bottom:8px; border-radius: var(--radius-sm); background: ${m.author_role !== 'client' ? 'rgba(201,162,39,0.08)' : 'rgba(255,255,255,0.03)'}; ${m.author_role !== 'client' ? 'margin-left:15%;' : 'margin-right:15%;'}">
                <div class="muted" style="font-size:11px; margin-bottom:4px;">${m.author_role === 'client' ? escapeHtml(ticket.profiles?.display_name || 'Client') : 'Personnel'} — ${formatDateTime(m.created_at)}</div>
                <div style="font-size:14px; white-space:pre-wrap;">${escapeHtml(m.body)}</div>
              </div>
            `
                  )
                  .join('')
              : `<p class="muted">Aucun message.</p>`
          }
        </div>
        <div class="flex gap-sm">
          <input type="text" id="reply-input" placeholder="Écrire un message..." style="flex:1;" />
          <button id="reply-submit" class="btn btn-primary">Envoyer</button>
        </div>
        ${
          ticket.status === 'resolved'
            ? `<p class="muted" style="font-size:12px; margin:10px 0 0;">Ce ticket est résolu — y répondre le rouvrira.</p>`
            : ''
        }
      </div>
    `;

    const msgContainer = document.getElementById('thread-messages');
    if (msgContainer) msgContainer.scrollTop = msgContainer.scrollHeight;

    document.getElementById('reply-submit')?.addEventListener('click', async () => {
      const input = document.getElementById('reply-input');
      const body = input.value.trim();
      if (!body) return;
      try { await postSupportMessage(ticketId, body); input.value = ''; await draw(); }
      catch (err) { await showAlert(err.message || "Erreur lors de l'envoi."); }
    });

    document.getElementById('reply-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('reply-submit').click(); }
    });

    document.getElementById('claim-btn')?.addEventListener('click', async () => {
      try { await claimSupportTicket(ticketId); await draw(); }
      catch (err) { await showAlert(err.message || 'Erreur.'); }
    });

    document.getElementById('resolve-btn')?.addEventListener('click', async () => {
      if (!(await showConfirm('Marquer ce ticket comme résolu ? Le client en sera informé et pourra le rouvrir en répondant.'))) return;
      try { await resolveSupportTicket(ticketId); await draw(); }
      catch (err) { await showAlert(err.message || 'Erreur.'); }
    });
  }
  await draw();
}

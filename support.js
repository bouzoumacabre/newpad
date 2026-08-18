import { renderAdminShell } from './shell.js';
import { getAllSupportTickets, getSupportMessages, postSupportMessage, resolveSupportTicket } from '../../lib/employeeApi.js';
import { formatDateTime, escapeHtml } from '../../lib/format.js';
import { navigate } from '../../lib/router.js';

const STATUS_LABELS = { open: 'Ouvert', in_progress: 'En cours', resolved: 'Résolu' };
const STATUS_BADGE = { open: 'badge-pending', in_progress: 'badge-pending', resolved: 'badge-success' };

export async function renderAdminSupport(app, profile, params = {}) {
  const { content } = await renderAdminShell(app, profile, 'support');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  if (params.id) await drawThread(content, params.id);
  else await drawList(content);
}

async function drawList(content) {
  async function draw() {
    const tickets = await getAllSupportTickets().catch(() => []);

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Support — tous les tickets</h1>
      <div class="card">
        ${
          tickets.length
            ? `<table>
                <thead><tr><th>Client</th><th>Sujet</th><th>Catégorie</th><th>Statut</th><th>Dernière activité</th></tr></thead>
                <tbody>
                  ${tickets
                    .map(
                      (t) => `
                    <tr class="ticket-row" data-id="${t.id}" style="cursor:pointer;">
                      <td>${escapeHtml(t.profiles?.display_name || '')}</td>
                      <td style="font-weight:600;">${escapeHtml(t.subject)}</td>
                      <td class="muted">${escapeHtml(t.category || '—')}</td>
                      <td><span class="badge ${STATUS_BADGE[t.status]}">${STATUS_LABELS[t.status]}</span></td>
                      <td class="muted">${formatDateTime(t.updated_at)}</td>
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>`
            : `<p class="muted">Aucun ticket.</p>`
        }
      </div>
    `;

    content.querySelectorAll('.ticket-row').forEach((row) => {
      row.addEventListener('click', () => navigate(`/admin/support/${row.getAttribute('data-id')}`));
    });
  }
  await draw();
}

async function drawThread(content, ticketId) {
  async function draw() {
    const [tickets, messages] = await Promise.all([
      getAllSupportTickets().catch(() => []),
      getSupportMessages(ticketId).catch(() => []),
    ]);
    const ticket = tickets.find((t) => t.id === ticketId);

    content.innerHTML = `
      <a href="#/admin/support" style="display:inline-block; margin-bottom:16px;">← Retour aux tickets</a>
      <div class="card">
        <div class="flex justify-between items-center" style="margin-bottom:20px;">
          <div>
            <h2 style="margin:0 0 4px;">${escapeHtml(ticket?.subject || 'Ticket')}</h2>
            <span class="muted" style="font-size:13px;">${escapeHtml(ticket?.profiles?.display_name || '')}</span>
          </div>
          <div class="flex gap-sm items-center">
            <span class="badge ${STATUS_BADGE[ticket?.status]}">${STATUS_LABELS[ticket?.status]}</span>
            ${ticket?.status !== 'resolved' ? `<button id="resolve-btn" class="btn btn-secondary" style="padding:6px 12px; font-size:13px;">Résoudre</button>` : ''}
          </div>
        </div>
        <div id="thread-messages" style="max-height:420px; overflow-y:auto; margin-bottom:20px;">
          ${
            messages.length
              ? messages
                  .map(
                    (m) => `
              <div style="padding:10px 14px; margin-bottom:8px; border-radius: var(--radius-sm); background: ${m.author_role !== 'client' ? 'rgba(201,162,39,0.08)' : 'rgba(255,255,255,0.03)'}; ${m.author_role !== 'client' ? 'margin-left:15%;' : 'margin-right:15%;'}">
                <div class="muted" style="font-size:11px; margin-bottom:4px;">${m.author_role === 'client' ? escapeHtml(ticket?.profiles?.display_name || 'Client') : 'Personnel'} — ${formatDateTime(m.created_at)}</div>
                <div style="font-size:14px;">${escapeHtml(m.body)}</div>
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
      </div>
    `;

    document.getElementById('reply-submit').addEventListener('click', async () => {
      const input = document.getElementById('reply-input');
      const body = input.value.trim();
      if (!body) return;
      try { await postSupportMessage(ticketId, body); input.value = ''; await draw(); }
      catch (err) { alert(err.message || "Erreur lors de l'envoi."); }
    });

    document.getElementById('resolve-btn')?.addEventListener('click', async () => {
      try { await resolveSupportTicket(ticketId); await draw(); }
      catch (err) { alert(err.message || 'Erreur.'); }
    });
  }
  await draw();
}

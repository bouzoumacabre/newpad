import { renderClientShell } from './shell.js';
import { getMySupportTickets, getSupportMessages, createSupportTicket, postSupportMessage } from '../../lib/clientApi.js';
import { formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';
import { navigate } from '../../lib/router.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';

const CATEGORIES = ['Compte', 'Virement', 'Lingots & marché', 'Coffre-fort', 'Prêt', 'Autre'];

export async function renderClientSupport(app, profile, params = {}) {
  const { content } = await renderClientShell(app, profile, 'support');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  if (params.id) {
    await drawThread(content, params.id);
  } else {
    await drawList(content);
  }
}

async function drawList(content) {
  async function draw() {
    const tickets = await getMySupportTickets().catch(() => []);

    content.innerHTML = `
      <div class="flex justify-between items-center" style="margin-bottom:20px;">
        <h1 style="margin:0;">Support</h1>
        <button id="new-ticket" class="btn btn-primary">Nouveau ticket</button>
      </div>

      <div id="new-ticket-form" class="card" style="margin-bottom:20px; display:none;">
        <h3 style="margin-bottom:16px;">Nouveau ticket</h3>
        <div class="field">
          <label>Sujet</label>
          <input type="text" id="ticket-subject" placeholder="Résumez votre demande" />
        </div>
        <div class="field">
          <label>Catégorie</label>
          <select id="ticket-category">
            ${CATEGORIES.map((c) => `<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>Message</label>
          <textarea id="ticket-message" rows="4" placeholder="Décrivez votre demande en détail..."></textarea>
        </div>
        <div id="ticket-error" class="text-danger" style="font-size:13px; margin-bottom:12px; display:none;"></div>
        <button id="ticket-submit" class="btn btn-primary">Envoyer</button>
      </div>

      <div class="card">
        ${
          tickets.length
            ? `<table>
                <thead><tr><th>Sujet</th><th>Catégorie</th><th>Statut</th><th>Dernière activité</th></tr></thead>
                <tbody>
                  ${tickets
                    .map(
                      (t) => `
                    <tr class="ticket-row" data-id="${t.id}" style="cursor:pointer;">
                      <td style="font-weight:600;">${escapeHtml(t.subject)}</td>
                      <td class="muted">${escapeHtml(t.category || '—')}</td>
                      <td>${statusBadge(t.status)}</td>
                      <td class="muted">${formatDateTime(t.updated_at)}</td>
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>`
            : `<p class="muted">Aucun ticket pour l'instant.</p>`
        }
      </div>
    `;

    document.getElementById('new-ticket').addEventListener('click', () => {
      const form = document.getElementById('new-ticket-form');
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
    });

    document.getElementById('ticket-submit').addEventListener('click', async () => {
      const errorEl = document.getElementById('ticket-error');
      errorEl.style.display = 'none';
      const subject = document.getElementById('ticket-subject').value.trim();
      const category = document.getElementById('ticket-category').value;
      const message = document.getElementById('ticket-message').value.trim();
      if (!subject || !message) {
        errorEl.textContent = 'Veuillez renseigner un sujet et un message.';
        errorEl.style.display = 'block';
        return;
      }
      try {
        const ticketId = await createSupportTicket({ subject, category, firstMessage: message });
        navigate(`/client/support/${ticketId}`);
      } catch (err) {
        errorEl.textContent = err.message || 'Erreur lors de la création du ticket.';
        errorEl.style.display = 'block';
      }
    });

    content.querySelectorAll('.ticket-row').forEach((row) => {
      row.addEventListener('click', () => navigate(`/client/support/${row.getAttribute('data-id')}`));
    });
  }

  await draw();
}

async function drawThread(content, ticketId) {
  async function draw() {
    const [tickets, messages] = await Promise.all([
      getMySupportTickets().catch(() => []),
      getSupportMessages(ticketId).catch(() => []),
    ]);
    const ticket = tickets.find((t) => t.id === ticketId);

    content.innerHTML = `
      <a href="#/client/support" style="display:inline-block; margin-bottom:16px;">← Retour aux tickets</a>
      <div class="card">
        <div class="flex justify-between items-center" style="margin-bottom:20px;">
          <h2 style="margin:0;">${escapeHtml(ticket?.subject || 'Ticket')}</h2>
          ${ticket ? statusBadge(ticket.status) : ''}
        </div>
        <div id="thread-messages" style="max-height:420px; overflow-y:auto; margin-bottom:20px;">
          ${
            messages.length
              ? messages
                  .map(
                    (m) => `
              <div style="padding:10px 14px; margin-bottom:8px; border-radius: var(--radius-sm); background: ${m.author_role === 'client' ? 'rgba(201,162,39,0.08)' : 'rgba(255,255,255,0.03)'}; ${m.author_role === 'client' ? 'margin-left:15%;' : 'margin-right:15%;'}">
                <div class="muted" style="font-size:11px; margin-bottom:4px;">${m.author_role === 'client' ? 'Vous' : 'Newman Bank'} — ${formatDateTime(m.created_at)}</div>
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
      try {
        await postSupportMessage(ticketId, body);
        input.value = '';
        await draw();
      } catch (err) {
        await showAlert(err.message || "Erreur lors de l'envoi du message.");
      }
    });
  }

  await draw();
}

// ============================================================================
// NEWPAD — Écran de messagerie inter-rôles, partagé par les 4 interfaces
// internes (Client/Employé/Admin/IRS). Chaque page de rôle appelle
// renderMessagesScreen() après avoir affiché sa propre coquille.
// Les clients ne peuvent pas contacter d'autres clients — appliqué et
// re-vérifié côté serveur (create_message_thread), mais on filtre déjà la
// liste de contacts ici pour ne pas les proposer inutilement.
// ============================================================================

import {
  listMessageableContacts,
  listMyThreads,
  getThreadMessages,
  createMessageThread,
  sendThreadMessage,
  markThreadRead,
  closeMessageThread,
  subscribeToThreadMessages,
} from '../../lib/messagingApi.js';
import { formatDateTime, escapeHtml } from '../../lib/format.js';
import { navigate } from '../../lib/router.js';

const ROLE_LABELS = { client: 'Client', employee: 'Employé', admin: 'Admin', irs: 'IRS' };

// Les contacts arrivent déjà triés par rôle (list_messageable_contacts ORDER
// BY role, display_name) — on les regroupe simplement en groupes contigus
// pour l'affichage en <optgroup>, ce qui permet de choisir explicitement un
// destinataire précis par rôle (ex: un employé en particulier plutôt qu'un
// admin) plutôt qu'une liste plate mélangeant tout le monde.
function groupContactsByRole(contacts) {
  const groups = [];
  for (const c of contacts) {
    const last = groups[groups.length - 1];
    if (last && last.role === c.role) last.items.push(c);
    else groups.push({ role: c.role, items: [c] });
  }
  return groups;
}

/**
 * @param {HTMLElement} content - conteneur retourné par renderXxxShell()
 * @param {object} profile - profil de l'utilisateur connecté
 * @param {string} basePath - ex: '/client/messages'
 * @param {string} [threadId] - si présent, ouvre directement ce fil
 */
export async function renderMessagesScreen(content, profile, basePath, threadId) {
  if (threadId) await drawThread(content, profile, basePath, threadId);
  else await drawList(content, profile, basePath);
}

async function drawList(content, profile, basePath) {
  content.innerHTML = `<p class="muted">Chargement…</p>`;
  const threads = await listMyThreads().catch(() => []);

  content.innerHTML = `
    <div class="flex justify-between items-center" style="margin-bottom:20px;">
      <h1 style="margin:0;">Messagerie</h1>
      <button id="new-thread-btn" class="btn btn-primary">+ Nouveau message</button>
    </div>
    <div class="card">
      ${
        threads.length
          ? `<table>
              <thead><tr><th>Contact</th><th>Rôle</th><th>Sujet</th><th>Statut</th><th>Dernière activité</th></tr></thead>
              <tbody>
                ${threads
                  .map(
                    (t) => `
                  <tr class="thread-row" data-id="${t.id}" style="cursor:pointer; ${t.unread ? 'font-weight:600;' : ''}">
                    <td>${t.unread ? '● ' : ''}${escapeHtml(t.other_display_name || '')}</td>
                    <td class="muted">${ROLE_LABELS[t.other_role] || t.other_role}</td>
                    <td>${escapeHtml(t.subject)}</td>
                    <td><span class="badge ${t.status === 'closed' ? 'badge-neutral' : 'badge-pending'}">${t.status === 'closed' ? 'Clôturé' : 'Ouvert'}</span></td>
                    <td class="muted">${formatDateTime(t.last_message_at)}</td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>`
          : `<p class="muted">Aucune conversation pour le moment.</p>`
      }
    </div>
  `;

  content.querySelectorAll('.thread-row').forEach((row) => {
    row.addEventListener('click', () => navigate(`${basePath}/${row.getAttribute('data-id')}`));
  });

  document.getElementById('new-thread-btn').addEventListener('click', () => openNewThreadModal(profile, basePath));
}

async function openNewThreadModal(profile, basePath) {
  const contacts = await listMessageableContacts().catch(() => []);
  if (!contacts.length) {
    alert('Aucun contact disponible pour le moment.');
    return;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-card card" style="max-width:480px;">
      <h3 style="margin-top:0;">Nouveau message</h3>
      <div class="field">
        <label for="msg-recipient">Destinataire</label>
        <select id="msg-recipient">
          ${groupContactsByRole(contacts)
            .map(
              (group) => `
            <optgroup label="${ROLE_LABELS[group.role] || group.role}">
              ${group.items
                .map(
                  (c) =>
                    `<option value="${c.id}">${escapeHtml(c.display_name)}${c.employee_title ? ' (' + escapeHtml(c.employee_title) + ')' : ''}</option>`
                )
                .join('')}
            </optgroup>
          `
            )
            .join('')}
        </select>
        <div class="muted" style="font-size:12px; margin-top:4px;">
          Choisissez précisément à qui envoyer ce message — un employé, un admin, un membre de l'IRS ou un client, selon votre rôle.
        </div>
      </div>
      <div class="field">
        <label for="msg-subject">Sujet</label>
        <input type="text" id="msg-subject" placeholder="Objet du message" />
      </div>
      <div class="field">
        <label for="msg-body">Message</label>
        <textarea id="msg-body" rows="4" placeholder="Votre message..."></textarea>
      </div>
      <div id="msg-error" class="text-danger" style="display:none; margin-bottom:12px; font-size:13px;"></div>
      <div class="flex justify-end gap-sm">
        <button id="msg-cancel" class="btn btn-ghost">Annuler</button>
        <button id="msg-send" class="btn btn-primary">Envoyer</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.getElementById('msg-cancel').addEventListener('click', close);

  document.getElementById('msg-send').addEventListener('click', async () => {
    const recipientId = document.getElementById('msg-recipient').value;
    const subject = document.getElementById('msg-subject').value.trim();
    const body = document.getElementById('msg-body').value.trim();
    const errorEl = document.getElementById('msg-error');
    errorEl.style.display = 'none';
    if (!subject || !body) {
      errorEl.textContent = 'Le sujet et le message sont requis.';
      errorEl.style.display = 'block';
      return;
    }
    try {
      const threadId = await createMessageThread(recipientId, subject, body);
      close();
      navigate(`${basePath}/${threadId}`);
    } catch (err) {
      errorEl.textContent = err.message || "Erreur lors de l'envoi.";
      errorEl.style.display = 'block';
    }
  });
}

async function drawThread(content, profile, basePath, threadId) {
  let unsubscribe = null;

  async function draw() {
    const [threads, messages] = await Promise.all([
      listMyThreads().catch(() => []),
      getThreadMessages(threadId).catch(() => []),
    ]);
    const thread = threads.find((t) => t.id === threadId);

    if (!thread) {
      content.innerHTML = `
        <a href="#${basePath}" style="display:inline-block; margin-bottom:16px;">← Retour à la messagerie</a>
        <p class="muted">Cette conversation est introuvable ou vous n'y avez pas accès.</p>
      `;
      return;
    }

    try { await markThreadRead(threadId); } catch (_) {}

    content.innerHTML = `
      <a href="#${basePath}" style="display:inline-block; margin-bottom:16px;">← Retour à la messagerie</a>
      <div class="card">
        <div class="flex justify-between items-center" style="margin-bottom:20px;">
          <div>
            <h2 style="margin:0 0 4px;">${escapeHtml(thread.subject)}</h2>
            <span class="muted" style="font-size:13px;">${escapeHtml(thread.other_display_name || '')} — ${ROLE_LABELS[thread.other_role] || thread.other_role}</span>
          </div>
          <div class="flex gap-sm items-center">
            <span class="badge ${thread.status === 'closed' ? 'badge-neutral' : 'badge-pending'}">${thread.status === 'closed' ? 'Clôturé' : 'Ouvert'}</span>
            ${thread.status !== 'closed' ? `<button id="close-thread-btn" class="btn btn-secondary" style="padding:6px 12px; font-size:13px;">Clôturer</button>` : ''}
          </div>
        </div>
        <div id="thread-messages" style="max-height:420px; overflow-y:auto; margin-bottom:20px;">
          ${
            messages.length
              ? messages
                  .map(
                    (m) => `
              <div style="padding:10px 14px; margin-bottom:8px; border-radius: var(--radius-sm); background: ${m.author_id !== profile.id ? 'rgba(201,162,39,0.08)' : 'rgba(255,255,255,0.03)'}; ${m.author_id !== profile.id ? 'margin-left:15%;' : 'margin-right:15%;'}">
                <div class="muted" style="font-size:11px; margin-bottom:4px;">${m.author_id === profile.id ? 'Vous' : escapeHtml(thread.other_display_name || ROLE_LABELS[m.author_role] || m.author_role)} — ${formatDateTime(m.created_at)}</div>
                <div style="font-size:14px; white-space:pre-wrap;">${escapeHtml(m.body)}</div>
              </div>
            `
                  )
                  .join('')
              : `<p class="muted">Aucun message.</p>`
          }
        </div>
        ${
          thread.status !== 'closed'
            ? `
        <div class="flex gap-sm">
          <input type="text" id="reply-input" placeholder="Écrire un message..." style="flex:1;" />
          <button id="reply-submit" class="btn btn-primary">Envoyer</button>
        </div>`
            : `<p class="muted" style="margin:0;">Cette conversation est clôturée.</p>`
        }
      </div>
    `;

    const msgContainer = document.getElementById('thread-messages');
    if (msgContainer) msgContainer.scrollTop = msgContainer.scrollHeight;

    document.getElementById('reply-submit')?.addEventListener('click', async () => {
      const input = document.getElementById('reply-input');
      const body = input.value.trim();
      if (!body) return;
      try { await sendThreadMessage(threadId, body); input.value = ''; await draw(); }
      catch (err) { alert(err.message || "Erreur lors de l'envoi."); }
    });

    document.getElementById('reply-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('reply-submit').click(); }
    });

    document.getElementById('close-thread-btn')?.addEventListener('click', async () => {
      try { await closeMessageThread(threadId); await draw(); }
      catch (err) { alert(err.message || 'Erreur.'); }
    });
  }

  await draw();
  unsubscribe = subscribeToThreadMessages(threadId, () => draw());
  // Nettoyage à la navigation suivante — évite les abonnements orphelins qui
  // continueraient à rafraîchir un écran quitté.
  window.addEventListener('hashchange', () => unsubscribe && unsubscribe(), { once: true });
}

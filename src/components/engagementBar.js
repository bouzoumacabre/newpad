// ============================================================================
// Barre d'engagement — composant partagé
// ============================================================================
// Réactions et commentaires, à l'identique dans toutes les applications à
// audience. Un visiteur sans compte voit les chiffres et les commentaires mais
// ne peut pas participer : il est invité à se connecter, pas bloqué en silence.

import { escapeHtml, formatDateTime } from '../lib/format.js';
import { showAlert } from '../lib/uiDialogs.js';
import { navigate } from '../lib/router.js';
import { react, postComment, deleteComment, listComments, contentStats } from '../lib/engagement.js';

export function engagementBarHtml(stats) {
  const s = stats || {};
  return `
    <div class="eng-bar">
      <button class="eng-btn ${s.ma_reaction ? 'is-on' : ''}" data-eng-like>
        ♥ <span data-eng-likes>${s.reactions || 0}</span>
      </button>
      <span class="eng-count">💬 <span data-eng-comments>${s.commentaires || 0}</span></span>
      <span class="eng-count eng-views">${s.vues || 0} vue${(s.vues || 0) > 1 ? 's' : ''}</span>
    </div>
    <div class="eng-comments" data-eng-list></div>
    <div data-eng-form></div>
  `;
}

/**
 * Branche la barre sur une entité.
 * @param {HTMLElement} hote   conteneur contenant le balisage ci-dessus
 * @param {object} profile     profil connecté, ou null en mode invité
 */
export function wireEngagement(hote, entityType, entityId, profile) {
  const bouton = hote.querySelector('[data-eng-like]');
  const nbLikes = hote.querySelector('[data-eng-likes]');
  const nbComs = hote.querySelector('[data-eng-comments]');
  const liste = hote.querySelector('[data-eng-list]');
  const zoneForm = hote.querySelector('[data-eng-form]');

  bouton?.addEventListener('click', async () => {
    if (!profile) {
      await showAlert('Connectez-vous pour réagir.');
      navigate('/login');
      return;
    }
    try {
      const pose = await react(entityType, entityId, 'like');
      bouton.classList.toggle('is-on', pose);
      nbLikes.textContent = Math.max(0, Number(nbLikes.textContent) + (pose ? 1 : -1));
    } catch (e) { await showAlert(String(e.message || e)); }
  });

  zoneForm.innerHTML = profile
    ? `<div class="eng-form">
         <input data-eng-input placeholder="Écrire un commentaire…" maxlength="2000" />
         <button class="btn btn-secondary" data-eng-send>Publier</button>
       </div>`
    : '<p class="muted" style="font-size:12.5px;">Connectez-vous pour commenter.</p>';

  zoneForm.querySelector('[data-eng-send]')?.addEventListener('click', async () => {
    const champ = zoneForm.querySelector('[data-eng-input]');
    const texte = champ.value.trim();
    if (!texte) return;
    try {
      await postComment(entityType, entityId, texte);
      champ.value = '';
      nbComs.textContent = Number(nbComs.textContent) + 1;
      await rafraichir();
    } catch (e) { await showAlert(String(e.message || e)); }
  });

  async function rafraichir() {
    let coms = [];
    try { coms = await listComments(entityType, entityId); } catch (_) { /* liste vide */ }
    liste.innerHTML = coms.map((c) => `
      <div class="eng-comment">
        <strong>${escapeHtml(c.display_name)}</strong>
        <small>${formatDateTime(c.created_at)}</small>
        ${(profile && c.author_id === profile.id)
          ? `<button class="btn btn-ghost eng-del" data-del="${c.id}">✕</button>` : ''}
        <p>${escapeHtml(c.body)}</p>
      </div>`).join('');
    liste.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        try {
          await deleteComment(b.getAttribute('data-del'));
          nbComs.textContent = Math.max(0, Number(nbComs.textContent) - 1);
          await rafraichir();
        } catch (e) { await showAlert(String(e.message || e)); }
      });
    });
  }

  rafraichir();
}

export { contentStats };

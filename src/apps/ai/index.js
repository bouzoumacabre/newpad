// ============================================================================
// NEW AI — le guide de la tablette
// ============================================================================
// Aucun appel à un modèle, aucun coût : le moteur (guide.js) compare la
// question à des mots-clés et oriente vers l'application qui convient, avec un
// bouton pour l'ouvrir. La conversation n'est pas stockée.
//
// Une version générative existe côté serveur (Edge Function `new-ai`, payante,
// inactive sans clé ANTHROPIC_API_KEY) ; cet écran ne l'appelle pas.

import { renderAppShell } from '../appShell.js';
import { escapeHtml } from '../../lib/format.js';
import { navigate } from '../../lib/router.js';
import { listLauncherApps } from '../../lib/newpadApi.js';
import { repondre } from './guide.js';

export async function renderAiApp(root, profile) {
  const { body } = await renderAppShell(root, profile, 'ai', {});
  let registre = [];
  try { registre = await listLauncherApps(); } catch (_) { registre = []; }

  body.innerHTML = `
    <div class="na-wrap">
      <div class="na-fil" id="na-fil">
        <div class="na-accueil muted">
          Décrivez ce que vous voulez faire — trouver un emploi, acheter une voiture,
          voir un médecin, faire un virement… — je vous indique l'application qui convient.
        </div>
      </div>
      <form class="na-saisie" id="na-form">
        <textarea id="na-in" rows="2" maxlength="500" placeholder="Votre question…"></textarea>
        <button class="btn btn-primary" type="submit">Envoyer</button>
      </form>
    </div>
    <style>
      .na-wrap { display:flex; flex-direction:column; height:100%; gap:10px; }
      .na-fil { flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:10px; }
      .na-accueil { font-size:12.5px; text-align:center; margin:auto 0; }
      .na-msg { max-width:80%; padding:10px 13px; border-radius:12px; font-size:13.5px; line-height:1.55; white-space:pre-wrap; }
      .na-msg.user { align-self:flex-end; background:var(--card-bg); border:1px solid var(--card-border); }
      .na-msg.assistant { align-self:flex-start; background:rgba(123,95,217,0.12); border:1px solid rgba(123,95,217,0.35); }
      .na-liens { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
      .na-liens .btn { padding:5px 12px; font-size:12.5px; }
      .na-saisie { display:flex; gap:8px; align-items:flex-end; }
      .na-saisie textarea { flex:1; resize:none; margin:0; }
    </style>`;

  const fil = document.getElementById('na-fil');
  const champ = document.getElementById('na-in');

  function ajouter(role, texte, apps = []) {
    fil.querySelector('.na-accueil')?.remove();
    const el = document.createElement('div');
    el.className = 'na-msg ' + role;
    el.innerHTML = escapeHtml(texte) + (apps.length ? `<div class="na-liens">${apps.map((a) =>
      `<button class="btn btn-secondary" data-route="${escapeHtml(a.route)}">Ouvrir ${escapeHtml(a.name)}</button>`).join('')}</div>` : '');
    el.querySelectorAll('[data-route]').forEach((b) => {
      b.addEventListener('click', () => navigate(b.getAttribute('data-route')));
    });
    fil.appendChild(el);
    fil.scrollTop = fil.scrollHeight;
  }

  document.getElementById('na-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const question = champ.value.trim();
    if (!question) return;
    champ.value = '';
    ajouter('user', question);
    const r = repondre(question, registre);
    ajouter('assistant', r.texte, r.apps);
    champ.focus();
  });

  // Entrée envoie, Maj+Entrée va à la ligne.
  champ.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('na-form').requestSubmit(); }
  });
}

// ============================================================================
// NEW AI — l'assistant de la tablette
// ============================================================================
// Une discussion avec Claude, via l'Edge Function `new-ai` (la clé API ne
// quitte jamais le serveur). Le quota du jour est décompté en base (0060).
// La conversation n'est pas stockée : elle vit dans cet écran, et disparaît
// quand on le quitte.

import { renderAppShell } from '../appShell.js';
import { escapeHtml } from '../../lib/format.js';
import { supabase } from '../../lib/supabaseClient.js';

async function envoyer(messages) {
  const { data, error } = await supabase.functions.invoke('new-ai', { body: { messages } });
  if (error) {
    // Le message utile est dans le corps JSON de la réponse d'erreur.
    let texte = error.message;
    try { const corps = await error.context?.json?.(); if (corps?.error) texte = corps.error; } catch (_) { /* rien */ }
    throw new Error(texte);
  }
  return data;
}

export async function renderAiApp(root, profile) {
  const historique = [];
  let restant = null;
  let enCours = false;

  const { body } = await renderAppShell(root, profile, 'ai', {});

  body.innerHTML = `
    <div class="na-wrap">
      <div class="na-fil" id="na-fil">
        <div class="na-accueil muted">
          Posez une question sur la ville ou sur Newpad. NEW AI n'a accès à aucun de vos comptes.
        </div>
      </div>
      <form class="na-saisie" id="na-form">
        <textarea id="na-in" rows="2" maxlength="4000" placeholder="Votre message…"></textarea>
        <button class="btn btn-primary" id="na-go" type="submit">Envoyer</button>
      </form>
      <div class="muted na-quota" id="na-quota"></div>
    </div>
    <style>
      .na-wrap { display:flex; flex-direction:column; height:100%; gap:10px; }
      .na-fil { flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:10px; }
      .na-accueil { font-size:12.5px; text-align:center; margin:auto 0; }
      .na-msg { max-width:80%; padding:10px 13px; border-radius:12px; font-size:13.5px; line-height:1.55; white-space:pre-wrap; }
      .na-msg.user { align-self:flex-end; background:var(--card-bg); border:1px solid var(--card-border); }
      .na-msg.assistant { align-self:flex-start; background:rgba(123,95,217,0.12); border:1px solid rgba(123,95,217,0.35); }
      .na-msg.erreur { align-self:center; font-size:12.5px; color:var(--status-danger); background:none; }
      .na-saisie { display:flex; gap:8px; align-items:flex-end; }
      .na-saisie textarea { flex:1; resize:none; margin:0; }
      .na-quota { font-size:11.5px; text-align:right; min-height:14px; }
    </style>`;

  const fil = document.getElementById('na-fil');
  const champ = document.getElementById('na-in');
  const bouton = document.getElementById('na-go');

  function ajouter(role, texte) {
    fil.querySelector('.na-accueil')?.remove();
    const el = document.createElement('div');
    el.className = 'na-msg ' + role;
    el.innerHTML = escapeHtml(texte);
    fil.appendChild(el);
    fil.scrollTop = fil.scrollHeight;
    return el;
  }

  function afficherQuota() {
    document.getElementById('na-quota').textContent = restant === null ? ''
      : `${restant} message${restant > 1 ? 's' : ''} restant${restant > 1 ? 's' : ''} aujourd’hui`;
  }

  try { restant = (await supabase.rpc('ai_remaining')).data ?? null; } catch (_) { restant = null; }
  afficherQuota();

  document.getElementById('na-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const texte = champ.value.trim();
    if (!texte || enCours) return;
    enCours = true; bouton.disabled = true; champ.value = '';

    ajouter('user', texte);
    historique.push({ role: 'user', content: texte });
    const attente = ajouter('assistant', '…');

    try {
      const r = await envoyer(historique);
      attente.innerHTML = escapeHtml(r.text);
      historique.push({ role: 'assistant', content: r.text });
      if (typeof r.remaining === 'number') { restant = r.remaining; afficherQuota(); }
    } catch (err) {
      attente.remove();
      // Le message non répondu sort de l'historique : sinon deux messages du
      // joueur se suivraient au prochain envoi.
      historique.pop();
      ajouter('erreur', String(err.message || err));
    } finally {
      enCours = false; bouton.disabled = false; champ.focus();
    }
  });

  // Entrée envoie, Maj+Entrée va à la ligne.
  champ.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('na-form').requestSubmit(); }
  });
}

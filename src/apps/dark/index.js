// ============================================================================
// NewDark — l'espace clandestin
// ============================================================================
// Application restreinte (0045) : n'y entre que qui a été autorisé nommément,
// et la base le revérifie à chaque appel (0059). On y parle sous pseudonyme ;
// aucun écran ne montre, ni ne reçoit, l'identité réelle d'un auteur.
// Les messages s'effacent seuls au bout de 14 jours.

import { renderAppShell } from '../appShell.js';
import { escapeHtml, formatDateTime } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { supabase } from '../../lib/supabaseClient.js';

const RUBRIQUES = [
  ['contrats', 'Contrats'], ['marche', 'Marché'], ['infos', 'Infos'],
  ['recrutement', 'Recrutement'], ['divers', 'Divers'],
];
const rubrique = (cle) => (RUBRIQUES.find((r) => r[0] === cle) || [cle, cle])[1];

async function rpc(nom, args) {
  const { data, error } = await supabase.rpc(nom, args);
  if (error) throw error;
  return data;
}
const message = (e) => String(e.message || e);

// « Efface dans 3 j » : l'échéance compte davantage que la date de publication.
function restant(iso) {
  const h = Math.max(0, Math.round((new Date(iso) - Date.now()) / 3600000));
  return h >= 48 ? `${Math.round(h / 24)} j` : `${h} h`;
}

export async function renderDarkApp(root, profile) {
  let filtre = '';
  let alias = null;

  const { body } = await renderAppShell(root, profile, 'dark', {
    actions: '<button class="btn btn-primary" id="nd-new" style="padding:6px 14px;font-size:13px;display:none;">+ Publier</button>',
  });

  try { alias = await rpc('dark_my_alias'); }
  catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(message(e))}</div>`; return; }

  if (!alias) return choisirPseudo();
  demarrer();

  function demarrer() {
    const bouton = document.getElementById('nd-new');
    if (bouton) { bouton.style.display = ''; bouton.onclick = composer; }
    fil();
  }

  // --------------------------------------------------------------------------
  function choisirPseudo() {
    body.innerHTML = `
      <div class="card" style="max-width:420px;margin:24px auto;">
        <h3 style="margin-bottom:8px;">Choisissez votre pseudonyme</h3>
        <p class="muted" style="font-size:12.5px;margin-bottom:14px;">
          Ici, personne ne voit votre nom. Votre pseudonyme est définitif : c'est
          lui qui porte votre réputation.</p>
        <div class="field"><label for="nd-alias">Pseudonyme</label>
          <input id="nd-alias" maxlength="20" placeholder="3 à 20 caractères" autocomplete="off" /></div>
        <button class="btn btn-primary" id="nd-alias-ok" style="width:100%;">Entrer</button>
        <div class="muted" id="nd-alias-msg" style="font-size:12.5px;margin-top:10px;"></div>
      </div>`;
    document.getElementById('nd-alias-ok').addEventListener('click', async () => {
      const saisie = document.getElementById('nd-alias').value.trim();
      if (!(await showConfirm(`Prendre « ${saisie} » ? Vous ne pourrez plus en changer.`))) return;
      try { alias = await rpc('dark_set_alias', { p_alias: saisie }); demarrer(); }
      catch (e) { document.getElementById('nd-alias-msg').textContent = message(e); }
    });
  }

  // --------------------------------------------------------------------------
  async function fil() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let lignes;
    try { lignes = (await rpc('dark_feed', { p_category: filtre || null })) || []; }
    catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(message(e))}</div>`; return; }

    body.innerHTML = `
      <div class="app-toolbar">
        <select id="nd-cat" style="margin:0;max-width:200px;">
          <option value="">Toutes les rubriques</option>
          ${RUBRIQUES.map(([v, l]) => `<option value="${v}" ${v === filtre ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <span class="muted" style="font-size:12px;margin-left:auto;">Vous êtes <strong class="gold">${escapeHtml(alias)}</strong></span>
      </div>
      ${lignes.length ? `<div class="app-list">${lignes.map((p) => `
        <div class="app-row" data-post="${p.id}" style="cursor:pointer;">
          <span class="app-row-main">
            <strong>${escapeHtml(p.title)}</strong>
            <small>${escapeHtml(p.excerpt)}</small>
            <small>${escapeHtml(p.alias)}${p.is_mine ? ' (vous)' : ''} · ${p.replies} réponse${Number(p.replies) > 1 ? 's' : ''}
              · s'efface dans ${restant(p.expires_at)}</small>
          </span>
          <span class="badge badge-neutral">${escapeHtml(rubrique(p.category))}</span>
        </div>`).join('')}</div>`
        : '<div class="app-empty">Rien pour l’instant. Le silence est d’or.</div>'}`;

    document.getElementById('nd-cat').addEventListener('change', (e) => { filtre = e.target.value; fil(); });
    body.querySelectorAll('[data-post]').forEach((r) => {
      r.addEventListener('click', () => discussion(r.getAttribute('data-post')));
    });
  }

  // --------------------------------------------------------------------------
  async function discussion(id) {
    let p;
    try { p = await rpc('dark_thread', { p_post_id: id }); }
    catch (e) { await showAlert(message(e)); fil(); return; }
    const retirable = (mien) => mien || p.can_moderate;

    panneau(p.title, `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
        <span class="badge badge-neutral">${escapeHtml(rubrique(p.category))}</span>
        <span class="badge badge-neutral">s'efface dans ${restant(p.expires_at)}</span>
      </div>
      <div class="muted" style="font-size:12px;margin-bottom:6px;">${escapeHtml(p.alias)}${p.is_mine ? ' (vous)' : ''} · ${formatDateTime(p.created_at)}</div>
      <p style="font-size:13px;line-height:1.6;white-space:pre-wrap;margin-bottom:12px;">${escapeHtml(p.body)}</p>
      ${retirable(p.is_mine) ? '<button class="btn btn-ghost" id="nd-del" style="margin-bottom:14px;">Retirer ce message</button>' : ''}

      <div class="app-list" style="margin-bottom:12px;">${p.replies.map((r) => `
        <div class="app-row">
          <span class="app-row-main">
            <small>${escapeHtml(r.alias)}${r.is_mine ? ' (vous)' : ''} · ${formatDateTime(r.created_at)}</small>
            <span style="font-size:13px;white-space:pre-wrap;">${escapeHtml(r.body)}</span>
          </span>
          ${retirable(r.is_mine) ? `<span class="app-row-actions"><button class="btn btn-ghost" data-del="${r.id}" title="Retirer">✕</button></span>` : ''}
        </div>`).join('')}</div>

      <div class="field"><label for="nd-rep">Répondre en tant que ${escapeHtml(alias)}</label>
        <textarea id="nd-rep" rows="3" maxlength="2000"></textarea></div>
      <button class="btn btn-primary" id="nd-send" style="width:100%;">Envoyer</button>
    `, () => {
      document.getElementById('nd-send').addEventListener('click', async () => {
        const texte = document.getElementById('nd-rep').value;
        if (!texte.trim()) return;
        try { await rpc('dark_reply', { p_post_id: id, p_body: texte }); discussion(id); fil(); }
        catch (e) { await showAlert(message(e)); }
      });
      document.getElementById('nd-del')?.addEventListener('click', async () => {
        if (!(await showConfirm('Retirer ce message et ses réponses ?'))) return;
        try { await rpc('dark_remove', { p_kind: 'post', p_id: id }); fermerPanneau(); fil(); }
        catch (e) { await showAlert(message(e)); }
      });
      document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        try { await rpc('dark_remove', { p_kind: 'reply', p_id: b.getAttribute('data-del') }); discussion(id); fil(); }
        catch (e) { await showAlert(message(e)); }
      }));
    });
  }

  // --------------------------------------------------------------------------
  function composer() {
    panneau('Publier', `
      <div class="field"><label for="nd-c">Rubrique</label>
        <select id="nd-c">${RUBRIQUES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
      <div class="field"><label for="nd-t">Titre</label><input id="nd-t" maxlength="100" /></div>
      <div class="field"><label for="nd-b">Message</label><textarea id="nd-b" rows="6" maxlength="4000"></textarea></div>
      <button class="btn btn-primary" id="nd-pub" style="width:100%;">Publier en tant que ${escapeHtml(alias)}</button>
      <div class="muted" id="nd-msg" style="font-size:12.5px;margin-top:10px;">
        Le message s’effacera de lui-même dans 14 jours. Newpad n’encaisse rien : un contrat se règle ailleurs.
      </div>
    `, () => {
      document.getElementById('nd-pub').addEventListener('click', async () => {
        const msg = document.getElementById('nd-msg');
        try {
          const id = await rpc('dark_post', {
            p_category: document.getElementById('nd-c').value,
            p_title: document.getElementById('nd-t').value,
            p_body: document.getElementById('nd-b').value,
          });
          fermerPanneau(); fil(); discussion(id);
        } catch (e) { msg.textContent = 'Échec : ' + message(e); }
      });
    });
  }

  // --------------------------------------------------------------------------
  function panneau(titre, html, apres) {
    fermerPanneau();
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.id = 'nd-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(titre)}</strong>
        <button class="btn btn-ghost" id="nd-close" style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">${html}</div>`;
    document.querySelector('.app-frame').appendChild(el);
    document.getElementById('nd-close').addEventListener('click', fermerPanneau);
    if (apres) apres();
  }

  function fermerPanneau() { document.getElementById('nd-panel')?.remove(); }
}

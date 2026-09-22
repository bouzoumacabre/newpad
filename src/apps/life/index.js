// ============================================================================
// NewLife — réseau social (§41)
// ============================================================================
// Comme NewTube, il ne compte rien lui-même : réactions et commentaires
// viennent du socle d'engagement, et SACEM y lira les mentions d'un artiste
// (§52) sans que NewLife ait à s'en occuper.

import { renderAppShell } from '../appShell.js';
import { escapeHtml, formatDateTime } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { appIconSvg } from '../../lib/appIcons.js';
import { supabase } from '../../lib/supabaseClient.js';
import { mountAdSlot } from '../../components/adSlot.js';
import { contentStats } from '../../lib/engagement.js';
import { engagementBarHtml, wireEngagement } from '../../components/engagementBar.js';

const ENTITE = 'life_post';

export async function renderLifeApp(root, profile) {
  let portee = 'all';
  let recherche = '';

  const onglets = [{ key: 'all', label: 'Fil public' }];
  if (profile) onglets.push({ key: 'following', label: 'Abonnements' });

  const { body } = await renderAppShell(root, profile, 'life', {
    tabs: onglets,
    active: portee,
    onTab: (k) => { portee = k; marquer(); charger(); },
    actions: profile
      ? '<button class="btn btn-primary" id="nl-new" style="padding:6px 14px;font-size:13px;">+ Publier</button>'
      : '',
  });

  function marquer() {
    document.querySelectorAll('.app-tab').forEach((t) => {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === portee);
    });
  }

  // --------------------------------------------------------------------------
  async function charger() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let posts = [];
    try {
      const { data, error } = await supabase.rpc('life_feed', {
        p_scope: portee, p_query: recherche || null, p_author: null,
      });
      if (error) throw error;
      posts = data || [];
    } catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    const stats = await contentStats(ENTITE, posts.map((p) => p.id));

    body.innerHTML = `
      <div class="app-toolbar">
        <input id="nl-q" placeholder="Rechercher, ou #motclé" value="${escapeHtml(recherche)}"
               style="flex:1;min-width:200px;margin:0;" />
      </div>
      <div id="ad-zone"></div>
      ${posts.length ? `<div class="nl-feed">${posts.map((p) => publication(p, stats[p.id])).join('')}</div>`
        : `<div class="app-empty">${portee === 'following'
            ? "Vous ne suivez encore personne, ou personne n'a rien publié."
            : 'Aucune publication.'}</div>`}
    `;

    const champ = document.getElementById('nl-q');
    let minuteur = null;
    champ.addEventListener('input', () => {
      clearTimeout(minuteur);
      minuteur = setTimeout(() => { recherche = champ.value; charger(); }, 300);
    });

    mountAdSlot(document.getElementById('ad-zone'), 'life');

    posts.forEach((p) => {
      const hote = document.getElementById('eng-' + p.id);
      if (hote) wireEngagement(hote, ENTITE, p.id, profile);
    });

    body.querySelectorAll('[data-auteur]').forEach((b) => {
      b.addEventListener('click', () => fiche(b.getAttribute('data-auteur')));
    });
    body.querySelectorAll('[data-sup]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!(await showConfirm('Supprimer cette publication ?'))) return;
        try {
          const { error } = await supabase.rpc('life_delete_post', { p_id: b.getAttribute('data-sup') });
          if (error) throw error;
          charger();
        } catch (e) { await showAlert(String(e.message || e)); }
      });
    });
    body.querySelectorAll('[data-tag]').forEach((b) => {
      b.addEventListener('click', () => { recherche = '#' + b.getAttribute('data-tag'); charger(); });
    });
  }

  // Les mots-clés du texte deviennent cliquables sans réécrire le corps :
  // on échappe d'abord, on décore ensuite. L'inverse laisserait passer du
  // balisage écrit par un joueur.
  function corpsDecore(texte) {
    return escapeHtml(texte).replace(/#([A-Za-zÀ-ÿ0-9_]{2,24})/g,
      (_, t) => `<button class="nl-tag" data-tag="${t.toLowerCase()}">#${t}</button>`);
  }

  function publication(p, s) {
    const mien = profile && p.author_id === profile.id;
    return `
      <article class="nl-post">
        <header class="nl-post-head">
          <button class="nl-auteur" data-auteur="${p.author_id}">${escapeHtml(p.auteur)}</button>
          ${p.organisation ? `<span class="badge badge-neutral">${escapeHtml(p.organisation)}</span>` : ''}
          <span class="nl-date">${formatDateTime(p.created_at)}</span>
          ${mien ? `<button class="btn btn-ghost" data-sup="${p.id}" style="padding:1px 8px;font-size:11px;">✕</button>` : ''}
        </header>
        <div class="nl-body">${corpsDecore(p.body)}</div>
        ${p.media_url ? `<img class="nl-media" src="${escapeHtml(p.media_url)}" alt="" loading="lazy" />` : ''}
        <div id="eng-${p.id}">${engagementBarHtml(s)}</div>
      </article>`;
  }

  async function fiche(profileId) {
    let infos;
    try {
      const { data, error } = await supabase.rpc('life_profile_info', { p_profile_id: profileId });
      if (error) throw error;
      infos = data;
    } catch (e) { await showAlert(String(e.message || e)); return; }

    let posts = [];
    try {
      const { data } = await supabase.rpc('life_feed', { p_scope: 'all', p_query: null, p_author: profileId });
      posts = data || [];
    } catch (_) { /* liste vide */ }

    panneau(infos.display_name, `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
        <span class="np-dir-logo" style="width:48px;height:48px;">${infos.avatar_url
          ? `<img src="${escapeHtml(infos.avatar_url)}" alt="" />` : appIconSvg('social', 22)}</span>
        <div>
          <div style="color:var(--ivory);font-family:var(--font-display);font-size:16px;">${escapeHtml(infos.display_name)}</div>
          <div class="muted" style="font-size:12px;">${escapeHtml(infos.username)}</div>
        </div>
      </div>
      ${infos.bio ? `<p style="font-size:13px;line-height:1.6;margin-bottom:12px;">${escapeHtml(infos.bio)}</p>` : ''}
      <div class="muted" style="font-size:12.5px;margin-bottom:12px;">
        ${infos.publications} publication${infos.publications > 1 ? 's' : ''} ·
        ${infos.abonnes} abonné${infos.abonnes > 1 ? 's' : ''} ·
        ${infos.abonnements} abonnement${infos.abonnements > 1 ? 's' : ''}
      </div>
      ${profile && infos.id !== profile.id
        ? `<button class="btn ${infos.je_le_suis ? 'btn-ghost' : 'btn-primary'}" id="nl-follow" style="width:100%;margin-bottom:14px;">
             ${infos.je_le_suis ? 'Suivi' : 'Suivre'}</button>`
        : ''}
      <div class="app-list">
        ${posts.map((p) => `
          <div class="app-row" style="align-items:flex-start;">
            <span class="app-row-main">
              <small>${formatDateTime(p.created_at)}</small>
              <span style="font-size:13px;color:var(--text);margin-top:4px;white-space:pre-wrap;">${escapeHtml(p.body)}</span>
            </span>
          </div>`).join('') || '<div class="muted" style="font-size:12.5px;">Aucune publication.</div>'}
      </div>
    `, () => {
      document.getElementById('nl-follow')?.addEventListener('click', async (e) => {
        try {
          const r = await supabase.rpc('life_follow', { p_profile_id: profileId });
          if (r.error) throw r.error;
          e.target.textContent = r.data ? 'Suivi' : 'Suivre';
          e.target.className = 'btn ' + (r.data ? 'btn-ghost' : 'btn-primary');
        } catch (err) { await showAlert(String(err.message || err)); }
      });
    });
  }

  function composer() {
    panneau('Nouvelle publication', `
      <div class="field"><label for="nl-b">Votre message</label>
        <textarea id="nl-b" rows="6" maxlength="1200" placeholder="Quoi de neuf ? Utilisez #motclé pour être trouvé."></textarea></div>
      <div class="field"><label for="nl-m">Image (adresse)</label><input id="nl-m" placeholder="https://…" /></div>
      <button class="btn btn-primary" id="nl-send" style="width:100%;">Publier</button>
      <div class="muted" id="nl-msg" style="font-size:12.5px;margin-top:10px;"></div>
    `, () => {
      document.getElementById('nl-send').addEventListener('click', async () => {
        const msg = document.getElementById('nl-msg');
        msg.textContent = 'Publication…';
        try {
          const { error } = await supabase.rpc('life_publish', {
            p_body: document.getElementById('nl-b').value,
            p_media_url: document.getElementById('nl-m').value,
            p_organization_id: null,
          });
          if (error) throw error;
          fermerPanneau();
          charger();
        } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
      });
    });
  }

  function panneau(titre, html, apres) {
    fermerPanneau();
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.id = 'nl-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(titre)}</strong>
        <button class="btn btn-ghost" id="nl-close" style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">${html}</div>`;
    document.querySelector('.app-frame').appendChild(el);
    document.getElementById('nl-close').addEventListener('click', fermerPanneau);
    if (apres) apres();
  }

  function fermerPanneau() { document.getElementById('nl-panel')?.remove(); }

  document.getElementById('nl-new')?.addEventListener('click', composer);

  await charger();
}

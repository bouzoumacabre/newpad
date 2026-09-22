// ============================================================================
// NewTube — plateforme vidéo (§35)
// ============================================================================
// Ne compte ni les vues, ni les « j'aime », ni les commentaires : tout cela
// vient du socle d'engagement (0049), que SACEM lira ensuite tel quel pour une
// œuvre liée à une vidéo (§51). L'application n'apporte que ce qui lui est
// propre — des chaînes et des vidéos.

import { renderAppShell } from '../appShell.js';
import { escapeHtml, formatDate } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { appIconSvg } from '../../lib/appIcons.js';
import { supabase } from '../../lib/supabaseClient.js';
import { trackView, contentStats } from '../../lib/engagement.js';
import { engagementBarHtml, wireEngagement } from '../../components/engagementBar.js';

const ENTITE = 'tube_video';

function duree(s) {
  if (!s) return '';
  const m = Math.floor(s / 60), r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

export async function renderTubeApp(root, profile) {
  let onglet = 'decouvrir';
  let recherche = '';
  let chaines = [];

  if (profile) {
    try {
      const { data } = await supabase.rpc('tube_my_channels');
      chaines = data || [];
    } catch (_) { chaines = []; }
  }

  const onglets = [{ key: 'decouvrir', label: 'Découvrir' }];
  if (profile) onglets.push({ key: 'chaine', label: chaines.length ? 'Ma chaîne' : 'Créer ma chaîne' });

  const { body } = await renderAppShell(root, profile, 'youtube', {
    tabs: onglets,
    active: onglet,
    onTab: (k) => { onglet = k; marquer(); rendre(); },
  });

  function marquer() {
    document.querySelectorAll('.app-tab').forEach((t) => {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === onglet);
    });
  }

  function rendre() { onglet === 'decouvrir' ? vueDecouvrir() : vueChaine(); }

  // --------------------------------------------------------------------------
  async function vueDecouvrir(channelId = null) {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let videos = [];
    try {
      const { data, error } = await supabase.rpc('tube_feed', {
        p_query: recherche || null, p_channel_id: channelId,
      });
      if (error) throw error;
      videos = data || [];
    } catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    const stats = await contentStats(ENTITE, videos.map((v) => v.id));

    body.innerHTML = `
      <div class="app-toolbar">
        <input id="nt-q" placeholder="Rechercher une vidéo, une chaîne…" value="${escapeHtml(recherche)}"
               style="flex:1;min-width:200px;margin:0;" />
      </div>
      ${videos.length ? `<div class="nt-grid">${videos.map((v) => vignette(v, stats[v.id])).join('')}</div>`
        : '<div class="app-empty">Aucune vidéo pour le moment.</div>'}
    `;

    const champ = document.getElementById('nt-q');
    let minuteur = null;
    champ.addEventListener('input', () => {
      clearTimeout(minuteur);
      minuteur = setTimeout(() => { recherche = champ.value; vueDecouvrir(channelId); }, 300);
    });
    body.querySelectorAll('[data-v]').forEach((b) => {
      b.addEventListener('click', () => lire(videos.find((v) => v.id === b.getAttribute('data-v'))));
    });
  }

  function vignette(v, s) {
    return `
      <button class="nt-card" data-v="${v.id}">
        <span class="nt-thumb">
          ${v.thumbnail_url
            ? `<img src="${escapeHtml(v.thumbnail_url)}" alt="" loading="lazy" />`
            : `<span class="nt-thumb-vide">${appIconSvg('video', 26)}</span>`}
          ${v.duration_seconds ? `<span class="nt-duree">${duree(v.duration_seconds)}</span>` : ''}
        </span>
        <span class="nt-title">${escapeHtml(v.title)}</span>
        <span class="nt-meta">
          ${escapeHtml(v.chaine)} · ${formatDate(v.published_at)}
          ${s ? ` · ${s.vues} vue${s.vues > 1 ? 's' : ''}` : ''}
        </span>
      </button>`;
  }

  async function lire(v) {
    if (!v) return;
    trackView('youtube', ENTITE, v.id);
    const stats = (await contentStats(ENTITE, [v.id]))[v.id];
    let infos = null;
    try {
      const { data } = await supabase.rpc('tube_channel_info', { p_channel_id: v.channel_id });
      infos = data;
    } catch (_) { /* facultatif */ }

    panneau(v.title, `
      <div class="nt-player">
        <video controls playsinline preload="metadata"
               ${v.thumbnail_url ? `poster="${escapeHtml(v.thumbnail_url)}"` : ''}
               src="${escapeHtml(v.video_url)}"></video>
      </div>
      <p class="muted" style="font-size:12px;margin:10px 0;">
        ${escapeHtml(v.chaine)} · ${formatDate(v.published_at)}
      </p>
      ${infos ? `
        <div class="app-row" style="padding:9px 11px;margin-bottom:10px;">
          <span class="app-row-main">
            <strong>${escapeHtml(infos.name)}</strong>
            <small>${infos.abonnes} abonné${infos.abonnes > 1 ? 's' : ''} · ${infos.nb_videos} vidéo${infos.nb_videos > 1 ? 's' : ''}</small>
          </span>
          ${profile && infos.owner_id !== profile.id
            ? `<span class="app-row-actions"><button class="btn ${infos.je_suis_abonne ? 'btn-ghost' : 'btn-secondary'}" id="nt-sub">${infos.je_suis_abonne ? 'Abonné' : "S'abonner"}</button></span>`
            : ''}
        </div>` : ''}
      ${v.description ? `<div style="white-space:pre-wrap;font-size:13px;line-height:1.6;">${escapeHtml(v.description)}</div>` : ''}
      <hr style="border:0;border-top:1px solid var(--card-border);margin:14px 0;" />
      <div id="nt-eng">${engagementBarHtml(stats)}</div>
    `, () => {
      wireEngagement(document.getElementById('nt-eng'), ENTITE, v.id, profile);
      document.getElementById('nt-sub')?.addEventListener('click', async (e) => {
        try {
          const abonne = await supabase.rpc('tube_subscribe', { p_channel_id: v.channel_id });
          if (abonne.error) throw abonne.error;
          e.target.textContent = abonne.data ? 'Abonné' : 'S\'abonner';
          e.target.className = 'btn ' + (abonne.data ? 'btn-ghost' : 'btn-secondary');
        } catch (err) { await showAlert(String(err.message || err)); }
      });
    });
  }

  // --------------------------------------------------------------------------
  async function vueChaine() {
    if (!chaines.length) {
      body.innerHTML = `
        <div class="app-empty" style="max-width:420px;margin:0 auto;">
          <p style="margin-bottom:14px;">Vous n'avez pas encore de chaîne.</p>
          <button class="btn btn-primary" id="nt-create">Créer ma chaîne</button>
        </div>`;
      document.getElementById('nt-create').addEventListener('click', formulaireChaine);
      return;
    }

    const c = chaines[0];
    body.innerHTML = `
      <div class="np-pro-head">
        <span class="np-dir-logo">${c.avatar_url
          ? `<img src="${escapeHtml(c.avatar_url)}" alt="" />` : appIconSvg('video', 22)}</span>
        <div style="flex:1;min-width:0;">
          <div style="color:var(--ivory);font-family:var(--font-display);font-size:17px;">${escapeHtml(c.name)}</div>
          <div class="muted" style="font-size:12px;">
            ${c.abonnes} abonné${c.abonnes > 1 ? 's' : ''} · ${c.nb_videos} vidéo${c.nb_videos > 1 ? 's' : ''}
          </div>
        </div>
        <button class="btn btn-primary" id="nt-upload">+ Publier une vidéo</button>
      </div>
      <div id="nt-mine"></div>`;

    document.getElementById('nt-upload').addEventListener('click', () => formulaireVideo(c));

    const zone = document.getElementById('nt-mine');
    zone.innerHTML = '<div class="app-empty">Chargement…</div>';
    let videos = [];
    try {
      const { data } = await supabase.rpc('tube_feed', { p_query: null, p_channel_id: c.id });
      videos = data || [];
    } catch (_) { videos = []; }

    zone.innerHTML = videos.length
      ? `<div class="app-list">${videos.map((v) => `
          <div class="app-row">
            <span class="app-row-icon">${appIconSvg('video', 16)}</span>
            <span class="app-row-main">
              <strong>${escapeHtml(v.title)}</strong>
              <small>${formatDate(v.published_at)}${v.duration_seconds ? ' · ' + duree(v.duration_seconds) : ''}</small>
            </span>
            ${v.status === 'published' ? '<span class="badge badge-success">en ligne</span>'
              : (v.status === 'removed' ? '<span class="badge badge-danger">retirée</span>'
              : '<span class="badge badge-neutral">non listée</span>')}
            <span class="app-row-actions">
              <button class="btn btn-ghost" data-st="${v.id}|${v.status === 'published' ? 'removed' : 'published'}">
                ${v.status === 'published' ? 'Retirer' : 'Remettre'}
              </button>
            </span>
          </div>`).join('')}</div>`
      : '<div class="app-empty">Aucune vidéo sur cette chaîne.</div>';

    zone.querySelectorAll('[data-st]').forEach((b) => {
      b.addEventListener('click', async () => {
        const [id, st] = b.getAttribute('data-st').split('|');
        if (st === 'removed' && !(await showConfirm('Retirer cette vidéo ?'))) return;
        try {
          const { error } = await supabase.rpc('tube_set_video_status', { p_id: id, p_status: st });
          if (error) throw error;
          vueChaine();
        } catch (e) { await showAlert(String(e.message || e)); }
      });
    });
  }

  function formulaireChaine() {
    panneau('Créer ma chaîne', `
      <div class="field"><label for="nt-n">Nom de la chaîne</label><input id="nt-n" maxlength="60" /></div>
      <div class="field"><label for="nt-s">Identifiant</label><input id="nt-s" maxlength="40" /></div>
      <div class="field"><label for="nt-d">Description</label><textarea id="nt-d" rows="3" maxlength="400"></textarea></div>
      <div class="field"><label for="nt-av">Image de la chaîne (adresse)</label><input id="nt-av" placeholder="https://…" /></div>
      <button class="btn btn-primary" id="nt-save" style="width:100%;">Créer</button>
      <div class="muted" id="nt-msg" style="font-size:12.5px;margin-top:10px;"></div>
    `, () => {
      document.getElementById('nt-n').addEventListener('input', (e) => {
        const s = document.getElementById('nt-s');
        if (s.dataset.touche) return;
        s.value = e.target.value.toLowerCase().normalize('NFD')
          .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '').slice(0, 40);
      });
      document.getElementById('nt-s').addEventListener('input', (e) => { e.target.dataset.touche = '1'; });
      document.getElementById('nt-save').addEventListener('click', async () => {
        const msg = document.getElementById('nt-msg');
        msg.textContent = 'Création…';
        try {
          const { error } = await supabase.rpc('tube_save_channel', {
            p_name: document.getElementById('nt-n').value,
            p_slug: document.getElementById('nt-s').value,
            p_description: document.getElementById('nt-d').value,
            p_avatar_url: document.getElementById('nt-av').value,
          });
          if (error) throw error;
          const { data } = await supabase.rpc('tube_my_channels');
          chaines = data || [];
          fermerPanneau();
          vueChaine();
        } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
      });
    });
  }

  function formulaireVideo(c) {
    panneau('Publier une vidéo', `
      <div class="field"><label for="nt-vt">Titre</label><input id="nt-vt" maxlength="140" /></div>
      <div class="field"><label for="nt-vu">Adresse de la vidéo</label>
        <input id="nt-vu" placeholder="https://…" />
        <div class="muted" style="font-size:12px;margin-top:4px;">
          Lien direct vers un fichier vidéo. Le lecteur de la tablette le lit sans dépendance externe.
        </div></div>
      <div class="field"><label for="nt-vth">Miniature (adresse)</label><input id="nt-vth" placeholder="https://…" /></div>
      <div class="field"><label for="nt-vd">Description</label><textarea id="nt-vd" rows="4" maxlength="2000"></textarea></div>
      <div class="field"><label for="nt-vdur">Durée (secondes)</label><input id="nt-vdur" type="number" min="0" /></div>
      <button class="btn btn-primary" id="nt-vsave" style="width:100%;">Publier</button>
      <div class="muted" id="nt-vmsg" style="font-size:12.5px;margin-top:10px;"></div>
    `, () => {
      document.getElementById('nt-vsave').addEventListener('click', async () => {
        const msg = document.getElementById('nt-vmsg');
        msg.textContent = 'Publication…';
        try {
          const { error } = await supabase.rpc('tube_publish_video', {
            p_channel_id: c.id,
            p_title: document.getElementById('nt-vt').value,
            p_video_url: document.getElementById('nt-vu').value,
            p_description: document.getElementById('nt-vd').value,
            p_thumbnail_url: document.getElementById('nt-vth').value,
            p_duration: Number(document.getElementById('nt-vdur').value) || null,
          });
          if (error) throw error;
          fermerPanneau();
          vueChaine();
        } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
      });
    });
  }

  // --------------------------------------------------------------------------
  function panneau(titre, html, apres) {
    fermerPanneau();
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.id = 'nt-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(titre)}</strong>
        <button class="btn btn-ghost" id="nt-close" style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">${html}</div>`;
    document.querySelector('.app-frame').appendChild(el);
    document.getElementById('nt-close').addEventListener('click', fermerPanneau);
    if (apres) apres();
  }

  function fermerPanneau() { document.getElementById('nt-panel')?.remove(); }

  rendre();
}

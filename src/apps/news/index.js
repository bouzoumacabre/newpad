// ============================================================================
// News24 — le média de la ville (§34)
// ============================================================================
// Un journal EST une organisation de genre `media` : ses journalistes en sont
// les membres, son rédacteur en chef la direction. Aucun système de rôles n'est
// réinventé — et la ville peut donc avoir plusieurs journaux concurrents sans
// une ligne de code de plus.

import { renderAppShell } from '../appShell.js';
import { escapeHtml, formatDateTime } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { appIconSvg } from '../../lib/appIcons.js';
import { supabase } from '../../lib/supabaseClient.js';
import { mountAdSlot } from '../../components/adSlot.js';
import { myOrganizations } from '../organizations/api.js';
import { trackView, contentStats } from '../../lib/engagement.js';
import { engagementBarHtml, wireEngagement } from '../../components/engagementBar.js';

const ENTITE = 'news_article';

const RUBRIQUES = [
  ['city', 'Ville'], ['economy', 'Économie'], ['politics', 'Politique'],
  ['justice', 'Justice'], ['culture', 'Culture'], ['sport', 'Sport'],
  ['faitsdivers', 'Faits divers'], ['people', 'People'], ['annonce', 'Annonces'],
];

function rubriqueLabel(c) {
  const t = RUBRIQUES.find((r) => r[0] === c);
  return t ? t[1] : c;
}

export async function renderNewsApp(root, profile) {
  let onglet = 'une';
  let rubrique = null;
  let recherche = '';
  let redactions = [];

  // L'onglet Rédaction n'apparaît que pour les membres d'un média : l'afficher
  // vide à tout le monde donnerait l'impression d'une fonctionnalité cassée.
  if (profile) {
    try { redactions = (await myOrganizations()).filter((o) => o.kind === 'media'); }
    catch (_) { redactions = []; }
  }

  const onglets = [{ key: 'une', label: 'À la une' }];
  if (redactions.length) onglets.push({ key: 'redaction', label: 'Rédaction' });

  const { body } = await renderAppShell(root, profile, 'news', {
    tabs: onglets,
    active: onglet,
    onTab: (k) => { onglet = k; marquer(); rendre(); },
  });

  function marquer() {
    document.querySelectorAll('.app-tab').forEach((t) => {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === onglet);
    });
  }

  function rendre() { onglet === 'une' ? vueUne() : vueRedaction(); }

  // --------------------------------------------------------------------------
  async function vueUne() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let articles = [];
    try {
      const { data, error } = await supabase.rpc('news_feed', {
        p_category: rubrique, p_query: recherche || null, p_limit: 40,
      });
      if (error) throw error;
      articles = data || [];
    } catch (e) {
      body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`;
      return;
    }

    const stats = await contentStats(ENTITE, articles.map((a) => a.id));
    const alerte = articles.find((a) => a.is_breaking);

    body.innerHTML = `
      <div class="app-toolbar">
        <input id="nn-q" placeholder="Rechercher un sujet…" value="${escapeHtml(recherche)}"
               style="flex:1;min-width:200px;margin:0;" />
      </div>
      <div class="app-chipset" style="margin-bottom:14px;">
        <button class="app-chip ${!rubrique ? 'is-active' : ''}" data-r="">Toutes</button>
        ${RUBRIQUES.map(([v, l]) => `<button class="app-chip ${rubrique === v ? 'is-active' : ''}" data-r="${v}">${escapeHtml(l)}</button>`).join('')}
      </div>
      ${alerte ? `
        <button class="nn-breaking" data-art="${alerte.id}">
          <span class="nn-breaking-tag">Alerte</span>
          <span>${escapeHtml(alerte.title)}</span>
        </button>` : ''}
      <div id="ad-zone"></div>
      ${articles.length ? `<div class="nn-grid">${articles.map((a) => carte(a, stats[a.id])).join('')}</div>`
        : '<div class="app-empty">Aucun article pour le moment.</div>'}
    `;

    mountAdSlot(document.getElementById('ad-zone'), 'news');

    const champ = document.getElementById('nn-q');
    let minuteur = null;
    champ.addEventListener('input', () => {
      clearTimeout(minuteur);
      minuteur = setTimeout(() => { recherche = champ.value; vueUne(); }, 300);
    });
    body.querySelectorAll('[data-r]').forEach((b) => {
      b.addEventListener('click', () => { rubrique = b.getAttribute('data-r') || null; vueUne(); });
    });
    body.querySelectorAll('[data-art]').forEach((b) => {
      b.addEventListener('click', () => lire(b.getAttribute('data-art')));
    });
  }

  function carte(a, s) {
    return `
      <button class="nn-card ${a.is_featured ? 'is-featured' : ''}" data-art="${a.id}">
        ${a.cover_url ? `<span class="nn-cover"><img src="${escapeHtml(a.cover_url)}" alt="" loading="lazy" /></span>` : ''}
        <span class="nn-rubrique">${escapeHtml(rubriqueLabel(a.category))}</span>
        <span class="nn-title">${escapeHtml(a.title)}</span>
        ${a.lede ? `<span class="nn-lede">${escapeHtml(a.lede)}</span>` : ''}
        <span class="nn-meta">
          ${escapeHtml(a.journal)} · ${escapeHtml(a.author_name)} · ${formatDateTime(a.published_at)}
          ${s ? ` · ${s.vues} vue${s.vues > 1 ? 's' : ''} · ${s.reactions} ♥` : ''}
        </span>
      </button>`;
  }

  async function lire(id) {
    let a;
    try {
      const { data, error } = await supabase.rpc('news_article', { p_id: id });
      if (error) throw error;
      a = data;
    } catch (e) { await showAlert(String(e.message || e)); return; }

    // La vue est déclarée à l'ouverture, une seule fois par session : revenir
    // en arrière puis rouvrir ne doit pas gonfler le compteur.
    trackView('news', ENTITE, id);
    const stats = (await contentStats(ENTITE, [id]))[id];

    panneau(a.title, `
      ${a.cover_url ? `<img src="${escapeHtml(a.cover_url)}" alt="" style="width:100%;border-radius:var(--radius-md);margin-bottom:12px;" />` : ''}
      <div class="muted" style="font-size:12px;margin-bottom:10px;">
        ${escapeHtml(rubriqueLabel(a.category))} · ${escapeHtml(a.journal)} ·
        ${escapeHtml(a.author_name)} · ${formatDateTime(a.published_at)}
      </div>
      ${a.lede ? `<p style="font-size:14px;color:var(--gold-light);line-height:1.6;margin-bottom:12px;">${escapeHtml(a.lede)}</p>` : ''}
      <div style="white-space:pre-wrap;font-size:13.5px;line-height:1.7;">${escapeHtml(a.body)}</div>
      ${(a.tags || []).length ? `<div class="app-chipset" style="margin-top:14px;">
        ${a.tags.map((t) => `<span class="app-chip">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      <hr style="border:0;border-top:1px solid var(--card-border);margin:16px 0;" />
      <div id="nn-eng">${engagementBarHtml(stats)}</div>
    `, () => {
      wireEngagement(document.getElementById('nn-eng'), ENTITE, id, profile);
    });
  }

  // --------------------------------------------------------------------------
  async function vueRedaction() {
    let journal = redactions[0];
    body.innerHTML = `
      ${redactions.length > 1 ? `<div class="app-toolbar"><div class="app-chipset">
        ${redactions.map((o) => `<button class="app-chip" data-j="${o.id}">${escapeHtml(o.name)}</button>`).join('')}
      </div></div>` : ''}
      <button class="btn btn-primary" id="nn-new" style="margin-bottom:12px;">+ Nouvel article</button>
      <div id="nn-room"></div>`;

    body.querySelectorAll('[data-j]').forEach((b) => {
      b.addEventListener('click', () => { journal = redactions.find((o) => o.id === b.getAttribute('data-j')); charger(); });
    });
    document.getElementById('nn-new').addEventListener('click', () => editeur(journal, null));

    async function charger() {
      const zone = document.getElementById('nn-room');
      zone.innerHTML = '<div class="app-empty">Chargement…</div>';
      let lignes = [];
      try {
        const { data, error } = await supabase.rpc('news_newsroom', { p_organization_id: journal.id });
        if (error) throw error;
        lignes = data || [];
      } catch (e) { zone.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

      const chef = journal.member_role !== 'member';
      const etat = {
        draft: ['Brouillon', 'badge-neutral'], review: ['À relire', 'badge-pending'],
        published: ['Publié', 'badge-success'], archived: ['Archivé', 'badge-neutral'],
      };

      zone.innerHTML = lignes.length
        ? `<div class="app-list">${lignes.map((a) => {
            const [lib, cls] = etat[a.status] || ['—', 'badge-neutral'];
            const mien = a.author_id === profile.id;
            return `
              <div class="app-row" style="flex-wrap:wrap;">
                <span class="app-row-icon">${appIconSvg('news', 16)}</span>
                <span class="app-row-main">
                  <strong>${escapeHtml(a.title)}</strong>
                  <small>${escapeHtml(rubriqueLabel(a.category))} · ${escapeHtml(a.author_name)} · ${formatDateTime(a.created_at)}</small>
                </span>
                ${a.is_breaking ? '<span class="badge badge-danger">alerte</span>' : ''}
                <span class="badge ${cls}">${lib}</span>
                <span class="app-row-actions" style="width:100%;margin-top:8px;">
                  ${(mien || chef) ? `<button class="btn btn-ghost" data-edit="${a.id}">Modifier</button>` : ''}
                  ${a.status === 'draft' && mien ? `<button class="btn btn-secondary" data-st="${a.id}|review">Proposer</button>` : ''}
                  ${chef && a.status !== 'published' ? `<button class="btn btn-primary" data-st="${a.id}|published">Publier</button>` : ''}
                  ${chef && a.status === 'published' ? `<button class="btn btn-ghost" data-st="${a.id}|archived">Archiver</button>` : ''}
                  ${chef ? `<button class="btn btn-ghost" data-alerte="${a.id}|${a.is_breaking ? '0' : '1'}">${a.is_breaking ? 'Retirer l’alerte' : 'Alerte'}</button>` : ''}
                </span>
              </div>`;
          }).join('')}</div>`
        : '<div class="app-empty">Aucun article dans cette rédaction.</div>';

      zone.querySelectorAll('[data-edit]').forEach((b) => {
        b.addEventListener('click', () => editeur(journal, b.getAttribute('data-edit')));
      });
      zone.querySelectorAll('[data-st]').forEach((b) => {
        b.addEventListener('click', async () => {
          const [id, st] = b.getAttribute('data-st').split('|');
          if (st === 'published' && !(await showConfirm('Publier cet article ? Il sera visible de toute la ville.'))) return;
          try {
            const { error } = await supabase.rpc('news_set_status', { p_id: id, p_status: st });
            if (error) throw error;
            await charger();
          } catch (e) { await showAlert(String(e.message || e)); }
        });
      });
      zone.querySelectorAll('[data-alerte]').forEach((b) => {
        b.addEventListener('click', async () => {
          const [id, on] = b.getAttribute('data-alerte').split('|');
          try {
            const { error } = await supabase.rpc('news_set_status', {
              p_id: id, p_status: lignes.find((x) => x.id === id).status, p_breaking: on === '1',
            });
            if (error) throw error;
            await charger();
          } catch (e) { await showAlert(String(e.message || e)); }
        });
      });
    }

    await charger();
  }

  async function editeur(journal, id) {
    let a = { title: '', lede: '', body: '', category: 'city', tags: [], cover_url: '' };
    if (id) {
      try {
        const { data, error } = await supabase.rpc('news_article', { p_id: id });
        if (error) throw error;
        a = data;
      } catch (e) { await showAlert(String(e.message || e)); return; }
    }

    panneau(id ? 'Modifier' : 'Nouvel article', `
      <div class="field"><label for="nn-t">Titre</label>
        <input id="nn-t" maxlength="160" value="${escapeHtml(a.title || '')}" /></div>
      <div class="field"><label for="nn-l">Chapeau</label>
        <textarea id="nn-l" rows="2" maxlength="400">${escapeHtml(a.lede || '')}</textarea></div>
      <div class="field"><label for="nn-b">Article</label>
        <textarea id="nn-b" rows="12" maxlength="30000">${escapeHtml(a.body || '')}</textarea></div>
      <div class="grid" style="grid-template-columns:1fr 1fr;">
        <div class="field"><label for="nn-c">Rubrique</label>
          <select id="nn-c">${RUBRIQUES.map(([v, l]) =>
            `<option value="${v}" ${a.category === v ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select></div>
        <div class="field"><label for="nn-tg">Mots-clés</label>
          <input id="nn-tg" value="${escapeHtml((a.tags || []).join(', '))}" placeholder="séparés par des virgules" /></div>
      </div>
      <div class="field"><label for="nn-cv">Illustration (adresse d'image)</label>
        <input id="nn-cv" value="${escapeHtml(a.cover_url || '')}" placeholder="https://…" /></div>
      <button class="btn btn-primary" id="nn-save" style="width:100%;">Enregistrer</button>
      <div class="muted" id="nn-msg" style="font-size:12.5px;margin-top:10px;"></div>
    `, () => {
      document.getElementById('nn-save').addEventListener('click', async () => {
        const msg = document.getElementById('nn-msg');
        msg.textContent = 'Enregistrement…';
        try {
          const { error } = await supabase.rpc('news_save_article', {
            p_organization_id: journal.id,
            p_title: document.getElementById('nn-t').value,
            p_body: document.getElementById('nn-b').value,
            p_id: id,
            p_lede: document.getElementById('nn-l').value,
            p_category: document.getElementById('nn-c').value,
            p_tags: document.getElementById('nn-tg').value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10),
            p_cover_url: document.getElementById('nn-cv').value,
          });
          if (error) throw error;
          fermerPanneau();
          vueRedaction();
        } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
      });
    });
  }

  // --------------------------------------------------------------------------
  function panneau(titre, html, apres) {
    fermerPanneau();
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.id = 'nn-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(titre)}</strong>
        <button class="btn btn-ghost" id="nn-close" style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">${html}</div>`;
    document.querySelector('.app-frame').appendChild(el);
    document.getElementById('nn-close').addEventListener('click', fermerPanneau);
    if (apres) apres();
  }

  function fermerPanneau() { document.getElementById('nn-panel')?.remove(); }

  rendre();
}

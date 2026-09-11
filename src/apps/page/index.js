// ============================================================================
// NewPage — l'annuaire des entreprises (§36)
// ============================================================================
// Ouverte aux invités : on cherche l'adresse d'un garage avant d'être client
// d'une banque. Les entreprises ne sont pas saisies ici — elles viennent de la
// table `organizations`, alimentée par l'administration et tenue à jour par
// leur direction depuis NewPro. L'annuaire n'est qu'une vue.

import { renderAppShell } from '../appShell.js';
import { escapeHtml } from '../../lib/format.js';
import { appIconSvg } from '../../lib/appIcons.js';
import { listPublicOrganizations, listMembers, GENRES, ICONE_PAR_GENRE, genreLabel } from '../organizations/api.js';

export async function renderPageApp(root, profile) {
  let orgs = [];
  let genre = 'all';
  let recherche = '';

  const { body } = await renderAppShell(root, profile, 'page', {
    actions: '<input id="np-q" placeholder="Rechercher…" style="width:190px;height:32px;margin:0;font-size:13px;" />',
  });

  async function charger() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    try { orgs = await listPublicOrganizations(); }
    catch (e) {
      body.innerHTML = `<div class="app-empty">Annuaire indisponible : ${escapeHtml(String(e.message || e))}</div>`;
      return;
    }
    dessiner();
  }

  function dessiner() {
    const q = recherche.trim().toLowerCase();
    let liste = orgs;
    if (genre !== 'all') liste = liste.filter((o) => o.kind === genre);
    if (q) {
      liste = liste.filter((o) =>
        o.name.toLowerCase().includes(q)
        || (o.description || '').toLowerCase().includes(q)
        || (o.location || '').toLowerCase().includes(q));
    }

    // Seuls les genres réellement présents sont proposés en filtre.
    const presents = [...new Set(orgs.map((o) => o.kind))]
      .sort((a, b) => genreLabel(a).localeCompare(genreLabel(b)));

    body.innerHTML = `
      <div class="app-toolbar">
        <div class="app-chipset">
          <button class="app-chip ${genre === 'all' ? 'is-active' : ''}" data-g="all">Tout (${orgs.length})</button>
          ${presents.map((g) => `<button class="app-chip ${genre === g ? 'is-active' : ''}" data-g="${g}">${escapeHtml(genreLabel(g))}</button>`).join('')}
        </div>
      </div>
      ${liste.length ? `<div class="np-directory">${liste.map(carte).join('')}</div>`
        : `<div class="app-empty">${orgs.length ? 'Aucun résultat.' : "L'annuaire est vide pour le moment."}</div>`}
    `;

    body.querySelectorAll('[data-g]').forEach((b) => {
      b.addEventListener('click', () => { genre = b.getAttribute('data-g'); dessiner(); });
    });
    body.querySelectorAll('[data-org]').forEach((b) => {
      b.addEventListener('click', () => fiche(b.getAttribute('data-org')));
    });
  }

  function carte(o) {
    return `
      <button class="np-dir-card" data-org="${o.id}">
        <span class="np-dir-logo">${o.logo_url
          ? `<img src="${escapeHtml(o.logo_url)}" alt="" />`
          : appIconSvg(ICONE_PAR_GENRE[o.kind] || 'directory', 22)}</span>
        <span class="np-dir-main">
          <strong>${escapeHtml(o.name)}</strong>
          <small>${escapeHtml(genreLabel(o.kind))}${o.location ? ' · ' + escapeHtml(o.location) : ''}</small>
          ${o.description ? `<em>${escapeHtml(o.description)}</em>` : ''}
        </span>
      </button>`;
  }

  async function fiche(id) {
    const o = orgs.find((x) => x.id === id);
    if (!o) return;
    let responsables = [];
    // Un visiteur ne voit que la direction, et seulement pour une entreprise
    // publiée : la policy s'en charge, l'appel peut donc échouer sans gravité.
    try { responsables = await listMembers(id); } catch (_) { /* liste vide */ }

    panneau(o.name, `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
        <span class="np-dir-logo" style="width:52px;height:52px;">${o.logo_url
          ? `<img src="${escapeHtml(o.logo_url)}" alt="" />`
          : appIconSvg(ICONE_PAR_GENRE[o.kind] || 'directory', 26)}</span>
        <div>
          <div style="color:var(--ivory);font-family:var(--font-display);font-size:17px;">${escapeHtml(o.name)}</div>
          <div class="muted" style="font-size:12px;">${escapeHtml(genreLabel(o.kind))}</div>
        </div>
      </div>
      ${o.description ? `<p style="font-size:13px;line-height:1.6;margin-bottom:14px;">${escapeHtml(o.description)}</p>` : ''}
      <dl class="np-dir-facts">
        ${o.location ? `<dt>Adresse</dt><dd>${escapeHtml(o.location)}</dd>` : ''}
        ${o.opening_hours ? `<dt>Horaires</dt><dd>${escapeHtml(o.opening_hours)}</dd>` : ''}
        ${o.contact_phone ? `<dt>Téléphone</dt><dd>${escapeHtml(o.contact_phone)}</dd>` : ''}
        ${o.contact_email ? `<dt>Contact</dt><dd>${escapeHtml(o.contact_email)}</dd>` : ''}
      </dl>
      ${responsables.length ? `
        <hr style="border:0;border-top:1px solid var(--card-border);margin:14px 0;" />
        <strong style="font-size:13px;color:var(--ivory);">Direction</strong>
        <div class="app-list" style="margin-top:8px;">
          ${responsables.map((m) => `
            <div class="app-row" style="padding:8px 10px;">
              <span class="app-row-main"><strong>${escapeHtml(m.display_name)}</strong>
                <small>${escapeHtml(m.grade_label || (m.member_role === 'owner' ? 'Propriétaire' : 'Direction'))}</small></span>
            </div>`).join('')}
        </div>` : ''}
    `);
  }

  function panneau(titre, html) {
    document.getElementById('np-panel')?.remove();
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.id = 'np-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(titre)}</strong>
        <button class="btn btn-ghost" id="np-close" style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">${html}</div>`;
    document.querySelector('.app-frame').appendChild(el);
    document.getElementById('np-close').addEventListener('click', () => el.remove());
  }

  const champ = document.getElementById('np-q');
  let minuteur = null;
  champ?.addEventListener('input', () => {
    clearTimeout(minuteur);
    minuteur = setTimeout(() => { recherche = champ.value; dessiner(); }, 200);
  });

  await charger();
}

// ============================================================================
// Vitrines — Dynasty, Concess Luxury, Vangelico (et les suivantes)
// ============================================================================
// Un seul écran pour les trois applications. Une agence immobilière, une
// concession et une joaillerie exposent un catalogue et reçoivent des demandes
// de rendez-vous : c'est le même métier vu sous trois angles. Ce qui change —
// le vocabulaire, les catégories, le type de rendez-vous — est une donnée, pas
// du code : les catégories viennent de la base et se modifient depuis
// l'administration, et `app_registry.is_showcase` suffit à ouvrir une
// quatrième vitrine sans redéploiement.
//
// §90 : le prix est affiché, aucun paiement n'est encaissé ici. Le rendez-vous
// est pris dans Newpad, l'affaire se conclut en jeu.

import { renderAppShell } from '../appShell.js';
import { escapeHtml, formatDateTime, formatMoney } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { supabase } from '../../lib/supabaseClient.js';
import { contentStats, trackView } from '../../lib/engagement.js';
import { engagementBarHtml, wireEngagement } from '../../components/engagementBar.js';
import { myOrganizations } from '../organizations/api.js';

const ENTITE = 'catalog_item';

// Le vocabulaire de chaque vitrine. Une vitrine inconnue retombe sur le
// vocabulaire neutre : elle fonctionne quand même, dès sa création en base.
const PAROLES = {
  dynasty: {
    objet: 'bien', objets: 'biens', catalogue: 'Portefeuille',
    demandes: [['visit', 'Visiter le bien'], ['info', 'Demander des informations'],
               ['reserve', 'Poser une option']],
    vide: 'Aucun bien au portefeuille pour le moment.',
  },
  luxury: {
    objet: 'véhicule', objets: 'véhicules', catalogue: 'Showroom',
    demandes: [['test', 'Réserver un essai'], ['info', 'Demander des informations'],
               ['reserve', 'Réserver le véhicule']],
    vide: 'Aucun véhicule au showroom pour le moment.',
  },
  vangelico: {
    objet: 'pièce', objets: 'pièces', catalogue: 'Collection',
    demandes: [['visit', 'Voir la pièce en boutique'], ['estimate', 'Demander une estimation'],
               ['reserve', 'Réserver la pièce']],
    vide: 'Aucune pièce en collection pour le moment.',
  },
  _defaut: {
    objet: 'article', objets: 'articles', catalogue: 'Catalogue',
    demandes: [['visit', 'Prendre rendez-vous'], ['info', 'Demander des informations'],
               ['reserve', 'Réserver']],
    vide: 'Catalogue vide pour le moment.',
  },
};

const KIND_LABEL = {
  visit: 'Visite', test: 'Essai', info: 'Renseignement',
  reserve: 'Réservation', estimate: 'Estimation',
};
const STATUT_LABEL = {
  draft: 'Brouillon', available: 'Disponible', reserved: 'Réservé', sold: 'Vendu',
  archived: 'Retiré', pending: 'En attente', accepted: 'Acceptée', declined: 'Refusée',
  done: 'Clôturée', cancelled: 'Annulée',
};

export async function renderShowcaseApp(root, profile, slug) {
  const mots = PAROLES[slug] || PAROLES._defaut;
  let vue = 'catalogue';
  let sousType = '';
  let maison = '';
  let recherche = '';
  let categories = [];
  let mesOrgs = [];
  let orgActive = '';

  if (profile) {
    try { mesOrgs = await myOrganizations(); } catch (_) { mesOrgs = []; }
    orgActive = mesOrgs.length ? mesOrgs[0].id : '';
  }
  try {
    const { data } = await supabase.rpc('catalog_subtypes_list', { p_app_slug: slug });
    categories = data || [];
  } catch (_) { categories = []; }

  const onglets = [{ key: 'catalogue', label: mots.catalogue }];
  if (profile) onglets.push({ key: 'demandes', label: 'Mes demandes' });
  if (mesOrgs.length) onglets.push({ key: 'gestion', label: 'Gestion' });

  const { body } = await renderAppShell(root, profile, slug, {
    tabs: onglets,
    active: vue,
    onTab: (k) => { vue = k; marquer(); rendre(); },
  });

  function marquer() {
    document.querySelectorAll('.app-tab').forEach((t) => {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === vue);
    });
  }

  async function rendre() {
    if (vue === 'catalogue') return catalogue();
    if (vue === 'demandes') return mesDemandes();
    return gestion();
  }

  // --------------------------------------------------------------------------
  // Le catalogue
  // --------------------------------------------------------------------------
  async function catalogue() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let fiches = []; let maisons = [];
    try {
      const [f, m] = await Promise.all([
        supabase.rpc('catalog_feed', {
          p_app_slug: slug, p_subtype: sousType || null, p_search: recherche || null,
          p_organization_id: maison || null, p_limit: 60,
        }),
        supabase.rpc('catalog_houses', { p_app_slug: slug }),
      ]);
      if (f.error) throw f.error;
      fiches = f.data || [];
      maisons = m.data || [];
    } catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    const stats = await contentStats(ENTITE, fiches.map((f) => f.id));

    body.innerHTML = `
      <div class="app-toolbar">
        <input id="vt-q" placeholder="Rechercher" value="${escapeHtml(recherche)}"
               style="flex:1;min-width:150px;margin:0;" />
        ${categories.length ? `<select id="vt-cat" style="margin:0;max-width:170px;">
          <option value="">Toutes catégories</option>
          ${categories.map((c) => `<option value="${escapeHtml(c.code)}" ${c.code === sousType ? 'selected' : ''}>
            ${escapeHtml(c.label)}</option>`).join('')}
        </select>` : ''}
        ${maisons.length > 1 ? `<select id="vt-maison" style="margin:0;max-width:180px;">
          <option value="">Toutes les maisons</option>
          ${maisons.map((m) => `<option value="${m.organization_id}" ${m.organization_id === maison ? 'selected' : ''}>
            ${escapeHtml(m.name)} (${m.nb})</option>`).join('')}
        </select>` : ''}
      </div>
      ${fiches.length
        ? `<div class="vt-grid">${fiches.map((f) => carte(f, stats[f.id])).join('')}</div>`
        : `<div class="app-empty">${escapeHtml(mots.vide)}</div>`}
    `;

    const champ = document.getElementById('vt-q');
    let minuteur = null;
    champ.addEventListener('input', () => {
      clearTimeout(minuteur);
      minuteur = setTimeout(() => { recherche = champ.value; catalogue(); }, 300);
    });
    document.getElementById('vt-cat')?.addEventListener('change', (e) => { sousType = e.target.value; catalogue(); });
    document.getElementById('vt-maison')?.addEventListener('change', (e) => { maison = e.target.value; catalogue(); });

    body.querySelectorAll('[data-fiche]').forEach((c) => {
      c.addEventListener('click', () => fiche(c.getAttribute('data-fiche')));
    });
  }

  function prixTexte(f) {
    if (f.price_label) return escapeHtml(f.price_label);
    if (f.price === null || f.price === undefined) return 'Prix sur demande';
    return formatMoney(f.price);
  }

  function specsLignes(specs) {
    const entrees = Object.entries(specs || {}).slice(0, 12);
    if (!entrees.length) return '';
    return `<dl class="vt-specs">${entrees.map(([k, v]) =>
      `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join('')}</dl>`;
  }

  function carte(f, s) {
    return `
      <article class="vt-card ${f.is_featured ? 'is-featured' : ''}" data-fiche="${f.id}">
        <div class="vt-photo">${f.photo
          ? `<img src="${escapeHtml(f.photo)}" alt="" loading="lazy" />`
          : '<span class="vt-photo-vide">Sans visuel</span>'}
          ${f.status === 'reserved' ? '<span class="vt-flag">Réservé</span>' : ''}
          ${f.is_featured ? '<span class="vt-flag vt-flag-or">Coup de cœur</span>' : ''}
        </div>
        <div class="vt-card-body">
          <div class="vt-price">${prixTexte(f)}</div>
          <div class="vt-title">${escapeHtml(f.title)}</div>
          <div class="vt-meta">
            ${f.subtype_label ? `<span class="badge badge-neutral">${escapeHtml(f.subtype_label)}</span>` : ''}
            ${f.location ? `<span>${escapeHtml(f.location)}</span>` : ''}
          </div>
          <div class="vt-house">${escapeHtml(f.org_name)}
            · <span class="muted">${(s && s.vues) || 0} vue${((s && s.vues) || 0) > 1 ? 's' : ''}</span></div>
        </div>
      </article>`;
  }

  // --------------------------------------------------------------------------
  // La fiche
  // --------------------------------------------------------------------------
  async function fiche(id) {
    let f;
    try {
      const { data, error } = await supabase.rpc('catalog_item', { p_id: id });
      if (error) throw error;
      f = data;
    } catch (e) { await showAlert(String(e.message || e)); return; }

    trackView(slug, ENTITE, id);
    const stats = await contentStats(ENTITE, [id]);
    const enCours = f.my_request && ['pending', 'accepted'].includes(f.my_request.status);

    panneau(f.title, `
      ${(f.photos || []).length
        ? `<div class="vt-gallery">${f.photos.map((u) =>
            `<img src="${escapeHtml(u)}" alt="" loading="lazy" />`).join('')}</div>` : ''}
      <div class="vt-fiche-price">${prixTexte(f)}</div>
      <div class="vt-meta" style="margin-bottom:12px;">
        ${f.subtype_label ? `<span class="badge badge-neutral">${escapeHtml(f.subtype_label)}</span>` : ''}
        ${f.status === 'reserved' ? '<span class="badge badge-pending">Réservé</span>' : ''}
        ${f.status === 'sold' ? '<span class="badge badge-neutral">Vendu</span>' : ''}
      </div>
      ${specsLignes(f.specs)}
      <p style="font-size:13px;line-height:1.6;white-space:pre-wrap;margin:12px 0;">${escapeHtml(f.description)}</p>
      <div class="muted" style="font-size:12.5px;margin-bottom:14px;">
        ${escapeHtml(f.org_name)}${f.location ? ' · ' + escapeHtml(f.location) : ''}
        ${f.org_phone ? ' · ' + escapeHtml(f.org_phone) : ''}
      </div>

      ${f.can_edit ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-ghost" id="vt-edit" style="flex:1;">Modifier</button>
          <button class="btn btn-primary" id="vt-sold" style="flex:1;">Marquer vendu</button>
        </div>`
      : !profile ? '<div class="np-note">Créez un compte Newman Bank pour contacter la maison.</div>'
      : enCours ? `
        <div class="np-note" style="margin-bottom:10px;">
          ${KIND_LABEL[f.my_request.kind] || 'Demande'} — ${STATUT_LABEL[f.my_request.status]}
          ${f.my_request.scheduled_at ? '<br />Rendez-vous : ' + formatDateTime(f.my_request.scheduled_at) : ''}
        </div>
        <button class="btn btn-ghost" id="vt-cancel" style="width:100%;">Annuler ma demande</button>`
      : f.status === 'available' ? `
        <div class="field"><label for="vt-kind">Votre demande</label>
          <select id="vt-kind">${mots.demandes.map(([v, l]) =>
            `<option value="${v}">${l}</option>`).join('')}</select></div>
        <div class="field"><label for="vt-when">Créneau souhaité (facultatif)</label>
          <input id="vt-when" type="datetime-local" /></div>
        <div class="field"><label for="vt-msg">Message</label>
          <textarea id="vt-msg" rows="3" maxlength="1000" placeholder="Bonjour, je suis intéressé…"></textarea></div>
        <button class="btn btn-primary" id="vt-send" style="width:100%;">Envoyer la demande</button>
        <div class="muted" style="font-size:11.5px;margin-top:8px;">
          Newpad fixe le rendez-vous, il n’encaisse aucun paiement.
        </div>`
      : '<div class="np-note">Ce ' + escapeHtml(mots.objet) + ' n’est plus disponible.</div>'}

      <div id="eng-fiche" style="margin-top:16px;">${engagementBarHtml(stats[id])}</div>
    `, () => {
      wireEngagement(document.getElementById('eng-fiche'), ENTITE, id, profile);

      document.getElementById('vt-send')?.addEventListener('click', async () => {
        const quand = document.getElementById('vt-when').value;
        try {
          const { error } = await supabase.rpc('catalog_request', {
            p_item_id: id,
            p_kind: document.getElementById('vt-kind').value,
            p_message: document.getElementById('vt-msg').value,
            p_preferred_at: quand ? new Date(quand).toISOString() : null,
          });
          if (error) throw error;
          fermerPanneau();
          await showAlert('Demande envoyée. La maison vous répondra dans Newpad.');
        } catch (e) { await showAlert(String(e.message || e)); }
      });

      document.getElementById('vt-cancel')?.addEventListener('click', async () => {
        try {
          const { error } = await supabase.rpc('catalog_decide_request', {
            p_request_id: f.my_request.id, p_decision: 'cancelled', p_scheduled_at: null,
          });
          if (error) throw error;
          fermerPanneau(); fiche(id);
        } catch (e) { await showAlert(String(e.message || e)); }
      });

      document.getElementById('vt-edit')?.addEventListener('click', () => editeur(f));
      document.getElementById('vt-sold')?.addEventListener('click', async () => {
        if (!(await showConfirm('Marquer comme vendu ? Les demandes en attente seront closes.'))) return;
        try {
          const { error } = await supabase.rpc('catalog_set_status', {
            p_id: id, p_status: 'sold', p_featured: null,
          });
          if (error) throw error;
          fermerPanneau(); rendre();
        } catch (e) { await showAlert(String(e.message || e)); }
      });
    });
  }

  // --------------------------------------------------------------------------
  // Mes demandes (côté client)
  // --------------------------------------------------------------------------
  async function mesDemandes() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let lignes = [];
    try {
      const { data, error } = await supabase.rpc('catalog_my_requests', { p_app_slug: slug });
      if (error) throw error;
      lignes = data || [];
    } catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    body.innerHTML = lignes.length ? `<div class="app-list">${lignes.map((r) => `
      <div class="app-row" data-ouvrir="${r.item_id}" style="cursor:pointer;">
        <span class="app-row-main">
          <strong>${escapeHtml(r.item_title)}</strong>
          <small>${escapeHtml(r.org_name)} · ${KIND_LABEL[r.kind] || r.kind}
            ${r.scheduled_at ? ' · rendez-vous ' + formatDateTime(r.scheduled_at) : ''}</small>
        </span>
        <span class="badge ${r.status === 'accepted' ? 'badge-success'
          : r.status === 'pending' ? 'badge-pending' : 'badge-neutral'}">${STATUT_LABEL[r.status] || r.status}</span>
      </div>`).join('')}</div>`
      : '<div class="app-empty">Aucune demande en cours.</div>';

    body.querySelectorAll('[data-ouvrir]').forEach((r) => {
      r.addEventListener('click', () => fiche(r.getAttribute('data-ouvrir')));
    });
  }

  // --------------------------------------------------------------------------
  // Gestion (côté maison)
  // --------------------------------------------------------------------------
  async function gestion() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let fiches = []; let demandes = [];
    try {
      const [i, r] = await Promise.all([
        supabase.rpc('catalog_org_items', { p_app_slug: slug, p_organization_id: orgActive }),
        supabase.rpc('catalog_org_requests', { p_app_slug: slug, p_organization_id: orgActive }),
      ]);
      if (i.error) throw i.error;
      fiches = i.data || [];
      demandes = r.data || [];
    } catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    body.innerHTML = `
      <div class="app-toolbar">
        ${mesOrgs.length > 1 ? `<select id="vt-org" style="margin:0;max-width:220px;">
          ${mesOrgs.map((o) => `<option value="${o.id}" ${o.id === orgActive ? 'selected' : ''}>
            ${escapeHtml(o.name)}</option>`).join('')}</select>` : ''}
        <button class="btn btn-primary" id="vt-new" style="padding:6px 14px;font-size:13px;">
          + Ajouter un${mots.objet === 'pièce' ? 'e' : ''} ${escapeHtml(mots.objet)}</button>
      </div>

      <h3 class="vt-section">Demandes reçues</h3>
      ${demandes.length ? `<div class="app-list">${demandes.map((d) => `
        <div class="app-row" style="align-items:flex-start;">
          <span class="app-row-main">
            <strong>${escapeHtml(d.requester_name)} — ${escapeHtml(d.item_title)}</strong>
            <small>${KIND_LABEL[d.kind] || d.kind} · ${formatDateTime(d.created_at)}
              ${d.preferred_at ? ' · souhaité ' + formatDateTime(d.preferred_at) : ''}
              ${d.scheduled_at ? ' · fixé ' + formatDateTime(d.scheduled_at) : ''}</small>
            ${d.message ? `<span style="font-size:12.5px;margin-top:4px;">${escapeHtml(d.message)}</span>` : ''}
          </span>
          ${d.status === 'pending' ? `
            <span style="display:flex;gap:6px;flex-wrap:wrap;">
              <button class="btn btn-primary" data-ok="${d.id}" style="padding:3px 10px;font-size:12px;">Accepter</button>
              <button class="btn btn-ghost" data-no="${d.id}" style="padding:3px 10px;font-size:12px;">Refuser</button>
            </span>`
          : d.status === 'accepted' ? `
            <button class="btn btn-ghost" data-done="${d.id}" style="padding:3px 10px;font-size:12px;">Clôturer</button>`
          : `<span class="badge badge-neutral">${STATUT_LABEL[d.status] || d.status}</span>`}
        </div>`).join('')}</div>`
        : '<div class="muted" style="font-size:12.5px;">Aucune demande reçue.</div>'}

      <h3 class="vt-section">${escapeHtml(mots.catalogue)} (${fiches.length})</h3>
      ${fiches.length ? `<div class="app-list">${fiches.map((f) => `
        <div class="app-row">
          <span class="app-row-main" data-ouvrir="${f.id}" style="cursor:pointer;">
            <strong>${escapeHtml(f.title)}${f.is_featured ? ' ★' : ''}</strong>
            <small>${f.price !== null ? formatMoney(f.price) : 'prix sur demande'}
              · ${formatDateTime(f.created_at)}</small>
          </span>
          ${Number(f.requests_pending) > 0
            ? `<span class="badge badge-pending">${f.requests_pending} demande${Number(f.requests_pending) > 1 ? 's' : ''}</span>`
            : ''}
          <button class="btn btn-ghost" data-star="${f.id}" data-on="${f.is_featured ? '1' : '0'}"
                  style="padding:3px 9px;font-size:12px;">${f.is_featured ? 'Retirer ★' : 'Mettre ★'}</button>
          <span class="badge ${f.status === 'available' ? 'badge-success' : 'badge-neutral'}">
            ${STATUT_LABEL[f.status] || f.status}</span>
        </div>`).join('')}</div>`
        : `<div class="muted" style="font-size:12.5px;">${escapeHtml(mots.vide)}</div>`}
    `;

    document.getElementById('vt-org')?.addEventListener('change', (e) => { orgActive = e.target.value; gestion(); });
    document.getElementById('vt-new').addEventListener('click', () => editeur(null));
    body.querySelectorAll('[data-ouvrir]').forEach((r) => {
      r.addEventListener('click', () => fiche(r.getAttribute('data-ouvrir')));
    });
    body.querySelectorAll('[data-star]').forEach((b) => {
      b.addEventListener('click', async () => {
        try {
          const { error } = await supabase.rpc('catalog_set_status', {
            p_id: b.getAttribute('data-star'),
            p_status: (fiches.find((f) => f.id === b.getAttribute('data-star')) || {}).status || 'available',
            p_featured: b.getAttribute('data-on') !== '1',
          });
          if (error) throw error;
          gestion();
        } catch (e) { await showAlert(String(e.message || e)); }
      });
    });
    body.querySelectorAll('[data-ok],[data-no],[data-done]').forEach((b) => {
      b.addEventListener('click', async () => {
        const id = b.getAttribute('data-ok') || b.getAttribute('data-no') || b.getAttribute('data-done');
        const decision = b.hasAttribute('data-ok') ? 'accepted'
          : b.hasAttribute('data-no') ? 'declined' : 'done';
        let rdv = null;
        if (decision === 'accepted') { rdv = await demanderCreneau(); if (rdv === false) return; }
        try {
          const { error } = await supabase.rpc('catalog_decide_request', {
            p_request_id: id, p_decision: decision, p_scheduled_at: rdv,
          });
          if (error) throw error;
          gestion();
        } catch (e) { await showAlert(String(e.message || e)); }
      });
    });
  }

  // Un rendez-vous se fixe à une date : on la demande au moment d'accepter,
  // sans imposer d'en saisir une (une demande de renseignement n'en a pas).
  function demanderCreneau() {
    return new Promise((resolve) => {
      panneau('Fixer le rendez-vous', `
        <div class="field"><label for="vt-rdv">Date et heure (facultatif)</label>
          <input id="vt-rdv" type="datetime-local" /></div>
        <button class="btn btn-primary" id="vt-rdv-ok" style="width:100%;">Confirmer l’acceptation</button>
        <button class="btn btn-ghost" id="vt-rdv-no" style="width:100%;margin-top:8px;">Annuler</button>
      `, () => {
        document.getElementById('vt-rdv-ok').addEventListener('click', () => {
          const v = document.getElementById('vt-rdv').value;
          fermerPanneau();
          resolve(v ? new Date(v).toISOString() : null);
        });
        document.getElementById('vt-rdv-no').addEventListener('click', () => { fermerPanneau(); resolve(false); });
      });
    });
  }

  // --------------------------------------------------------------------------
  // Éditeur de fiche
  // --------------------------------------------------------------------------
  function editeur(existante) {
    const f = existante || {};
    const specs = Object.entries(f.specs || {});
    const orgFiche = f.organization_id || orgActive;

    panneau(existante ? 'Modifier la fiche' : 'Nouvelle fiche', `
      <div class="field"><label for="vt-t">Titre</label>
        <input id="vt-t" maxlength="140" value="${escapeHtml(f.title || '')}" /></div>
      <div class="field"><label for="vt-d">Description</label>
        <textarea id="vt-d" rows="5" maxlength="8000">${escapeHtml(f.description || '')}</textarea></div>
      <div style="display:flex;gap:10px;">
        <div class="field" style="flex:1;"><label for="vt-st">Catégorie</label>
          <select id="vt-st"><option value="">—</option>${categories.map((c) =>
            `<option value="${escapeHtml(c.code)}" ${c.code === f.subtype ? 'selected' : ''}>${escapeHtml(c.label)}</option>`).join('')}</select></div>
        <div class="field" style="flex:1;"><label for="vt-p">Prix</label>
          <input id="vt-p" type="number" min="0" step="1" value="${f.price !== null && f.price !== undefined ? f.price : ''}" /></div>
      </div>
      <div class="field"><label for="vt-pl">ou mention de prix</label>
        <input id="vt-pl" maxlength="40" value="${escapeHtml(f.price_label || '')}" placeholder="Sur demande, enchère…" /></div>
      <div class="field"><label for="vt-loc">Emplacement</label>
        <input id="vt-loc" maxlength="120" value="${escapeHtml(f.location || '')}" /></div>
      <div class="field"><label for="vt-ph">Visuels (une adresse par ligne, 10 maximum)</label>
        <textarea id="vt-ph" rows="3" placeholder="https://…">${escapeHtml((f.photos || []).join('\n'))}</textarea></div>
      <div class="field"><label for="vt-sp">Caractéristiques (une par ligne : nom = valeur)</label>
        <textarea id="vt-sp" rows="4" placeholder="Puissance = 480 ch">${escapeHtml(specs.map(([k, v]) => `${k} = ${v}`).join('\n'))}</textarea></div>
      <button class="btn btn-primary" id="vt-save" style="width:100%;">${existante ? 'Enregistrer' : 'Publier la fiche'}</button>
      ${existante ? '<button class="btn btn-ghost" id="vt-arch" style="width:100%;margin-top:8px;">Retirer de la vitrine</button>' : ''}
      <div class="muted" id="vt-msg" style="font-size:12.5px;margin-top:10px;"></div>
    `, () => {
      document.getElementById('vt-save').addEventListener('click', async () => {
        const msg = document.getElementById('vt-msg');
        const prix = document.getElementById('vt-p').value;
        const photos = document.getElementById('vt-ph').value
          .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 10);
        const caract = {};
        document.getElementById('vt-sp').value.split('\n').forEach((ligne) => {
          const i = ligne.indexOf('=');
          if (i > 0) {
            const cle = ligne.slice(0, i).trim();
            const val = ligne.slice(i + 1).trim();
            if (cle && val) caract[cle] = val;
          }
        });
        msg.textContent = 'Enregistrement…';
        try {
          const { error } = await supabase.rpc('catalog_save_item', {
            p_app_slug: slug,
            p_organization_id: orgFiche,
            p_title: document.getElementById('vt-t').value,
            p_description: document.getElementById('vt-d').value,
            p_id: existante ? f.id : null,
            p_subtype: document.getElementById('vt-st').value,
            p_price: prix === '' ? null : Number(prix),
            p_price_label: document.getElementById('vt-pl').value,
            p_location: document.getElementById('vt-loc').value,
            p_photos: photos,
            p_specs: caract,
          });
          if (error) throw error;
          fermerPanneau();
          vue = 'gestion'; marquer(); rendre();
        } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
      });

      document.getElementById('vt-arch')?.addEventListener('click', async () => {
        if (!(await showConfirm('Retirer cette fiche de la vitrine ?'))) return;
        try {
          const { error } = await supabase.rpc('catalog_set_status', {
            p_id: f.id, p_status: 'archived', p_featured: null,
          });
          if (error) throw error;
          fermerPanneau(); vue = 'gestion'; marquer(); rendre();
        } catch (e) { await showAlert(String(e.message || e)); }
      });
    });
  }

  // --------------------------------------------------------------------------
  function panneau(titre, html, apres) {
    fermerPanneau();
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.id = 'vt-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(titre)}</strong>
        <button class="btn btn-ghost" id="vt-close" style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">${html}</div>`;
    document.querySelector('.app-frame').appendChild(el);
    document.getElementById('vt-close').addEventListener('click', fermerPanneau);
    if (apres) apres();
  }

  function fermerPanneau() { document.getElementById('vt-panel')?.remove(); }

  await rendre();
}

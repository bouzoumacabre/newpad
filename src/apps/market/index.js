// ============================================================================
// NewMarket — les petites annonces de la ville
// ============================================================================
// Un principe, et il tient en une phrase : NewMarket met en relation, il
// n'encaisse pas. Le prix affiché est une ANNONCE de prix ; l'échange se
// conclut en roleplay, et s'il passe par un virement, il passe par Newman
// Bank. Aucune monnaie du jeu n'entre ici (§90).
//
// « Réservée » plutôt que « vendue » quand le vendeur accepte une proposition :
// c'est encore lui qui vient dire que l'affaire est faite. Newpad ne décide
// pas à la place des joueurs de ce qui s'est passé sur le parking.

import { renderAppShell } from '../appShell.js';
import { escapeHtml, formatDateTime, formatMoney } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { supabase } from '../../lib/supabaseClient.js';
import { contentStats, trackView } from '../../lib/engagement.js';
import { engagementBarHtml, wireEngagement } from '../../components/engagementBar.js';
import { myOrganizations } from '../organizations/api.js';

const ENTITE = 'market_listing';

const CATEGORIES = [
  ['vehicule', 'Véhicules'], ['immobilier', 'Immobilier'], ['materiel', 'Matériel'],
  ['vetement', 'Vêtements'], ['bijou', 'Bijoux'], ['arme', 'Armurerie'],
  ['service', 'Services'], ['emploi', 'Petits boulots'], ['alimentaire', 'Alimentaire'],
  ['collection', 'Collection'], ['divers', 'Divers'],
];
const ETATS = [
  ['neuf', 'Neuf'], ['bon', 'Bon état'], ['usage', 'Usagé'],
  ['pieces', 'Pour pièces'], ['service', 'Prestation'],
];

const libelle = (liste, cle) => (liste.find((c) => c[0] === cle) || [null, cle])[1];

export async function renderMarketApp(root, profile) {
  let vue = 'feed';
  let categorie = '';
  let recherche = '';

  const onglets = [{ key: 'feed', label: 'Annonces' }];
  if (profile) {
    onglets.push({ key: 'mine', label: 'Mes annonces' });
    onglets.push({ key: 'offers', label: 'Mes propositions' });
  }

  const { body } = await renderAppShell(root, profile, 'market', {
    tabs: onglets,
    active: vue,
    onTab: (k) => { vue = k; marquer(); rendre(); },
    actions: profile
      ? '<button class="btn btn-primary" id="nm-new" style="padding:6px 14px;font-size:13px;">+ Déposer</button>'
      : '',
  });

  function marquer() {
    document.querySelectorAll('.app-tab').forEach((t) => {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === vue);
    });
  }

  async function rendre() {
    if (vue === 'feed') return fil();
    if (vue === 'mine') return mesAnnonces();
    return mesPropositions();
  }

  // --------------------------------------------------------------------------
  // Le fil
  // --------------------------------------------------------------------------
  async function fil() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let annonces = [];
    try {
      const { data, error } = await supabase.rpc('market_feed', {
        p_category: categorie || null, p_search: recherche || null, p_limit: 60,
      });
      if (error) throw error;
      annonces = data || [];
    } catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    const stats = await contentStats(ENTITE, annonces.map((a) => a.id));

    body.innerHTML = `
      <div class="app-toolbar">
        <input id="nm-q" placeholder="Rechercher une annonce" value="${escapeHtml(recherche)}"
               style="flex:1;min-width:180px;margin:0;" />
        <select id="nm-cat" style="margin:0;max-width:170px;">
          <option value="">Toutes catégories</option>
          ${CATEGORIES.map(([v, l]) => `<option value="${v}" ${v === categorie ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      ${annonces.length
        ? `<div class="nm-grid">${annonces.map((a) => carte(a, stats[a.id])).join('')}</div>`
        : '<div class="app-empty">Aucune annonce pour le moment.</div>'}
    `;

    const champ = document.getElementById('nm-q');
    let minuteur = null;
    champ.addEventListener('input', () => {
      clearTimeout(minuteur);
      minuteur = setTimeout(() => { recherche = champ.value; fil(); }, 300);
    });
    document.getElementById('nm-cat').addEventListener('change', (e) => {
      categorie = e.target.value; fil();
    });

    body.querySelectorAll('[data-annonce]').forEach((c) => {
      c.addEventListener('click', () => fiche(c.getAttribute('data-annonce')));
    });
  }

  function prixTexte(a) {
    if (a.price_label) return escapeHtml(a.price_label);
    if (a.price === null || a.price === undefined) return 'Prix à débattre';
    return formatMoney(a.price);
  }

  function carte(a, s) {
    return `
      <article class="nm-card" data-annonce="${a.id}">
        <div class="nm-photo">${a.photo
          ? `<img src="${escapeHtml(a.photo)}" alt="" loading="lazy" />`
          : '<span class="nm-photo-vide">Pas de photo</span>'}
          ${a.status === 'reserved' ? '<span class="nm-flag">Réservée</span>' : ''}
        </div>
        <div class="nm-card-body">
          <div class="nm-price">${prixTexte(a)}</div>
          <div class="nm-title">${escapeHtml(a.title)}</div>
          <div class="nm-meta">
            <span class="badge badge-neutral">${escapeHtml(libelle(CATEGORIES, a.category))}</span>
            ${a.location ? `<span>${escapeHtml(a.location)}</span>` : ''}
          </div>
          <div class="nm-seller">${escapeHtml(a.org_name || a.seller_name)}
            · <span class="muted">${(s && s.vues) || 0} vue${((s && s.vues) || 0) > 1 ? 's' : ''}</span></div>
        </div>
      </article>`;
  }

  // --------------------------------------------------------------------------
  // La fiche d'une annonce
  // --------------------------------------------------------------------------
  async function fiche(id) {
    let a;
    try {
      const { data, error } = await supabase.rpc('market_listing', { p_id: id });
      if (error) throw error;
      a = data;
    } catch (e) { await showAlert(String(e.message || e)); return; }

    trackView('market', ENTITE, id);
    const stats = await contentStats(ENTITE, [id]);

    const offreEnCours = a.my_offer && a.my_offer.status === 'pending';
    panneau(a.title, `
      ${(a.photos || []).length
        ? `<div class="nm-gallery">${a.photos.map((u) =>
            `<img src="${escapeHtml(u)}" alt="" loading="lazy" />`).join('')}</div>`
        : ''}
      <div class="nm-fiche-price">${prixTexte(a)}</div>
      <div class="nm-meta" style="margin-bottom:12px;">
        <span class="badge badge-neutral">${escapeHtml(libelle(CATEGORIES, a.category))}</span>
        <span class="badge badge-neutral">${escapeHtml(libelle(ETATS, a.condition))}</span>
        ${a.status === 'reserved' ? '<span class="badge badge-pending">Réservée</span>' : ''}
        ${a.status === 'sold' ? '<span class="badge badge-neutral">Vendue</span>' : ''}
      </div>
      <p style="font-size:13px;line-height:1.6;white-space:pre-wrap;margin-bottom:12px;">${escapeHtml(a.description)}</p>
      <div class="muted" style="font-size:12.5px;margin-bottom:14px;">
        ${escapeHtml(a.org_name || a.seller_name)}
        ${a.location ? ' · ' + escapeHtml(a.location) : ''} · ${formatDateTime(a.bumped_at)}
      </div>

      ${a.is_mine ? `
        <div class="app-list" id="nm-offres"><div class="muted" style="font-size:12.5px;">Chargement des propositions…</div></div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
          <button class="btn btn-ghost" id="nm-edit" style="flex:1;">Modifier</button>
          <button class="btn btn-ghost" id="nm-bump" style="flex:1;">Remonter</button>
          <button class="btn btn-primary" id="nm-sold" style="flex:1;">Marquer vendue</button>
        </div>`
      : profile ? `
        ${offreEnCours ? `
          <div class="np-note" style="margin-bottom:10px;">
            Proposition envoyée${a.my_offer.proposed_price !== null
              ? ' — ' + formatMoney(a.my_offer.proposed_price) : ''}. En attente du vendeur.
          </div>
          <button class="btn btn-ghost" id="nm-withdraw" style="width:100%;">Retirer ma proposition</button>`
        : a.status === 'active' ? `
          <div class="field"><label for="nm-op">Votre proposition (facultatif)</label>
            <input id="nm-op" type="number" min="0" step="1" placeholder="Montant proposé" /></div>
          <div class="field"><label for="nm-om">Message au vendeur</label>
            <textarea id="nm-om" rows="3" maxlength="1000" placeholder="Bonjour, je suis intéressé…"></textarea></div>
          <button class="btn btn-primary" id="nm-offer" style="width:100%;">Envoyer la proposition</button>
          <div class="muted" style="font-size:11.5px;margin-top:8px;">
            Newpad ne gère aucun paiement : l'échange se conclut en jeu.
          </div>`
        : '<div class="np-note">Cette annonce n’est plus disponible.</div>'}
      ` : '<div class="np-note">Créez un compte Newman Bank pour contacter le vendeur.</div>'}

      <div id="eng-fiche" style="margin-top:16px;">${engagementBarHtml(stats[id])}</div>
    `, () => {
      wireEngagement(document.getElementById('eng-fiche'), ENTITE, id, profile);

      document.getElementById('nm-offer')?.addEventListener('click', async () => {
        const montant = document.getElementById('nm-op').value;
        try {
          const { error } = await supabase.rpc('market_make_offer', {
            p_listing_id: id,
            p_message: document.getElementById('nm-om').value,
            p_proposed_price: montant === '' ? null : Number(montant),
          });
          if (error) throw error;
          fermerPanneau();
          await showAlert('Proposition envoyée au vendeur.');
        } catch (e) { await showAlert(String(e.message || e)); }
      });

      document.getElementById('nm-withdraw')?.addEventListener('click', async () => {
        try {
          const { error } = await supabase.rpc('market_decide_offer', {
            p_offer_id: a.my_offer.id, p_decision: 'withdrawn',
          });
          if (error) throw error;
          fermerPanneau(); fiche(id);
        } catch (e) { await showAlert(String(e.message || e)); }
      });

      document.getElementById('nm-edit')?.addEventListener('click', () => composer(a));
      document.getElementById('nm-bump')?.addEventListener('click', async () => {
        try {
          const { error } = await supabase.rpc('market_bump', { p_id: id });
          if (error) throw error;
          fermerPanneau(); rendre();
        } catch (e) { await showAlert(String(e.message || e)); }
      });
      document.getElementById('nm-sold')?.addEventListener('click', async () => {
        if (!(await showConfirm('Marquer cette annonce comme vendue ? Les propositions en attente seront closes.'))) return;
        try {
          const { error } = await supabase.rpc('market_set_status', { p_id: id, p_status: 'sold' });
          if (error) throw error;
          fermerPanneau(); rendre();
        } catch (e) { await showAlert(String(e.message || e)); }
      });

      if (a.is_mine) chargerOffres(id);
    });
  }

  async function chargerOffres(id) {
    const zone = document.getElementById('nm-offres');
    if (!zone) return;
    let offres = [];
    try {
      const { data, error } = await supabase.rpc('market_listing_offers', { p_listing_id: id });
      if (error) throw error;
      offres = data || [];
    } catch (e) { zone.innerHTML = `<div class="muted" style="font-size:12.5px;">${escapeHtml(String(e.message || e))}</div>`; return; }

    if (!offres.length) {
      zone.innerHTML = '<div class="muted" style="font-size:12.5px;">Aucune proposition pour l’instant.</div>';
      return;
    }
    zone.innerHTML = offres.map((o) => `
      <div class="app-row" style="align-items:flex-start;">
        <span class="app-row-main">
          <strong>${escapeHtml(o.buyer_name)}</strong>
          <small>${o.proposed_price !== null ? formatMoney(o.proposed_price) + ' · ' : ''}${formatDateTime(o.created_at)}</small>
          ${o.message ? `<span style="font-size:12.5px;margin-top:4px;">${escapeHtml(o.message)}</span>` : ''}
        </span>
        ${o.status === 'pending' ? `
          <span style="display:flex;gap:6px;">
            <button class="btn btn-primary" data-ok="${o.id}" style="padding:3px 10px;font-size:12px;">Accepter</button>
            <button class="btn btn-ghost" data-no="${o.id}" style="padding:3px 10px;font-size:12px;">Refuser</button>
          </span>`
        : `<span class="badge ${o.status === 'accepted' ? 'badge-success' : 'badge-neutral'}">${
            o.status === 'accepted' ? 'Acceptée' : o.status === 'withdrawn' ? 'Retirée' : 'Refusée'}</span>`}
      </div>`).join('');

    zone.querySelectorAll('[data-ok],[data-no]').forEach((b) => {
      b.addEventListener('click', async () => {
        const offreId = b.getAttribute('data-ok') || b.getAttribute('data-no');
        const decision = b.hasAttribute('data-ok') ? 'accepted' : 'declined';
        try {
          const { error } = await supabase.rpc('market_decide_offer', { p_offer_id: offreId, p_decision: decision });
          if (error) throw error;
          chargerOffres(id);
        } catch (e) { await showAlert(String(e.message || e)); }
      });
    });
  }

  // --------------------------------------------------------------------------
  // Mes annonces / mes propositions
  // --------------------------------------------------------------------------
  async function mesAnnonces() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let lignes = [];
    try {
      const { data, error } = await supabase.rpc('market_my_listings');
      if (error) throw error;
      lignes = data || [];
    } catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    body.innerHTML = lignes.length ? `<div class="app-list">${lignes.map((l) => `
      <div class="app-row" data-ouvrir="${l.id}" style="cursor:pointer;">
        <span class="app-row-main">
          <strong>${escapeHtml(l.title)}</strong>
          <small>${libelle(CATEGORIES, l.category)} · ${l.price !== null ? formatMoney(l.price) : 'prix à débattre'}
            · ${formatDateTime(l.created_at)}</small>
        </span>
        ${Number(l.offers_pending) > 0
          ? `<span class="badge badge-pending">${l.offers_pending} proposition${Number(l.offers_pending) > 1 ? 's' : ''}</span>`
          : ''}
        <span class="badge ${l.status === 'active' ? 'badge-success' : 'badge-neutral'}">${etatLabel(l.status)}</span>
      </div>`).join('')}</div>`
      : '<div class="app-empty">Vous n’avez aucune annonce. Déposez-en une.</div>';

    body.querySelectorAll('[data-ouvrir]').forEach((r) => {
      r.addEventListener('click', () => fiche(r.getAttribute('data-ouvrir')));
    });
  }

  async function mesPropositions() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let lignes = [];
    try {
      const { data, error } = await supabase.rpc('market_my_offers');
      if (error) throw error;
      lignes = data || [];
    } catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    body.innerHTML = lignes.length ? `<div class="app-list">${lignes.map((o) => `
      <div class="app-row" data-ouvrir="${o.listing_id}" style="cursor:pointer;">
        <span class="app-row-main">
          <strong>${escapeHtml(o.listing_title)}</strong>
          <small>${escapeHtml(o.seller_name)}
            ${o.proposed_price !== null ? ' · ' + formatMoney(o.proposed_price) : ''}
            · ${formatDateTime(o.created_at)}</small>
        </span>
        <span class="badge ${o.status === 'accepted' ? 'badge-success'
          : o.status === 'pending' ? 'badge-pending' : 'badge-neutral'}">${etatLabel(o.status)}</span>
      </div>`).join('')}</div>`
      : '<div class="app-empty">Aucune proposition envoyée.</div>';

    body.querySelectorAll('[data-ouvrir]').forEach((r) => {
      r.addEventListener('click', () => fiche(r.getAttribute('data-ouvrir')));
    });
  }

  function etatLabel(s) {
    return { draft: 'Brouillon', active: 'En ligne', reserved: 'Réservée', sold: 'Vendue',
             archived: 'Retirée', pending: 'En attente', accepted: 'Acceptée',
             declined: 'Refusée', withdrawn: 'Retirée' }[s] || s;
  }

  // --------------------------------------------------------------------------
  // Déposer / modifier
  // --------------------------------------------------------------------------
  async function composer(existante) {
    let orgs = [];
    try { orgs = await myOrganizations(); } catch (_) { orgs = []; }
    const a = existante || {};

    panneau(existante ? 'Modifier l’annonce' : 'Déposer une annonce', `
      <div class="field"><label for="nm-t">Titre</label>
        <input id="nm-t" maxlength="120" value="${escapeHtml(a.title || '')}" placeholder="Ford Mustang 1969" /></div>
      <div class="field"><label for="nm-d">Description</label>
        <textarea id="nm-d" rows="5" maxlength="6000" placeholder="État, historique, conditions…">${escapeHtml(a.description || '')}</textarea></div>
      <div style="display:flex;gap:10px;">
        <div class="field" style="flex:1;"><label for="nm-c">Catégorie</label>
          <select id="nm-c">${CATEGORIES.map(([v, l]) =>
            `<option value="${v}" ${v === (a.category || 'divers') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field" style="flex:1;"><label for="nm-e">État</label>
          <select id="nm-e">${ETATS.map(([v, l]) =>
            `<option value="${v}" ${v === (a.condition || 'bon') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div style="display:flex;gap:10px;">
        <div class="field" style="flex:1;"><label for="nm-p">Prix demandé</label>
          <input id="nm-p" type="number" min="0" step="1" value="${a.price !== null && a.price !== undefined ? a.price : ''}" /></div>
        <div class="field" style="flex:1;"><label for="nm-pl">ou mention</label>
          <input id="nm-pl" maxlength="40" value="${escapeHtml(a.price_label || '')}" placeholder="À débattre, échange…" /></div>
      </div>
      <div class="field"><label for="nm-l">Lieu</label>
        <input id="nm-l" maxlength="80" value="${escapeHtml(a.location || '')}" placeholder="Vinewood, Sandy Shores…" /></div>
      <div class="field"><label for="nm-ph">Photos (une adresse par ligne, 6 maximum)</label>
        <textarea id="nm-ph" rows="3" placeholder="https://…">${escapeHtml((a.photos || []).join('\n'))}</textarea></div>
      ${orgs.length ? `<div class="field"><label for="nm-o">Vendre au nom de</label>
        <select id="nm-o"><option value="">Moi-même</option>${orgs.map((o) =>
          `<option value="${o.id}" ${o.id === a.organization_id ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('')}</select></div>` : ''}
      <button class="btn btn-primary" id="nm-save" style="width:100%;">${existante ? 'Enregistrer' : 'Publier l’annonce'}</button>
      ${existante ? '<button class="btn btn-ghost" id="nm-arch" style="width:100%;margin-top:8px;">Retirer l’annonce</button>' : ''}
      <div class="muted" id="nm-msg" style="font-size:12.5px;margin-top:10px;">
        Le prix affiché n’engage aucun paiement dans Newpad : la transaction se fait en jeu.
      </div>
    `, () => {
      document.getElementById('nm-save').addEventListener('click', async () => {
        const msg = document.getElementById('nm-msg');
        const prix = document.getElementById('nm-p').value;
        const photos = document.getElementById('nm-ph').value
          .split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 6);
        msg.textContent = 'Enregistrement…';
        try {
          const { error } = await supabase.rpc('market_save_listing', {
            p_title: document.getElementById('nm-t').value,
            p_description: document.getElementById('nm-d').value,
            p_id: existante ? a.id : null,
            p_category: document.getElementById('nm-c').value,
            p_condition: document.getElementById('nm-e').value,
            p_price: prix === '' ? null : Number(prix),
            p_price_label: document.getElementById('nm-pl').value,
            p_location: document.getElementById('nm-l').value,
            p_photos: photos,
            p_organization_id: document.getElementById('nm-o')?.value || null,
          });
          if (error) throw error;
          fermerPanneau();
          vue = 'mine'; marquer(); rendre();
        } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
      });

      document.getElementById('nm-arch')?.addEventListener('click', async () => {
        if (!(await showConfirm('Retirer cette annonce du fil ?'))) return;
        try {
          const { error } = await supabase.rpc('market_set_status', { p_id: a.id, p_status: 'archived' });
          if (error) throw error;
          fermerPanneau(); rendre();
        } catch (e) { await showAlert(String(e.message || e)); }
      });
    });
  }

  // --------------------------------------------------------------------------
  function panneau(titre, html, apres) {
    fermerPanneau();
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.id = 'nm-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(titre)}</strong>
        <button class="btn btn-ghost" id="nm-close" style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">${html}</div>`;
    document.querySelector('.app-frame').appendChild(el);
    document.getElementById('nm-close').addEventListener('click', fermerPanneau);
    if (apres) apres();
  }

  function fermerPanneau() { document.getElementById('nm-panel')?.remove(); }

  document.getElementById('nm-new')?.addEventListener('click', () => composer(null));

  await rendre();
}

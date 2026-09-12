// ============================================================================
// NewEvent — l'agenda de la ville
// ============================================================================
// Application « invité » : une affiche doit pouvoir circuler sans compte,
// c'est tout l'intérêt d'une affiche. Répondre présent, en revanche, suppose
// une identité — sinon le compteur ne veut plus rien dire.
//
// Comme partout ailleurs, l'organisateur est soit un joueur, soit une
// organisation déjà connue de Newpad (§12) : aucune notion d'« organisateur »
// n'est réinventée ici.

import { renderAppShell } from '../appShell.js';
import { escapeHtml, formatDateTime } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { supabase } from '../../lib/supabaseClient.js';
import { mountAdSlot } from '../../components/adSlot.js';
import { contentStats, trackView } from '../../lib/engagement.js';
import { engagementBarHtml, wireEngagement } from '../../components/engagementBar.js';
import { myOrganizations } from '../organizations/api.js';

const ENTITE = 'event';

const CATEGORIES = [
  ['soiree', 'Soirée'], ['concert', 'Concert'], ['sport', 'Sport'], ['course', 'Course'],
  ['business', 'Business'], ['vente', 'Vente'], ['ceremonie', 'Cérémonie'],
  ['caritatif', 'Caritatif'], ['autre', 'Autre'],
];
const libelle = (cle) => (CATEGORIES.find((c) => c[0] === cle) || [null, cle])[1];

// Un agenda se lit par jour, pas par horodatage. On regroupe donc les
// événements par date avant de les afficher.
function jourLabel(iso) {
  const d = new Date(iso);
  const aujourdhui = new Date();
  const demain = new Date(aujourdhui.getTime() + 86400000);
  const memeJour = (a, b) => a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (memeJour(d, aujourdhui)) return "Aujourd'hui";
  if (memeJour(d, demain)) return 'Demain';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}
function heureLabel(iso) {
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

export async function renderEventsApp(root, profile) {
  let vue = 'upcoming';
  let categorie = '';

  const onglets = [{ key: 'upcoming', label: 'À venir' }, { key: 'past', label: 'Passés' }];
  if (profile) onglets.push({ key: 'mine', label: 'Mon agenda' });

  const { body } = await renderAppShell(root, profile, 'events', {
    tabs: onglets,
    active: vue,
    onTab: (k) => { vue = k; marquer(); rendre(); },
    actions: profile
      ? '<button class="btn btn-primary" id="ne-new" style="padding:6px 14px;font-size:13px;">+ Organiser</button>'
      : '',
  });

  function marquer() {
    document.querySelectorAll('.app-tab').forEach((t) => {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === vue);
    });
  }

  async function rendre() {
    if (vue === 'mine') return monAgenda();
    return agenda();
  }

  // --------------------------------------------------------------------------
  async function agenda() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let events = [];
    try {
      const { data, error } = await supabase.rpc('event_feed', {
        p_scope: vue, p_category: categorie || null, p_limit: 60,
      });
      if (error) throw error;
      events = data || [];
    } catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    const stats = await contentStats(ENTITE, events.map((e) => e.id));

    // Regroupement par journée, dans l'ordre déjà rendu par la base.
    const jours = [];
    events.forEach((e) => {
      const cle = new Date(e.starts_at).toDateString();
      let groupe = jours.find((g) => g.cle === cle);
      if (!groupe) { groupe = { cle, label: jourLabel(e.starts_at), items: [] }; jours.push(groupe); }
      groupe.items.push(e);
    });

    body.innerHTML = `
      <div class="app-toolbar">
        <select id="ne-cat" style="margin:0;max-width:200px;">
          <option value="">Toutes les catégories</option>
          ${CATEGORIES.map(([v, l]) => `<option value="${v}" ${v === categorie ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
      </div>
      <div id="ad-zone"></div>
      ${jours.length ? jours.map((g) => `
        <section class="ne-jour">
          <h3 class="ne-jour-titre">${escapeHtml(g.label)}</h3>
          <div class="ne-liste">${g.items.map((e) => carte(e, stats[e.id])).join('')}</div>
        </section>`).join('')
        : `<div class="app-empty">${vue === 'past' ? 'Aucun événement passé.' : 'Aucun événement annoncé.'}</div>`}
    `;

    document.getElementById('ne-cat').addEventListener('change', (e) => {
      categorie = e.target.value; agenda();
    });
    mountAdSlot(document.getElementById('ad-zone'), 'events');

    body.querySelectorAll('[data-event]').forEach((c) => {
      c.addEventListener('click', () => fiche(c.getAttribute('data-event')));
    });
  }

  function carte(e, s) {
    const complet = e.capacity !== null && Number(e.going_count) >= e.capacity;
    return `
      <article class="ne-card ${e.is_featured ? 'is-featured' : ''}" data-event="${e.id}">
        <div class="ne-heure">${heureLabel(e.starts_at)}</div>
        <div class="ne-card-body">
          <div class="ne-titre">${escapeHtml(e.title)}
            ${e.status === 'cancelled' ? '<span class="badge badge-danger">Annulé</span>' : ''}
            ${e.is_featured ? '<span class="badge badge-success">À la une</span>' : ''}</div>
          <div class="ne-meta">
            <span class="badge badge-neutral">${escapeHtml(libelle(e.category))}</span>
            ${e.location ? `<span>${escapeHtml(e.location)}</span>` : ''}
            ${e.price_info ? `<span>${escapeHtml(e.price_info)}</span>` : ''}
          </div>
          <div class="ne-org">${escapeHtml(e.org_name || e.host_name)}
            · <span class="muted">${e.going_count} inscrit${Number(e.going_count) > 1 ? 's' : ''}${
              e.capacity !== null ? ' / ' + e.capacity : ''}${complet ? ' — complet' : ''}</span>
            · <span class="muted">${(s && s.vues) || 0} vue${((s && s.vues) || 0) > 1 ? 's' : ''}</span></div>
        </div>
        ${e.cover_url ? `<img class="ne-affiche" src="${escapeHtml(e.cover_url)}" alt="" loading="lazy" />` : ''}
      </article>`;
  }

  // --------------------------------------------------------------------------
  async function fiche(id) {
    let e;
    try {
      const { data, error } = await supabase.rpc('event_detail', { p_id: id });
      if (error) throw error;
      e = data;
    } catch (err) { await showAlert(String(err.message || err)); return; }

    trackView('events', ENTITE, id);
    const stats = await contentStats(ENTITE, [id]);
    const complet = e.capacity !== null && Number(e.going_count) >= e.capacity && e.my_rsvp !== 'going';

    panneau(e.title, `
      ${e.cover_url ? `<img class="ne-affiche-grande" src="${escapeHtml(e.cover_url)}" alt="" />` : ''}
      <div class="ne-fiche-date">${escapeHtml(jourLabel(e.starts_at))} · ${heureLabel(e.starts_at)}${
        e.ends_at ? ' → ' + heureLabel(e.ends_at) : ''}</div>
      <div class="ne-meta" style="margin-bottom:12px;">
        <span class="badge badge-neutral">${escapeHtml(libelle(e.category))}</span>
        ${e.status === 'cancelled' ? '<span class="badge badge-danger">Annulé</span>' : ''}
        ${e.price_info ? `<span class="badge badge-neutral">${escapeHtml(e.price_info)}</span>` : ''}
      </div>
      ${e.location ? `<div class="muted" style="font-size:12.5px;margin-bottom:8px;">${escapeHtml(e.location)}</div>` : ''}
      <p style="font-size:13px;line-height:1.6;white-space:pre-wrap;margin-bottom:12px;">${escapeHtml(e.description)}</p>
      <div class="muted" style="font-size:12.5px;margin-bottom:14px;">
        Organisé par ${escapeHtml(e.org_name || e.host_name)} ·
        ${e.going_count} inscrit${Number(e.going_count) > 1 ? 's' : ''}${e.capacity !== null ? ' / ' + e.capacity : ''} ·
        ${e.interested_count} intéressé${Number(e.interested_count) > 1 ? 's' : ''}
      </div>

      ${profile && e.status === 'published' ? `
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn ${e.my_rsvp === 'going' ? 'btn-ghost' : 'btn-primary'}" id="ne-going"
                  style="flex:1;" ${complet ? 'disabled' : ''}>
            ${e.my_rsvp === 'going' ? 'Je viens ✓' : complet ? 'Complet' : 'Je viens'}</button>
          <button class="btn ${e.my_rsvp === 'interested' ? 'btn-ghost' : 'btn-ghost'}" id="ne-int" style="flex:1;">
            ${e.my_rsvp === 'interested' ? 'Intéressé ✓' : 'Ça m’intéresse'}</button>
        </div>`
      : !profile ? '<div class="np-note">Connectez-vous pour vous inscrire à cet événement.</div>' : ''}

      ${e.can_edit ? `
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;">
          <button class="btn btn-ghost" id="ne-edit" style="flex:1;">Modifier</button>
          <button class="btn btn-ghost" id="ne-list" style="flex:1;">Inscrits</button>
          ${e.status !== 'cancelled'
            ? '<button class="btn btn-ghost" id="ne-cancel" style="flex:1;">Annuler</button>' : ''}
        </div>` : ''}

      <div id="eng-fiche" style="margin-top:16px;">${engagementBarHtml(stats[id])}</div>
    `, () => {
      wireEngagement(document.getElementById('eng-fiche'), ENTITE, id, profile);

      const repondre = async (reponse) => {
        try {
          const { error } = await supabase.rpc('event_rsvp', { p_event_id: id, p_rsvp: reponse });
          if (error) throw error;
          fermerPanneau(); fiche(id);
        } catch (err) { await showAlert(String(err.message || err)); }
      };
      document.getElementById('ne-going')?.addEventListener('click', () => repondre('going'));
      document.getElementById('ne-int')?.addEventListener('click', () => repondre('interested'));

      document.getElementById('ne-edit')?.addEventListener('click', () => composer(e));
      document.getElementById('ne-list')?.addEventListener('click', () => inscrits(id, e.title));
      document.getElementById('ne-cancel')?.addEventListener('click', async () => {
        if (!(await showConfirm('Annuler cet événement ? Les inscrits en seront avertis.'))) return;
        try {
          const { error } = await supabase.rpc('event_set_status', {
            p_id: id, p_status: 'cancelled', p_featured: null,
          });
          if (error) throw error;
          fermerPanneau(); rendre();
        } catch (err) { await showAlert(String(err.message || err)); }
      });
    });
  }

  async function inscrits(id, titre) {
    let lignes = [];
    try {
      const { data, error } = await supabase.rpc('event_attendees_list', { p_event_id: id });
      if (error) throw error;
      lignes = data || [];
    } catch (e) { await showAlert(String(e.message || e)); return; }

    panneau('Inscrits — ' + titre, lignes.length ? `<div class="app-list">${lignes.map((l) => `
      <div class="app-row">
        <span class="app-row-main"><strong>${escapeHtml(l.display_name)}</strong>
          <small>${formatDateTime(l.created_at)}</small></span>
        <span class="badge ${l.rsvp === 'going' ? 'badge-success' : 'badge-neutral'}">
          ${l.rsvp === 'going' ? 'Présent' : 'Intéressé'}</span>
      </div>`).join('')}</div>`
      : '<div class="muted" style="font-size:12.5px;">Personne pour l’instant.</div>');
  }

  // --------------------------------------------------------------------------
  async function monAgenda() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let lignes = [];
    try {
      const { data, error } = await supabase.rpc('event_mine');
      if (error) throw error;
      lignes = data || [];
    } catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    body.innerHTML = lignes.length ? `<div class="app-list">${lignes.map((l) => `
      <div class="app-row" data-ouvrir="${l.id}" style="cursor:pointer;">
        <span class="app-row-main">
          <strong>${escapeHtml(l.title)}</strong>
          <small>${formatDateTime(l.starts_at)} · ${l.going_count} inscrit${Number(l.going_count) > 1 ? 's' : ''}${
            l.capacity !== null ? ' / ' + l.capacity : ''}</small>
        </span>
        ${l.is_host ? '<span class="badge badge-neutral">Organisateur</span>'
          : `<span class="badge ${l.my_rsvp === 'going' ? 'badge-success' : 'badge-neutral'}">
              ${l.my_rsvp === 'going' ? 'Présent' : 'Intéressé'}</span>`}
        <span class="badge ${l.status === 'published' ? 'badge-success'
          : l.status === 'cancelled' ? 'badge-danger' : 'badge-neutral'}">${
          { draft: 'Brouillon', published: 'Publié', cancelled: 'Annulé', done: 'Terminé' }[l.status] || l.status}</span>
      </div>`).join('')}</div>`
      : '<div class="app-empty">Aucun événement à votre agenda.</div>';

    body.querySelectorAll('[data-ouvrir]').forEach((r) => {
      r.addEventListener('click', () => fiche(r.getAttribute('data-ouvrir')));
    });
  }

  // --------------------------------------------------------------------------
  // Le champ date est en heure locale : la base attend un horodatage complet.
  const versLocal = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  async function composer(existant) {
    let orgs = [];
    try { orgs = await myOrganizations(); } catch (_) { orgs = []; }
    const e = existant || {};

    panneau(existant ? 'Modifier l’événement' : 'Organiser un événement', `
      <div class="field"><label for="ne-t">Titre</label>
        <input id="ne-t" maxlength="120" value="${escapeHtml(e.title || '')}" placeholder="Soirée d’ouverture" /></div>
      <div class="field"><label for="ne-d">Description</label>
        <textarea id="ne-d" rows="5" maxlength="8000" placeholder="Programme, tenue, accès…">${escapeHtml(e.description || '')}</textarea></div>
      <div style="display:flex;gap:10px;">
        <div class="field" style="flex:1;"><label for="ne-s">Début</label>
          <input id="ne-s" type="datetime-local" value="${versLocal(e.starts_at)}" /></div>
        <div class="field" style="flex:1;"><label for="ne-f">Fin (facultatif)</label>
          <input id="ne-f" type="datetime-local" value="${versLocal(e.ends_at)}" /></div>
      </div>
      <div style="display:flex;gap:10px;">
        <div class="field" style="flex:1;"><label for="ne-c">Catégorie</label>
          <select id="ne-c">${CATEGORIES.map(([v, l]) =>
            `<option value="${v}" ${v === (e.category || 'autre') ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field" style="flex:1;"><label for="ne-cap">Places (facultatif)</label>
          <input id="ne-cap" type="number" min="1" step="1" value="${e.capacity !== null && e.capacity !== undefined ? e.capacity : ''}" /></div>
      </div>
      <div class="field"><label for="ne-l">Lieu</label>
        <input id="ne-l" maxlength="120" value="${escapeHtml(e.location || '')}" placeholder="Vinewood Hills" /></div>
      <div class="field"><label for="ne-pi">Tarif indicatif</label>
        <input id="ne-pi" maxlength="60" value="${escapeHtml(e.price_info || '')}" placeholder="Entrée libre, 5 000 $…" /></div>
      <div class="field"><label for="ne-img">Affiche (adresse)</label>
        <input id="ne-img" value="${escapeHtml(e.cover_url || '')}" placeholder="https://…" /></div>
      ${orgs.length ? `<div class="field"><label for="ne-o">Au nom de</label>
        <select id="ne-o"><option value="">Moi-même</option>${orgs.map((o) =>
          `<option value="${o.id}" ${o.id === e.organization_id ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('')}</select></div>` : ''}
      <button class="btn btn-primary" id="ne-save" style="width:100%;">${existant ? 'Enregistrer' : 'Publier l’événement'}</button>
      <div class="muted" id="ne-msg" style="font-size:12.5px;margin-top:10px;">
        Le tarif indiqué est informatif : Newpad n’encaisse rien.
      </div>
    `, () => {
      document.getElementById('ne-save').addEventListener('click', async () => {
        const msg = document.getElementById('ne-msg');
        const debut = document.getElementById('ne-s').value;
        const fin = document.getElementById('ne-f').value;
        const places = document.getElementById('ne-cap').value;
        if (!debut) { msg.textContent = 'La date de début est obligatoire.'; return; }
        msg.textContent = 'Enregistrement…';
        try {
          const { error } = await supabase.rpc('event_save', {
            p_title: document.getElementById('ne-t').value,
            p_description: document.getElementById('ne-d').value,
            p_starts_at: new Date(debut).toISOString(),
            p_id: existant ? e.id : null,
            p_category: document.getElementById('ne-c').value,
            p_location: document.getElementById('ne-l').value,
            p_ends_at: fin ? new Date(fin).toISOString() : null,
            p_capacity: places === '' ? null : Number(places),
            p_price_info: document.getElementById('ne-pi').value,
            p_cover_url: document.getElementById('ne-img').value,
            p_organization_id: document.getElementById('ne-o')?.value || null,
          });
          if (error) throw error;
          fermerPanneau();
          vue = 'upcoming'; marquer(); rendre();
        } catch (err) { msg.textContent = 'Échec : ' + (err.message || err); }
      });
    });
  }

  // --------------------------------------------------------------------------
  function panneau(titre, html, apres) {
    fermerPanneau();
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.id = 'ne-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(titre)}</strong>
        <button class="btn btn-ghost" id="ne-close" style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">${html}</div>`;
    document.querySelector('.app-frame').appendChild(el);
    document.getElementById('ne-close').addEventListener('click', fermerPanneau);
    if (apres) apres();
  }

  function fermerPanneau() { document.getElementById('ne-panel')?.remove(); }

  document.getElementById('ne-new')?.addEventListener('click', () => composer(null));

  await rendre();
}

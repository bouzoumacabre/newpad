// ============================================================================
// NewAds — la régie publicitaire
// ============================================================================
// Deux métiers dans un seul écran, comme partout ailleurs dans Newpad : celui
// de l'annonceur, qui compose ses campagnes et lit ses chiffres, et celui de la
// régie — l'administration Newpad — qui valide ou refuse avant diffusion.
//
// Une campagne ne pointe que vers une route interne de Newpad : la base le
// garantit (0055), l'écran ne propose donc que des destinations existantes,
// tirées du registre des applications.
//
// §90 : le budget affiché ne déclenche aucun paiement. Il se règle par un
// virement Newman Bank, comme tout le reste.

import { renderAppShell } from '../appShell.js';
import { escapeHtml, formatDateTime, formatMoney } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { supabase } from '../../lib/supabaseClient.js';
import { listLauncherApps } from '../../lib/newpadApi.js';
import { myOrganizations } from '../organizations/api.js';

const STATUT = {
  draft: 'Brouillon', pending: 'À valider', active: 'En diffusion',
  paused: 'En pause', rejected: 'Refusée', ended: 'Terminée',
};
const CLASSE = {
  draft: 'badge-neutral', pending: 'badge-pending', active: 'badge-success',
  paused: 'badge-pending', rejected: 'badge-danger', ended: 'badge-neutral',
};

export async function renderAdsApp(root, profile, estAdmin) {
  let vue = 'mes';
  let mesOrgs = [];
  let orgActive = '';
  let apps = [];

  try { mesOrgs = await myOrganizations(); } catch (_) { mesOrgs = []; }
  orgActive = mesOrgs.length ? mesOrgs[0].id : '';
  try { apps = await listLauncherApps(); } catch (_) { apps = []; }

  const onglets = [{ key: 'mes', label: 'Mes campagnes' }];
  if (estAdmin) onglets.push({ key: 'regie', label: 'Régie' });

  const { body } = await renderAppShell(root, profile, 'ads', {
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
    if (vue === 'regie') return regie();
    return mesCampagnes();
  }

  // --------------------------------------------------------------------------
  // Côté annonceur
  // --------------------------------------------------------------------------
  async function mesCampagnes() {
    if (!mesOrgs.length) {
      body.innerHTML = `
        <div class="app-empty">
          Les encarts s'achètent au nom d'une entreprise.<br />
          Créez ou rejoignez une entreprise dans NewPro pour lancer une campagne.
        </div>`;
      return;
    }

    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let campagnes = [];
    try {
      const { data, error } = await supabase.rpc('ads_my_campaigns', { p_organization_id: orgActive });
      if (error) throw error;
      campagnes = data || [];
    } catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    body.innerHTML = `
      <div class="app-toolbar">
        ${mesOrgs.length > 1 ? `<select id="ad-org" style="margin:0;max-width:210px;">
          ${mesOrgs.map((o) => `<option value="${o.id}" ${o.id === orgActive ? 'selected' : ''}>
            ${escapeHtml(o.name)}</option>`).join('')}</select>` : ''}
        <button class="btn btn-primary" id="ad-new" style="padding:6px 14px;font-size:13px;">+ Campagne</button>
      </div>
      ${campagnes.length ? `<div class="app-list">${campagnes.map((c) => `
        <div class="app-row" style="align-items:flex-start;">
          <span class="app-row-main" data-edit="${c.id}" style="cursor:pointer;">
            <strong>${escapeHtml(c.title)}</strong>
            <small>${(c.placements || []).map(nomApp).join(', ') || 'aucun emplacement'}
              ${c.budget !== null ? ' · ' + formatMoney(c.budget) : ''}
              · ${c.impressions} impression${Number(c.impressions) > 1 ? 's' : ''}
              · ${c.clics} clic${Number(c.clics) > 1 ? 's' : ''}</small>
            ${c.review_note ? `<span style="font-size:12px;color:var(--muted);margin-top:4px;">
              Régie : ${escapeHtml(c.review_note)}</span>` : ''}
          </span>
          ${c.status === 'draft' || c.status === 'rejected'
            ? `<button class="btn btn-primary" data-submit="${c.id}" style="padding:3px 10px;font-size:12px;">Soumettre</button>`
            : ''}
          ${c.status === 'active'
            ? `<button class="btn btn-ghost" data-pause="${c.id}" style="padding:3px 10px;font-size:12px;">Pause</button>`
            : ''}
          ${c.status === 'paused'
            ? `<button class="btn btn-ghost" data-resume="${c.id}" style="padding:3px 10px;font-size:12px;">Reprendre</button>`
            : ''}
          <span class="badge ${CLASSE[c.status] || 'badge-neutral'}">${STATUT[c.status] || c.status}</span>
        </div>`).join('')}</div>`
        : '<div class="app-empty">Aucune campagne. Composez la première.</div>'}
    `;

    document.getElementById('ad-org')?.addEventListener('change', (e) => { orgActive = e.target.value; mesCampagnes(); });
    document.getElementById('ad-new').addEventListener('click', () => editeur(null));
    body.querySelectorAll('[data-edit]').forEach((r) => {
      r.addEventListener('click', () => {
        const c = campagnes.find((x) => x.id === r.getAttribute('data-edit'));
        if (['active', 'paused'].includes(c.status)) { fiche(c); return; }
        editeur(c);
      });
    });
    body.querySelectorAll('[data-submit]').forEach((b) => {
      b.addEventListener('click', () => appeler('ads_submit', { p_id: b.getAttribute('data-submit') }));
    });
    body.querySelectorAll('[data-pause]').forEach((b) => {
      b.addEventListener('click', () => appeler('ads_set_paused', { p_id: b.getAttribute('data-pause'), p_paused: true }));
    });
    body.querySelectorAll('[data-resume]').forEach((b) => {
      b.addEventListener('click', () => appeler('ads_set_paused', { p_id: b.getAttribute('data-resume'), p_paused: false }));
    });
  }

  function nomApp(slug) {
    const a = apps.find((x) => x.slug === slug);
    return a ? a.name : slug;
  }

  async function appeler(fn, args) {
    try {
      const { error } = await supabase.rpc(fn, args);
      if (error) throw error;
      rendre();
    } catch (e) { await showAlert(String(e.message || e)); }
  }

  async function fiche(c) {
    let stats = { impressions: 0, clics: 0, taux: 0 };
    try {
      const { data } = await supabase.rpc('ads_campaign_stats', { p_id: c.id });
      if (data) stats = data;
    } catch (_) { /* chiffres indisponibles */ }

    panneau(c.title, `
      <div class="ad-stats">
        <div><dt>Impressions</dt><dd>${stats.impressions}</dd></div>
        <div><dt>Clics</dt><dd>${stats.clics}</dd></div>
        <div><dt>Taux de clic</dt><dd>${stats.taux} %</dd></div>
      </div>
      <div class="muted" style="font-size:12.5px;margin:12px 0;">
        ${(c.placements || []).map(nomApp).map(escapeHtml).join(', ') || 'Aucun emplacement'}
        ${c.starts_at ? '<br />Du ' + formatDateTime(c.starts_at) : ''}
        ${c.ends_at ? ' au ' + formatDateTime(c.ends_at) : ''}
      </div>
      ${c.budget !== null ? `<div class="np-note" style="margin-bottom:12px;">
        Budget annoncé : ${formatMoney(c.budget)} — réglé par virement Newman Bank,
        Newpad n'encaisse rien.</div>` : ''}
      <button class="btn btn-ghost" id="ad-pause2" style="width:100%;">
        ${c.status === 'paused' ? 'Reprendre la diffusion' : 'Mettre en pause'}</button>
      <div class="muted" style="font-size:11.5px;margin-top:8px;">
        Une campagne en diffusion ne se modifie pas : mettez-la en pause, corrigez-la,
        elle repassera par la régie.
      </div>
    `, () => {
      document.getElementById('ad-pause2').addEventListener('click', async () => {
        fermerPanneau();
        await appeler('ads_set_paused', { p_id: c.id, p_paused: c.status !== 'paused' });
      });
    });
  }

  function editeur(existante) {
    const c = existante || {};
    const choisis = new Set(c.placements || []);
    // Les destinations proposées sont les routes réelles du registre : une
    // annonce ne peut pas envoyer ailleurs que dans Newpad.
    const destinations = apps.filter((a) => a.route);

    panneau(existante ? 'Modifier la campagne' : 'Nouvelle campagne', `
      <div class="field"><label for="ad-t">Titre</label>
        <input id="ad-t" maxlength="80" value="${escapeHtml(c.title || '')}" /></div>
      <div class="field"><label for="ad-b">Accroche</label>
        <textarea id="ad-b" rows="3" maxlength="300">${escapeHtml(c.body || '')}</textarea></div>
      <div class="field"><label for="ad-m">Visuel (adresse https)</label>
        <input id="ad-m" value="${escapeHtml(c.media_url || '')}" placeholder="https://…" /></div>
      <div class="field"><label for="ad-r">Destination du clic</label>
        <select id="ad-r"><option value="">Aucune</option>${destinations.map((a) =>
          `<option value="${escapeHtml(a.route)}" ${a.route === c.target_route ? 'selected' : ''}>
            ${escapeHtml(a.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Emplacements</label>
        <div class="ad-places">${apps.map((a) => `
          <label class="ad-place">
            <input type="checkbox" value="${escapeHtml(a.slug)}" ${choisis.has(a.slug) ? 'checked' : ''} />
            ${escapeHtml(a.name)}
          </label>`).join('')}</div></div>
      <div style="display:flex;gap:10px;">
        <div class="field" style="flex:1;"><label for="ad-s">Début</label>
          <input id="ad-s" type="datetime-local" /></div>
        <div class="field" style="flex:1;"><label for="ad-e">Fin</label>
          <input id="ad-e" type="datetime-local" /></div>
      </div>
      <div class="field"><label for="ad-bu">Budget annoncé</label>
        <input id="ad-bu" type="number" min="0" step="1" value="${c.budget !== null && c.budget !== undefined ? c.budget : ''}" /></div>
      <button class="btn btn-primary" id="ad-save" style="width:100%;">Enregistrer</button>
      <div class="muted" id="ad-msg" style="font-size:12.5px;margin-top:10px;">
        L'enregistrement ne diffuse rien : la campagne passe d'abord à la régie.
      </div>
    `, () => {
      if (c.starts_at) document.getElementById('ad-s').value = versLocal(c.starts_at);
      if (c.ends_at) document.getElementById('ad-e').value = versLocal(c.ends_at);

      document.getElementById('ad-save').addEventListener('click', async () => {
        const msg = document.getElementById('ad-msg');
        const places = Array.from(document.querySelectorAll('.ad-place input:checked')).map((i) => i.value);
        const debut = document.getElementById('ad-s').value;
        const fin = document.getElementById('ad-e').value;
        const budget = document.getElementById('ad-bu').value;
        msg.textContent = 'Enregistrement…';
        try {
          const { error } = await supabase.rpc('ads_save_campaign', {
            p_organization_id: orgActive,
            p_title: document.getElementById('ad-t').value,
            p_id: existante ? c.id : null,
            p_body: document.getElementById('ad-b').value,
            p_media_url: document.getElementById('ad-m').value,
            p_target_route: document.getElementById('ad-r').value,
            p_placements: places,
            p_budget: budget === '' ? null : Number(budget),
            p_starts_at: debut ? new Date(debut).toISOString() : null,
            p_ends_at: fin ? new Date(fin).toISOString() : null,
          });
          if (error) throw error;
          fermerPanneau(); mesCampagnes();
        } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
      });
    });
  }

  const versLocal = (iso) => {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  // --------------------------------------------------------------------------
  // Côté régie
  // --------------------------------------------------------------------------
  async function regie() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let file = [];
    try {
      const { data, error } = await supabase.rpc('ads_pending');
      if (error) throw error;
      file = data || [];
    } catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    const attente = file.filter((c) => c.status === 'pending');
    const diffusion = file.filter((c) => c.status !== 'pending');

    body.innerHTML = `
      <h3 class="ad-section">À valider (${attente.length})</h3>
      ${attente.length ? attente.map(carteRegie).join('')
        : '<div class="muted" style="font-size:12.5px;">Rien en attente.</div>'}
      <h3 class="ad-section">En diffusion (${diffusion.length})</h3>
      ${diffusion.length ? `<div class="app-list">${diffusion.map((c) => `
        <div class="app-row">
          <span class="app-row-main">
            <strong>${escapeHtml(c.title)}</strong>
            <small>${escapeHtml(c.org_name)} · ${(c.placements || []).map(nomApp).join(', ')}</small>
          </span>
          <button class="btn btn-ghost" data-stop="${c.id}" style="padding:3px 10px;font-size:12px;">Arrêter</button>
          <span class="badge ${CLASSE[c.status]}">${STATUT[c.status]}</span>
        </div>`).join('')}</div>`
        : '<div class="muted" style="font-size:12.5px;">Aucune campagne en diffusion.</div>'}
    `;

    body.querySelectorAll('[data-ok]').forEach((b) => {
      b.addEventListener('click', () => decider(b.getAttribute('data-ok'), 'active'));
    });
    body.querySelectorAll('[data-no]').forEach((b) => {
      b.addEventListener('click', () => decider(b.getAttribute('data-no'), 'rejected'));
    });
    body.querySelectorAll('[data-stop]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!(await showConfirm('Arrêter définitivement cette campagne ?'))) return;
        decider(b.getAttribute('data-stop'), 'ended');
      });
    });
  }

  function carteRegie(c) {
    return `
      <article class="ad-review">
        <div class="ad-review-apercu">
          <aside class="ad-slot">
            ${c.media_url ? `<img class="ad-visuel" src="${escapeHtml(c.media_url)}" alt="" />` : ''}
            <div class="ad-texte">
              <div class="ad-titre">${escapeHtml(c.title)}</div>
              ${c.body ? `<div class="ad-corps">${escapeHtml(c.body)}</div>` : ''}
              <div class="ad-pied">${escapeHtml(c.org_name)}</div>
            </div>
            <span class="ad-mention">Annonce</span>
          </aside>
        </div>
        <div class="muted" style="font-size:12px;margin:8px 0;">
          ${(c.placements || []).map(nomApp).map(escapeHtml).join(', ')}
          ${c.target_route ? ' · vers ' + escapeHtml(c.target_route) : ' · sans destination'}
          ${c.budget !== null ? ' · ' + formatMoney(c.budget) : ''}
        </div>
        <input class="ad-note" data-note="${c.id}" placeholder="Motif (transmis à l'annonceur)" maxlength="300" />
        <div style="display:flex;gap:8px;">
          <button class="btn btn-primary" data-ok="${c.id}" style="flex:1;">Valider</button>
          <button class="btn btn-ghost" data-no="${c.id}" style="flex:1;">Refuser</button>
        </div>
      </article>`;
  }

  async function decider(id, decision) {
    const note = document.querySelector(`[data-note="${id}"]`);
    try {
      const { error } = await supabase.rpc('ads_review', {
        p_id: id, p_decision: decision, p_note: note ? note.value : null,
      });
      if (error) throw error;
      regie();
    } catch (e) { await showAlert(String(e.message || e)); }
  }

  // --------------------------------------------------------------------------
  function panneau(titre, html, apres) {
    fermerPanneau();
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.id = 'ad-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(titre)}</strong>
        <button class="btn btn-ghost" id="ad-close" style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">${html}</div>`;
    document.querySelector('.app-frame').appendChild(el);
    document.getElementById('ad-close').addEventListener('click', fermerPanneau);
    if (apres) apres();
  }

  function fermerPanneau() { document.getElementById('ad-panel')?.remove(); }

  await rendre();
}

// ============================================================================
// SACEM — le dépôt des œuvres et le partage des droits
// ============================================================================
// Une société de droits ne gère pas de la musique : elle gère des PARTS. Tout
// l'écran tourne donc autour d'une seule question, « qui détient quoi », et la
// somme doit faire 100 — la base refuse le contraire, l'écran le dit avant.
//
// Les écoutes ne sont pas comptées ici : une œuvre déclare être utilisée dans
// une vidéo NewTube, et l'audience se lit là où elle se produit (§52).
//
// §90 : aucune répartition d'argent. Le registre dit qui détient quoi et
// combien l'œuvre a tourné ; ce que ça vaut se règle en jeu.

import { renderAppShell } from '../appShell.js';
import { escapeHtml, formatDate, formatDateTime } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { supabase } from '../../lib/supabaseClient.js';
import { appIconSvg } from '../../lib/appIcons.js';
import { myOrganizations } from '../organizations/api.js';

const ROLES = [
  ['auteur', 'Auteur'], ['compositeur', 'Compositeur'],
  ['interprete', 'Interprète'], ['producteur', 'Producteur'],
];
const STATUT = { registered: 'Déposée', disputed: 'Contestée', withdrawn: 'Retirée' };
const CLASSE = { registered: 'badge-success', disputed: 'badge-danger', withdrawn: 'badge-neutral' };
const TYPE_CONTENU = {
  tube_video: 'Vidéo NewTube', event: 'Événement', news_article: 'Article News24', life_post: 'Publication NewLife',
};

export async function renderSacemApp(root, profile) {
  let vue = 'catalogue';
  let recherche = '';
  let moiArtiste = null;
  let mesOrgs = [];

  try {
    const { data } = await supabase.rpc('sacem_artist', { p_id: null });
    moiArtiste = data || null;
  } catch (_) { moiArtiste = null; }
  try { mesOrgs = await myOrganizations(); } catch (_) { mesOrgs = []; }

  const onglets = [
    { key: 'catalogue', label: 'Registre' },
    { key: 'moi', label: moiArtiste ? 'Mon catalogue' : 'Devenir artiste' },
  ];

  const { body } = await renderAppShell(root, profile, 'sacem', {
    tabs: onglets,
    active: vue,
    onTab: (k) => { vue = k; marquer(); rendre(); },
    actions: moiArtiste
      ? '<button class="btn btn-primary" id="sc-new" style="padding:6px 14px;font-size:13px;">+ Déposer</button>'
      : '',
  });

  function marquer() {
    document.querySelectorAll('.app-tab').forEach((t) => {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === vue);
    });
  }

  async function rendre() {
    if (vue === 'moi') return espaceArtiste();
    return catalogue();
  }

  // --------------------------------------------------------------------------
  // Le registre
  // --------------------------------------------------------------------------
  async function catalogue(artistId) {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let oeuvres = [];
    try {
      const { data, error } = await supabase.rpc('sacem_catalogue', {
        p_search: recherche || null, p_artist_id: artistId || null, p_limit: 60,
      });
      if (error) throw error;
      oeuvres = data || [];
    } catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    body.innerHTML = `
      <div class="app-toolbar">
        <input id="sc-q" placeholder="Titre, référence, nom de scène" value="${escapeHtml(recherche)}"
               style="flex:1;min-width:200px;margin:0;" />
      </div>
      ${oeuvres.length ? `<div class="app-list">${oeuvres.map((w) => `
        <div class="app-row" data-oeuvre="${w.id}" style="cursor:pointer;align-items:flex-start;">
          <span class="app-row-main">
            <strong>${escapeHtml(w.title)}</strong>
            <small>${escapeHtml(w.reference)}${w.genre ? ' · ' + escapeHtml(w.genre) : ''}
              ${w.release_date ? ' · ' + formatDate(w.release_date) : ''}
              · ${w.ecoutes} écoute${Number(w.ecoutes) > 1 ? 's' : ''}</small>
            <span class="sc-parts">${escapeHtml(w.ayants_droit || '')}</span>
          </span>
          <span class="badge ${CLASSE[w.status] || 'badge-neutral'}">${STATUT[w.status] || w.status}</span>
        </div>`).join('')}</div>`
        : '<div class="app-empty">Aucune œuvre au registre.</div>'}
    `;

    const champ = document.getElementById('sc-q');
    let minuteur = null;
    champ.addEventListener('input', () => {
      clearTimeout(minuteur);
      minuteur = setTimeout(() => { recherche = champ.value; catalogue(artistId); }, 300);
    });
    body.querySelectorAll('[data-oeuvre]').forEach((r) => {
      r.addEventListener('click', () => fiche(r.getAttribute('data-oeuvre')));
    });
  }

  // --------------------------------------------------------------------------
  // La fiche d'une œuvre
  // --------------------------------------------------------------------------
  async function fiche(id) {
    let w;
    try {
      const { data, error } = await supabase.rpc('sacem_work', { p_id: id });
      if (error) throw error;
      w = data;
    } catch (e) { await showAlert(String(e.message || e)); return; }

    const parts = w.shares || [];
    panneau(w.title, `
      <div class="sc-ref">${escapeHtml(w.reference)}</div>
      <div class="vt-meta" style="margin-bottom:12px;">
        ${w.genre ? `<span class="badge badge-neutral">${escapeHtml(w.genre)}</span>` : ''}
        <span class="badge ${CLASSE[w.status] || 'badge-neutral'}">${STATUT[w.status] || w.status}</span>
        ${w.duration_seconds ? `<span>${Math.floor(w.duration_seconds / 60)} min ${w.duration_seconds % 60}s</span>` : ''}
        ${w.release_date ? `<span>${formatDate(w.release_date)}</span>` : ''}
      </div>
      ${w.dispute_note ? `<div class="np-note" style="margin-bottom:12px;">
        Contestation : ${escapeHtml(w.dispute_note)}</div>` : ''}

      <h4 class="sv-sous-titre">Répartition des droits</h4>
      <div class="sc-repartition">
        ${parts.map((s) => `
          <div class="sc-part">
            <div class="sc-part-tete">
              <strong>${escapeHtml(s.stage_name)}</strong>
              <span>${s.share} %</span>
            </div>
            <div class="sc-jauge"><span style="width:${Math.min(100, Number(s.share))}%;"></span></div>
            <div class="muted" style="font-size:11.5px;">${escapeHtml(
              (ROLES.find((r) => r[0] === s.role) || [null, s.role])[1])}</div>
          </div>`).join('')}
      </div>
      <div class="muted" style="font-size:11.5px;margin:8px 0 12px;">
        Déposée par ${escapeHtml(w.depositor_name)}${w.label_name ? ' · ' + escapeHtml(w.label_name) : ''}.
        La répartition est déclarative : la SACEM de Newpad enregistre, elle ne verse rien.
      </div>

      <h4 class="sv-sous-titre">Utilisations déclarées</h4>
      ${(w.uses || []).length ? `<div class="app-list">${w.uses.map((u) => `
        <div class="app-row" style="padding:6px 10px;">
          <span class="app-row-main">
            <strong>${escapeHtml(TYPE_CONTENU[u.entity_type] || u.entity_type)}</strong>
            <small>${u.note ? escapeHtml(u.note) + ' · ' : ''}${formatDateTime(u.created_at)}</small>
          </span>
          ${w.is_mine ? `<button class="btn btn-ghost" data-usoff="${u.id}" style="padding:1px 8px;font-size:11px;">✕</button>` : ''}
        </div>`).join('')}</div>`
        : '<div class="muted" style="font-size:12.5px;">Aucune utilisation déclarée.</div>'}

      ${w.is_mine && w.status !== 'disputed' ? `
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">
          <button class="btn btn-ghost" id="sc-edit" style="flex:1;">Modifier</button>
          <button class="btn btn-ghost" id="sc-retire" style="flex:1;">Retirer</button>
        </div>` : ''}
    `, () => {
      document.getElementById('sc-edit')?.addEventListener('click', () => editeur(w));
      document.getElementById('sc-retire')?.addEventListener('click', async () => {
        if (!(await showConfirm('Retirer cette œuvre du registre ?'))) return;
        try {
          const { error } = await supabase.rpc('sacem_set_work_status', {
            p_id: w.id, p_status: 'withdrawn', p_note: null,
          });
          if (error) throw error;
          fermerPanneau(); rendre();
        } catch (e) { await showAlert(String(e.message || e)); }
      });
      document.querySelectorAll('#sc-panel [data-usoff]').forEach((b) => {
        b.addEventListener('click', async () => {
          try {
            const { error } = await supabase.rpc('sacem_remove_use', { p_id: b.getAttribute('data-usoff') });
            if (error) throw error;
            fermerPanneau(); fiche(id);
          } catch (e) { await showAlert(String(e.message || e)); }
        });
      });
    });
  }

  // --------------------------------------------------------------------------
  // L'espace artiste
  // --------------------------------------------------------------------------
  async function espaceArtiste() {
    if (!moiArtiste) {
      body.innerHTML = `
        <div class="sc-inscription">
          <span class="np-dir-logo" style="width:54px;height:54px;">${appIconSvg('music', 24)}</span>
          <h3>Déposer sous un nom de scène</h3>
          <p class="muted">
            Le dépôt se fait au nom d'un artiste, pas d'un compte. Choisissez votre nom de scène :
            il figurera sur chaque répartition où vous détenez des parts.
          </p>
          <div class="field"><label for="sc-nom">Nom de scène</label>
            <input id="sc-nom" maxlength="60" placeholder="DJ Vinewood" /></div>
          <div class="field"><label for="sc-bio">Présentation</label>
            <textarea id="sc-bio" rows="3" maxlength="1000"></textarea></div>
          ${mesOrgs.length ? `<div class="field"><label for="sc-label">Label</label>
            <select id="sc-label"><option value="">Indépendant</option>${mesOrgs.map((o) =>
              `<option value="${o.id}">${escapeHtml(o.name)}</option>`).join('')}</select></div>` : ''}
          <button class="btn btn-primary" id="sc-ok" style="width:100%;">M'enregistrer</button>
          <div class="muted" id="sc-msg" style="font-size:12.5px;margin-top:10px;"></div>
        </div>`;

      document.getElementById('sc-ok').addEventListener('click', async () => {
        const msg = document.getElementById('sc-msg');
        msg.textContent = 'Enregistrement…';
        try {
          const { error } = await supabase.rpc('sacem_register_artist', {
            p_stage_name: document.getElementById('sc-nom').value,
            p_slug: null,
            p_bio: document.getElementById('sc-bio').value,
            p_avatar_url: null,
            p_organization_id: document.getElementById('sc-label')?.value || null,
          });
          if (error) throw error;
          const { data } = await supabase.rpc('sacem_artist', { p_id: null });
          moiArtiste = data || null;
          document.querySelectorAll('.app-tab')[1].textContent = 'Mon catalogue';
          const zone = document.getElementById('app-actions');
          if (zone && !document.getElementById('sc-new')) {
            zone.innerHTML = '<button class="btn btn-primary" id="sc-new" style="padding:6px 14px;font-size:13px;">+ Déposer</button>';
            document.getElementById('sc-new').addEventListener('click', () => editeur(null));
          }
          espaceArtiste();
        } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
      });
      return;
    }

    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let oeuvres = [];
    try {
      const { data } = await supabase.rpc('sacem_catalogue', {
        p_search: null, p_artist_id: moiArtiste.id, p_limit: 100,
      });
      oeuvres = data || [];
    } catch (_) { oeuvres = []; }

    body.innerHTML = `
      <div class="sc-artiste">
        <span class="np-dir-logo" style="width:46px;height:46px;">${moiArtiste.avatar_url
          ? `<img src="${escapeHtml(moiArtiste.avatar_url)}" alt="" />` : appIconSvg('music', 20)}</span>
        <div style="flex:1;min-width:0;">
          <div class="sc-artiste-nom">${escapeHtml(moiArtiste.stage_name)}</div>
          <div class="muted" style="font-size:12px;">
            ${moiArtiste.label_name ? escapeHtml(moiArtiste.label_name) : 'Indépendant'}
            · ${moiArtiste.oeuvres} œuvre${Number(moiArtiste.oeuvres) > 1 ? 's' : ''}
            · ${moiArtiste.ecoutes} écoute${Number(moiArtiste.ecoutes) > 1 ? 's' : ''}
            ${moiArtiste.parts_moyennes !== null ? ' · part moyenne ' + moiArtiste.parts_moyennes + ' %' : ''}
          </div>
        </div>
        <button class="btn btn-ghost" id="sc-profil" style="padding:4px 11px;font-size:12px;">Modifier</button>
      </div>
      ${oeuvres.length ? `<div class="app-list">${oeuvres.map((w) => `
        <div class="app-row" data-oeuvre="${w.id}" style="cursor:pointer;">
          <span class="app-row-main">
            <strong>${escapeHtml(w.title)}</strong>
            <small>${escapeHtml(w.reference)} · ${w.ecoutes} écoute${Number(w.ecoutes) > 1 ? 's' : ''}</small>
          </span>
          <span class="badge ${CLASSE[w.status] || 'badge-neutral'}">${STATUT[w.status] || w.status}</span>
        </div>`).join('')}</div>`
        : '<div class="app-empty">Aucune œuvre à votre nom. Déposez la première.</div>'}
    `;

    document.getElementById('sc-profil').addEventListener('click', () => { moiArtiste = null; espaceArtiste(); });
    body.querySelectorAll('[data-oeuvre]').forEach((r) => {
      r.addEventListener('click', () => fiche(r.getAttribute('data-oeuvre')));
    });
  }

  // --------------------------------------------------------------------------
  // Déposer une œuvre
  // --------------------------------------------------------------------------
  function editeur(existante) {
    const w = existante || {};
    let parts = (w.shares || []).map((s) => ({
      artist_id: s.artist_id, stage_name: s.stage_name, share: Number(s.share), role: s.role,
    }));
    if (!parts.length && moiArtiste) {
      parts = [{ artist_id: moiArtiste.id, stage_name: moiArtiste.stage_name, share: 100, role: 'auteur' }];
    }

    panneau(existante ? 'Modifier le dépôt' : 'Déposer une œuvre', `
      <div class="field"><label for="sc-t">Titre</label>
        <input id="sc-t" maxlength="120" value="${escapeHtml(w.title || '')}" /></div>
      <div style="display:flex;gap:10px;">
        <div class="field" style="flex:1;"><label for="sc-g">Genre</label>
          <input id="sc-g" maxlength="40" value="${escapeHtml(w.genre || '')}" /></div>
        <div class="field" style="flex:1;"><label for="sc-dur">Durée (secondes)</label>
          <input id="sc-dur" type="number" min="1" value="${w.duration_seconds || ''}" /></div>
      </div>
      <div class="field"><label for="sc-date">Date de sortie</label>
        <input id="sc-date" type="date" value="${w.release_date || ''}" /></div>
      ${mesOrgs.length ? `<div class="field"><label for="sc-lab">Label</label>
        <select id="sc-lab"><option value="">Aucun</option>${mesOrgs.map((o) =>
          `<option value="${o.id}" ${o.id === w.organization_id ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('')}</select></div>` : ''}

      <h4 class="sv-sous-titre">Répartition (la somme doit faire 100 %)</h4>
      <div id="sc-parts"></div>
      <div class="app-toolbar" style="margin-top:6px;">
        <input id="sc-cherche" placeholder="Ajouter un ayant droit" style="flex:1;min-width:150px;margin:0;" />
      </div>
      <div id="sc-resultats" class="app-list" style="margin-top:6px;"></div>

      <button class="btn btn-primary" id="sc-save" style="width:100%;margin-top:12px;">
        ${existante ? 'Enregistrer' : 'Déposer'}</button>
      <div class="muted" id="sc-msg2" style="font-size:12.5px;margin-top:10px;"></div>
    `, () => {
      const zone = document.getElementById('sc-parts');
      const msg = document.getElementById('sc-msg2');

      function total() { return parts.reduce((s, p) => s + (Number(p.share) || 0), 0); }

      function rendreParts() {
        const t = total();
        zone.innerHTML = parts.map((p, i) => `
          <div class="sc-ligne">
            <span class="sc-ligne-nom">${escapeHtml(p.stage_name)}</span>
            <select data-role="${i}">${ROLES.map(([v, l]) =>
              `<option value="${v}" ${v === p.role ? 'selected' : ''}>${l}</option>`).join('')}</select>
            <input type="number" min="0.01" max="100" step="0.01" data-share="${i}" value="${p.share}" />
            <button class="btn btn-ghost" data-off="${i}" style="padding:1px 8px;font-size:11px;">✕</button>
          </div>`).join('')
          + `<div class="sc-total ${Math.round(t * 100) === 10000 ? 'is-ok' : 'is-ko'}">
               Total : ${t.toFixed(2)} %${Math.round(t * 100) === 10000 ? '' : ' — il doit faire 100 %'}
             </div>`;

        zone.querySelectorAll('[data-share]').forEach((el) => {
          el.addEventListener('input', () => {
            parts[Number(el.getAttribute('data-share'))].share = Number(el.value) || 0;
            const t2 = total();
            const ligne = zone.querySelector('.sc-total');
            ligne.textContent = `Total : ${t2.toFixed(2)} %` + (Math.round(t2 * 100) === 10000 ? '' : ' — il doit faire 100 %');
            ligne.className = 'sc-total ' + (Math.round(t2 * 100) === 10000 ? 'is-ok' : 'is-ko');
          });
        });
        zone.querySelectorAll('[data-role]').forEach((el) => {
          el.addEventListener('change', () => { parts[Number(el.getAttribute('data-role'))].role = el.value; });
        });
        zone.querySelectorAll('[data-off]').forEach((el) => {
          el.addEventListener('click', () => {
            parts.splice(Number(el.getAttribute('data-off')), 1);
            rendreParts();
          });
        });
      }
      rendreParts();

      const champ = document.getElementById('sc-cherche');
      const res = document.getElementById('sc-resultats');
      let minuteur = null;
      champ.addEventListener('input', () => {
        clearTimeout(minuteur);
        minuteur = setTimeout(async () => {
          if (!champ.value.trim()) { res.innerHTML = ''; return; }
          try {
            const { data } = await supabase.rpc('sacem_search_artists', { p_query: champ.value });
            const trouves = (data || []).filter((a) => !parts.some((p) => p.artist_id === a.id));
            res.innerHTML = trouves.map((a) => `
              <div class="app-row" data-add="${a.id}" data-nom="${escapeHtml(a.stage_name)}" style="cursor:pointer;padding:6px 10px;">
                <span class="app-row-main"><strong>${escapeHtml(a.stage_name)}</strong>
                  ${a.label_name ? `<small>${escapeHtml(a.label_name)}</small>` : ''}</span>
              </div>`).join('') || '<div class="muted" style="font-size:12px;">Aucun artiste trouvé.</div>';
            res.querySelectorAll('[data-add]').forEach((r) => {
              r.addEventListener('click', () => {
                parts.push({
                  artist_id: r.getAttribute('data-add'), stage_name: r.getAttribute('data-nom'),
                  share: 0, role: 'auteur',
                });
                champ.value = ''; res.innerHTML = ''; rendreParts();
              });
            });
          } catch (_) { res.innerHTML = ''; }
        }, 300);
      });

      document.getElementById('sc-save').addEventListener('click', async () => {
        const t = total();
        if (Math.round(t * 100) !== 10000) {
          msg.textContent = `La somme des parts fait ${t.toFixed(2)} % : elle doit faire exactement 100 %.`;
          return;
        }
        const duree = document.getElementById('sc-dur').value;
        const date = document.getElementById('sc-date').value;
        msg.textContent = 'Dépôt…';
        try {
          const { error } = await supabase.rpc('sacem_save_work', {
            p_title: document.getElementById('sc-t').value,
            p_shares: parts.map((p) => ({ artist_id: p.artist_id, share: p.share, role: p.role })),
            p_id: existante ? w.id : null,
            p_genre: document.getElementById('sc-g').value,
            p_duration_seconds: duree === '' ? null : Number(duree),
            p_release_date: date || null,
            p_cover_url: null,
            p_organization_id: document.getElementById('sc-lab')?.value || null,
          });
          if (error) throw error;
          fermerPanneau();
          vue = 'moi'; marquer(); rendre();
        } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
      });
    });
  }

  // --------------------------------------------------------------------------
  function panneau(titre, html, apres) {
    fermerPanneau();
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.id = 'sc-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(titre)}</strong>
        <button class="btn btn-ghost" id="sc-close" style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">${html}</div>`;
    document.querySelector('.app-frame').appendChild(el);
    document.getElementById('sc-close').addEventListener('click', fermerPanneau);
    if (apres) apres();
  }

  function fermerPanneau() { document.getElementById('sc-panel')?.remove(); }

  document.getElementById('sc-new')?.addEventListener('click', () => editeur(null));

  await rendre();
}

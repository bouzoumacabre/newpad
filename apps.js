// ============================================================================
// NEWPAD — administration du registre d'applications (§8, §9, §10)
// ============================================================================
// Tout ce que l'admin peut faire ici doit être faisable SANS modifier le code :
// nom, icône, logo, couleur, route, page, position, description, état, visibilité,
// propriétaire. C'est la contrepartie du registre dynamique : si un seul de ces
// réglages restait codé en dur, l'écran d'accueil et la base divergeraient.
//
// Deux façons de réorganiser sont proposées volontairement : le glisser-déposer,
// et des boutons de déplacement explicites. Le navigateur intégré de FiveM (CEF)
// a un historique de comportements erratiques sur des API que Chrome gère très
// bien — le glisser-déposer HTML5 en fait partie. Les boutons garantissent que
// la réorganisation reste possible en jeu même si le glissement se comporte mal.

import { navigate } from '../../../lib/router.js';
import { escapeHtml } from '../../../lib/format.js';
import { showAlert, showConfirm } from '../../../lib/uiDialogs.js';
import { ICON_KEYS, appIconSvg } from '../../../lib/appIcons.js';
import {
  listApps, upsertApp, deleteApp, setAppLayout,
  isNewpadAdmin, uploadAppImage, listOrganizations,
} from '../../../lib/newpadApi.js';

const STATUTS = [
  ['live', 'En service'],
  ['soon', 'En construction'],
  ['maintenance', 'En maintenance'],
];
const VISIBILITES = [
  ['public', 'Publique — visible par tous'],
  ['private', 'Privée — membres de l\'organisation'],
  ['restricted', 'Restreinte — membres de l\'organisation'],
];

export async function renderNewpadApps(root, profile) {
  if (!(await isNewpadAdmin())) {
    navigate('/');
    return;
  }

  let apps = [];
  let orgs = [];
  let selection = null; // application en cours d'édition, ou 'nouvelle'

  root.innerHTML = `
    <div class="npadmin">
      <header class="npadmin-top">
        <div>
          <div class="font-display" style="font-size:20px;color:var(--ivory);">Administration Newpad</div>
          <div class="muted" style="font-size:12.5px;">Applications de la tablette</div>
        </div>
        <div class="flex items-center gap-sm">
          <button class="btn btn-primary" id="np-new">+ Nouvelle application</button>
          <button class="btn btn-ghost" id="np-quit">Retour à la tablette</button>
        </div>
      </header>
      <div class="npadmin-body">
        <section class="card" id="np-pages-col">
          <p class="muted" style="font-size:12.5px;margin-bottom:12px;">
            Glissez une application pour la déplacer, dans sa page ou vers une autre.
            L'ordre est enregistré immédiatement et apparaît aussitôt sur la tablette des joueurs.
          </p>
          <div id="np-lists"></div>
        </section>
        <section class="card" id="np-form-col">
          <div id="np-form"></div>
        </section>
      </div>
    </div>
  `;

  document.getElementById('np-quit').addEventListener('click', () => navigate('/'));
  document.getElementById('np-new').addEventListener('click', () => { selection = 'nouvelle'; dessinerFormulaire(); });

  // --------------------------------------------------------------------------
  // Colonne de gauche : les pages et leurs applications
  // --------------------------------------------------------------------------
  function dessinerListes() {
    const parPage = new Map();
    apps.forEach((a) => {
      if (!parPage.has(a.page)) parPage.set(a.page, []);
      parPage.get(a.page).push(a);
    });
    const pages = [...parPage.keys()].sort((a, b) => a - b);
    // Une page vide en fin de liste sert de cible de dépôt pour créer une
    // nouvelle page en y glissant simplement une application (§4).
    const pageSuivante = (pages[pages.length - 1] || 0) + 1;

    const html = pages.concat([pageSuivante]).map((num) => {
      const liste = (parPage.get(num) || []).sort((a, b) => a.position - b.position);
      const pleine = liste.length >= 10;
      return `
        <div class="np-adm-page" data-page="${num}">
          <div class="np-adm-page-head">
            <strong>Page ${num}</strong>
            <span class="muted" style="font-size:12px;">
              ${liste.length} / 10 ${pleine ? '· pleine' : ''}
            </span>
          </div>
          <ul class="np-adm-list" data-page="${num}">
            ${liste.map((a, i) => ligneApp(a, i, liste.length)).join('')
              || '<li class="np-adm-empty">Déposez une application ici pour créer cette page.</li>'}
          </ul>
        </div>`;
    }).join('');

    document.getElementById('np-lists').innerHTML = html;
    brancherListes();
  }

  function ligneApp(a, i, total) {
    const visuel = a.icon_url
      ? `<img src="${escapeHtml(a.icon_url)}" alt="" />`
      : `<span style="color:${escapeHtml(a.accent_color || 'var(--gold)')};display:flex;">${appIconSvg(a.icon_key, 20)}</span>`;
    const etat = a.is_enabled ? '' : '<span class="badge badge-neutral">désactivée</span>';
    const statut = a.status === 'live'
      ? '<span class="badge badge-success">en service</span>'
      : (a.status === 'maintenance' ? '<span class="badge badge-pending">maintenance</span>' : '');
    return `
      <li class="np-adm-item ${selection && selection !== 'nouvelle' && selection.id === a.id ? 'is-selected' : ''}"
          draggable="true" data-id="${a.id}">
        <span class="np-adm-handle" aria-hidden="true">☰</span>
        <span class="np-adm-icon">${visuel}</span>
        <span class="np-adm-name">
          ${escapeHtml(a.name)}
          <small class="muted">${escapeHtml(a.route)}</small>
        </span>
        ${statut}${etat}
        <span class="np-adm-move">
          <button class="btn btn-ghost" data-act="up" data-id="${a.id}" ${i === 0 ? 'disabled' : ''} title="Monter">▲</button>
          <button class="btn btn-ghost" data-act="down" data-id="${a.id}" ${i === total - 1 ? 'disabled' : ''} title="Descendre">▼</button>
          <button class="btn btn-ghost" data-act="edit" data-id="${a.id}" title="Modifier">✎</button>
        </span>
      </li>`;
  }

  // --------------------------------------------------------------------------
  // Réorganisation
  // --------------------------------------------------------------------------
  // La disposition est recalculée entièrement à partir du DOM après chaque
  // manipulation, puis envoyée d'un bloc. Envoyer un déplacement isolé
  // obligerait le serveur à deviner l'effet sur les voisins ; ici, ce qui est
  // enregistré est exactement ce que l'admin a sous les yeux.
  async function enregistrerDisposition() {
    const items = [];
    document.querySelectorAll('.np-adm-list').forEach((ul) => {
      const page = Number(ul.getAttribute('data-page'));
      [...ul.querySelectorAll('.np-adm-item')].forEach((li, i) => {
        items.push({ id: li.getAttribute('data-id'), page, position: i + 1 });
      });
    });
    try {
      await setAppLayout(items);
      apps = await listApps({ force: true });
      dessinerListes();
    } catch (e) {
      await showAlert('Enregistrement impossible : ' + (e.message || e));
      apps = await listApps({ force: true });
      dessinerListes();
    }
  }

  function deplacer(id, sens) {
    const app = apps.find((a) => a.id === id);
    if (!app) return;
    const liste = apps.filter((a) => a.page === app.page).sort((a, b) => a.position - b.position);
    const i = liste.findIndex((a) => a.id === id);
    const j = i + sens;
    if (j < 0 || j >= liste.length) return;
    const items = liste.map((a, k) => {
      let pos = k + 1;
      if (k === i) pos = j + 1;
      else if (k === j) pos = i + 1;
      return { id: a.id, page: app.page, position: pos };
    });
    setAppLayout(items)
      .then(() => listApps({ force: true }))
      .then((r) => { apps = r; dessinerListes(); })
      .catch((e) => showAlert('Déplacement impossible : ' + (e.message || e)));
  }

  let porte = null;

  function brancherListes() {
    document.querySelectorAll('.np-adm-item').forEach((li) => {
      li.addEventListener('dragstart', (e) => {
        porte = li;
        li.classList.add('is-dragging');
        try { e.dataTransfer.setData('text/plain', li.getAttribute('data-id')); } catch (_) {}
        e.dataTransfer.effectAllowed = 'move';
      });
      li.addEventListener('dragend', () => {
        li.classList.remove('is-dragging');
        if (porte) { porte = null; enregistrerDisposition(); }
      });
    });

    document.querySelectorAll('.np-adm-list').forEach((ul) => {
      ul.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!porte) return;
        const vide = ul.querySelector('.np-adm-empty');
        if (vide) vide.remove();
        const apres = elementApres(ul, e.clientY);
        if (apres == null) ul.appendChild(porte);
        else ul.insertBefore(porte, apres);
      });
    });

    document.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', () => {
        const id = b.getAttribute('data-id');
        const act = b.getAttribute('data-act');
        if (act === 'up') deplacer(id, -1);
        else if (act === 'down') deplacer(id, 1);
        else if (act === 'edit') { selection = apps.find((a) => a.id === id); dessinerFormulaire(); dessinerListes(); }
      });
    });
  }

  function elementApres(ul, y) {
    const autres = [...ul.querySelectorAll('.np-adm-item:not(.is-dragging)')];
    for (const el of autres) {
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) return el;
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // Colonne de droite : le formulaire
  // --------------------------------------------------------------------------
  function dessinerFormulaire() {
    const f = document.getElementById('np-form');
    if (!selection) {
      f.innerHTML = `<p class="muted" style="font-size:13px;">
        Sélectionnez une application à gauche pour la modifier, ou créez-en une nouvelle.</p>`;
      return;
    }
    const nouvelle = selection === 'nouvelle';
    const a = nouvelle
      ? { slug: '', name: '', short_name: '', description: '', icon_key: 'grid', icon_url: '',
          logo_url: '', accent_color: '#c9a227', route: '/', page: 1, is_enabled: true,
          status: 'soon', visibility: 'public', owner_organization_id: '', is_system_app: false }
      : selection;

    f.innerHTML = `
      <div class="flex items-center justify-between" style="margin-bottom:14px;">
        <div class="font-display" style="font-size:17px;color:var(--ivory);">
          ${nouvelle ? 'Nouvelle application' : escapeHtml(a.name)}
        </div>
        ${!nouvelle && !a.is_system_app
          ? '<button class="btn btn-danger" id="np-del" style="padding:4px 10px;font-size:12px;">Supprimer</button>' : ''}
      </div>

      <div class="np-adm-preview">
        <span class="np-app-tile" id="np-preview-tile" style="width:66px;height:66px;">
          ${a.icon_url
            ? `<img src="${escapeHtml(a.icon_url)}" alt="" />`
            : `<span style="color:${escapeHtml(a.accent_color || 'var(--gold)')};display:flex;">${appIconSvg(a.icon_key, 30)}</span>`}
        </span>
        <span class="np-app-name" id="np-preview-name" style="max-width:120px;">${escapeHtml(a.name || 'Nom')}</span>
      </div>

      <div class="field"><label for="f-name">Nom affiché sous l'icône</label>
        <input id="f-name" maxlength="40" value="${escapeHtml(a.name)}" /></div>

      <div class="grid" style="grid-template-columns:1fr 1fr;">
        <div class="field"><label for="f-slug">Identifiant (slug)</label>
          <input id="f-slug" value="${escapeHtml(a.slug)}" ${a.is_system_app ? 'readonly' : ''} /></div>
        <div class="field"><label for="f-route">Route</label>
          <input id="f-route" value="${escapeHtml(a.route)}" /></div>
      </div>

      <div class="field"><label for="f-desc">Description (interne — jamais affichée sous l'icône)</label>
        <input id="f-desc" maxlength="160" value="${escapeHtml(a.description || '')}" /></div>

      <div class="grid" style="grid-template-columns:1fr 1fr;">
        <div class="field"><label for="f-icon">Icône intégrée</label>
          <select id="f-icon">${ICON_KEYS.map((k) =>
            `<option value="${k}" ${a.icon_key === k ? 'selected' : ''}>${k}</option>`).join('')}</select></div>
        <div class="field"><label for="f-color">Couleur d'accent</label>
          <input id="f-color" type="color" value="${escapeHtml(a.accent_color || '#c9a227')}" style="height:40px;padding:4px;" /></div>
      </div>

      <div class="field"><label for="f-iconfile">Icône personnalisée (PNG, WebP, SVG — 2 Mo max)</label>
        <input id="f-iconfile" type="file" accept="image/png,image/webp,image/svg+xml,image/jpeg" />
        <div class="flex items-center gap-sm" style="margin-top:6px;">
          <input id="f-iconurl" placeholder="Aucune icône téléversée" value="${escapeHtml(a.icon_url || '')}" style="flex:1;" />
          <button class="btn btn-ghost" id="f-iconclear" title="Revenir à l'icône intégrée">✕</button>
        </div>
        <div class="muted" id="f-iconstate" style="font-size:12px;margin-top:4px;"></div>
      </div>

      <div class="grid" style="grid-template-columns:1fr 1fr 1fr;">
        <div class="field"><label for="f-page">Page</label>
          <input id="f-page" type="number" min="1" max="50" value="${a.page || 1}" /></div>
        <div class="field"><label for="f-status">État</label>
          <select id="f-status">${STATUTS.map(([v, l]) =>
            `<option value="${v}" ${a.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label for="f-enabled">Affichage</label>
          <select id="f-enabled">
            <option value="1" ${a.is_enabled ? 'selected' : ''}>Visible</option>
            <option value="0" ${!a.is_enabled ? 'selected' : ''}>Masquée</option>
          </select></div>
      </div>

      <div class="grid" style="grid-template-columns:1fr 1fr;">
        <div class="field"><label for="f-vis">Visibilité</label>
          <select id="f-vis">${VISIBILITES.map(([v, l]) =>
            `<option value="${v}" ${a.visibility === v ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select></div>
        <div class="field"><label for="f-org">Organisation propriétaire</label>
          <select id="f-org">
            <option value="">— aucune —</option>
            ${orgs.map((o) => `<option value="${o.id}" ${a.owner_organization_id === o.id ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('')}
          </select></div>
      </div>

      <div class="flex items-center gap-sm" style="margin-top:8px;">
        <button class="btn btn-primary" id="np-save">${nouvelle ? 'Créer' : 'Enregistrer'}</button>
        <button class="btn btn-ghost" id="np-cancel">Annuler</button>
      </div>
      <div class="muted" id="np-msg" style="font-size:12.5px;margin-top:10px;"></div>
    `;

    brancherFormulaire(nouvelle, a);
  }

  function brancherFormulaire(nouvelle, a) {
    const $ = (id) => document.getElementById(id);
    const msg = $('np-msg');

    function rafraichirApercu() {
      const url = $('f-iconurl').value.trim();
      const couleur = $('f-color').value;
      $('np-preview-tile').innerHTML = url
        ? `<img src="${escapeHtml(url)}" alt="" />`
        : `<span style="color:${escapeHtml(couleur)};display:flex;">${appIconSvg($('f-icon').value, 30)}</span>`;
      $('np-preview-name').textContent = $('f-name').value || 'Nom';
    }
    ['f-name', 'f-icon', 'f-color', 'f-iconurl'].forEach((id) => {
      $(id).addEventListener('input', rafraichirApercu);
      $(id).addEventListener('change', rafraichirApercu);
    });

    // Le slug se déduit du nom tant que l'admin ne l'a pas écrit lui-même :
    // c'est un identifiant technique, pas une décision de plus à prendre.
    if (nouvelle) {
      $('f-name').addEventListener('input', () => {
        if ($('f-slug').dataset.touche) return;
        $('f-slug').value = $('f-name').value.toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
        if (!$('f-route').dataset.touche) $('f-route').value = '/' + $('f-slug').value;
      });
      $('f-slug').addEventListener('input', () => { $('f-slug').dataset.touche = '1'; });
      $('f-route').addEventListener('input', () => { $('f-route').dataset.touche = '1'; });
    }

    $('f-iconclear').addEventListener('click', () => { $('f-iconurl').value = ''; rafraichirApercu(); });

    $('f-iconfile').addEventListener('change', async (e) => {
      const fichier = e.target.files && e.target.files[0];
      if (!fichier) return;
      const etat = $('f-iconstate');
      etat.textContent = 'Téléversement…';
      try {
        const url = await uploadAppImage(fichier, $('f-slug').value || 'app', 'icon');
        $('f-iconurl').value = url;
        etat.textContent = 'Icône téléversée. Enregistrez pour l\'appliquer.';
        rafraichirApercu();
      } catch (err) {
        etat.textContent = 'Échec : ' + (err.message || err);
      }
    });

    $('np-cancel').addEventListener('click', () => { selection = null; dessinerFormulaire(); dessinerListes(); });

    $('np-del')?.addEventListener('click', async () => {
      if (!(await showConfirm(`Supprimer définitivement « ${a.name} » ?`))) return;
      try {
        await deleteApp(a.id);
        selection = null;
        apps = await listApps({ force: true });
        dessinerListes(); dessinerFormulaire();
      } catch (e) { await showAlert('Suppression impossible : ' + (e.message || e)); }
    });

    $('np-save').addEventListener('click', async () => {
      msg.textContent = 'Enregistrement…';
      try {
        await upsertApp({
          id: nouvelle ? null : a.id,
          slug: $('f-slug').value.trim(),
          name: $('f-name').value.trim(),
          route: $('f-route').value.trim(),
          short_name: null,
          description: $('f-desc').value.trim() || null,
          icon_key: $('f-icon').value,
          icon_url: $('f-iconurl').value.trim() || null,
          logo_url: a.logo_url || null,
          accent_color: $('f-color').value,
          page: Number($('f-page').value) || 1,
          position: nouvelle ? null : undefined,
          owner_organization_id: $('f-org').value || null,
          is_enabled: $('f-enabled').value === '1',
          status: $('f-status').value,
          visibility: $('f-vis').value,
        });
        apps = await listApps({ force: true });
        selection = nouvelle ? null : apps.find((x) => x.id === a.id) || null;
        dessinerListes();
        dessinerFormulaire();
        const m = document.getElementById('np-msg');
        if (m) m.textContent = 'Enregistré. La tablette des joueurs est déjà à jour.';
      } catch (e) {
        msg.textContent = 'Échec : ' + (e.message || e);
      }
    });
  }

  // --------------------------------------------------------------------------
  try {
    apps = await listApps({ force: true });
    orgs = await listOrganizations().catch(() => []);
  } catch (e) {
    root.innerHTML = `<div class="card" style="margin:40px auto;max-width:520px;">
      <p>Le registre n'a pas pu être chargé : ${escapeHtml(String(e.message || e))}</p></div>`;
    return;
  }
  dessinerListes();
  dessinerFormulaire();
}

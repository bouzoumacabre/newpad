// ============================================================================
// NEWPAD — écran d'accueil de la tablette
// ============================================================================
// Cet écran ne connaît AUCUNE application (§7). Il lit `app_registry` et dessine
// ce qu'il y trouve. Ajouter, renommer, déplacer ou retirer une application se
// fait donc entièrement depuis l'administration, sans toucher à ce fichier.

import { renderTabletShell } from './tabletShell.js';
import { listLauncherApps, subscribeAppRegistry } from '../../lib/newpadApi.js';
import { appIconSvg } from '../../lib/appIcons.js';
import { escapeHtml } from '../../lib/format.js';
import { navigate } from '../../lib/router.js';

const SEUIL_GLISSEMENT = 0.12; // fraction de la largeur au-delà de laquelle on change de page

function grouperParPage(apps) {
  const pages = new Map();
  apps.forEach((a) => {
    if (!pages.has(a.page)) pages.set(a.page, []);
    pages.get(a.page).push(a);
  });
  return [...pages.keys()]
    .sort((a, b) => a - b)
    .map((num) => ({ num, apps: pages.get(num).sort((x, y) => x.position - y.position) }));
}

function tuileApp(app) {
  const couleur = app.accent_color || 'var(--gold)';
  const visuel = app.icon_url
    ? `<img src="${escapeHtml(app.icon_url)}" alt="" loading="lazy" />`
    : `<span style="color:${escapeHtml(couleur)};display:flex;">${appIconSvg(app.icon_key, 34)}</span>`;
  const bientot = app.status === 'soon';
  const maintenance = app.status === 'maintenance';
  // Pas de pastille « Bientôt » : au démarrage, 22 applications sur 23 en
  // porteraient une, et un écran couvert d'étiquettes ne ressemble plus à une
  // tablette. L'icône simplement atténuée suffit à distinguer ce qui n'est pas
  // encore ouvert ; la maintenance, elle, est un incident et doit se voir.
  const drapeau = maintenance ? 'Maintenance' : '';

  return `
    <button class="np-app ${bientot || maintenance ? 'np-app-soon' : ''}"
            data-route="${escapeHtml(app.route)}" title="${escapeHtml(app.name)}">
      <span class="np-app-tile">
        ${visuel}
        ${drapeau ? `<span class="np-app-flag">${drapeau}</span>` : ''}
      </span>
      <span class="np-app-name">${escapeHtml(app.name)}</span>
    </button>
  `;
}

export async function renderLauncher(root, profile) {
  const { body, footerCenter } = renderTabletShell(root, profile, {
    footerLeft: 'Newpad',
  });

  let pages = [];
  let index = 0;

  async function charger() {
    let apps = [];
    try {
      apps = await listLauncherApps();
    } catch (e) {
      body.innerHTML = `
        <div class="np-soon">
          <h1>Newpad indisponible</h1>
          <p>La liste des applications n'a pas pu être chargée. Vérifiez votre connexion, puis réessayez.</p>
          <button class="btn btn-secondary" id="np-retry">Réessayer</button>
        </div>`;
      document.getElementById('np-retry')?.addEventListener('click', charger);
      return;
    }
    pages = grouperParPage(apps);
    if (pages.length === 0) {
      body.innerHTML = `<div class="np-soon"><h1>Aucune application</h1><p>Le registre Newpad est vide.</p></div>`;
      footerCenter.innerHTML = '';
      return;
    }
    if (index >= pages.length) index = pages.length - 1;
    dessiner();
  }

  function dessiner() {
    body.innerHTML = `
      <div class="np-pages" id="np-pages">
        ${pages.map((p) => `<div class="np-page">${p.apps.map(tuileApp).join('')}</div>`).join('')}
      </div>
      <button class="np-arrow np-arrow-prev" id="np-prev" aria-label="Page précédente">‹</button>
      <button class="np-arrow np-arrow-next" id="np-next" aria-label="Page suivante">›</button>
    `;
    footerCenter.innerHTML = `
      <div class="np-dots" role="tablist" aria-label="Pages d'applications">
        ${pages.map((p, i) => `<button class="np-dot ${i === index ? 'is-active' : ''}" data-i="${i}"
            role="tab" aria-selected="${i === index}" aria-label="Page ${p.num}"></button>`).join('')}
      </div>`;
    positionner(false);
    brancher();
  }

  const piste = () => document.getElementById('np-pages');

  function positionner(anime = true) {
    const el = piste();
    if (!el) return;
    el.classList.toggle('np-nodrag', !anime);
    el.style.transform = `translateX(${-index * 100}%)`;
    footerCenter.querySelectorAll('.np-dot').forEach((d, i) => {
      d.classList.toggle('is-active', i === index);
      d.setAttribute('aria-selected', String(i === index));
    });
    const prev = document.getElementById('np-prev');
    const next = document.getElementById('np-next');
    if (prev) prev.disabled = index === 0;
    if (next) next.disabled = index >= pages.length - 1;
  }

  function allerA(i) {
    index = Math.max(0, Math.min(pages.length - 1, i));
    positionner(true);
  }

  function brancher() {
    body.querySelectorAll('.np-app').forEach((el) => {
      el.addEventListener('click', () => {
        // Un glissement se termine par un « click » sur la tuile survolée :
        // sans ce garde, chaque changement de page ouvrirait une application.
        if (aGlisse) return;
        navigate(el.getAttribute('data-route'));
      });
    });
    footerCenter.querySelectorAll('.np-dot').forEach((d) => {
      d.addEventListener('click', () => allerA(Number(d.getAttribute('data-i'))));
    });
    document.getElementById('np-prev')?.addEventListener('click', () => allerA(index - 1));
    document.getElementById('np-next')?.addEventListener('click', () => allerA(index + 1));
  }

  // --------------------------------------------------------------------------
  // Glissement horizontal (§4) — souris et tactile par les mêmes événements
  // pointeur, plutôt qu'un couple mouse*/touch* dupliqué.
  // --------------------------------------------------------------------------
  let departX = 0;
  let departY = 0;
  let enCours = false;
  let aGlisse = false;

  body.addEventListener('pointerdown', (e) => {
    if (pages.length < 2 || e.button === 2) return;
    enCours = true;
    aGlisse = false;
    departX = e.clientX;
    departY = e.clientY;
  });

  body.addEventListener('pointermove', (e) => {
    if (!enCours) return;
    const dx = e.clientX - departX;
    const dy = e.clientY - departY;
    // Tant que le mouvement est plus vertical qu'horizontal, ce n'est pas un
    // changement de page : on laisse le geste tranquille.
    if (!aGlisse && Math.abs(dx) < 8) return;
    if (!aGlisse && Math.abs(dy) > Math.abs(dx)) { enCours = false; return; }
    aGlisse = true;
    const el = piste();
    if (!el) return;
    const largeur = body.clientWidth || 1;
    // Résistance aux extrémités : sinon la première page se décolle du bord et
    // donne l'impression d'un écran cassé.
    let ratio = dx / largeur;
    if ((index === 0 && dx > 0) || (index === pages.length - 1 && dx < 0)) ratio *= 0.28;
    el.classList.add('np-nodrag');
    el.style.transform = `translateX(${(-index * 100) + ratio * 100}%)`;
  });

  function finGeste(e) {
    if (!enCours) return;
    enCours = false;
    const el = piste();
    if (!el) return;
    el.classList.remove('np-nodrag');
    if (!aGlisse) { positionner(false); return; }
    const dx = (e.clientX ?? departX) - departX;
    const largeur = body.clientWidth || 1;
    if (dx < -largeur * SEUIL_GLISSEMENT) allerA(index + 1);
    else if (dx > largeur * SEUIL_GLISSEMENT) allerA(index - 1);
    else positionner(true);
    // Le garde anti-ouverture est levé au tour de boucle suivant, une fois le
    // « click » de fin de glissement passé.
    setTimeout(() => { aGlisse = false; }, 0);
  }

  body.addEventListener('pointerup', finGeste);
  body.addEventListener('pointercancel', finGeste);
  body.addEventListener('pointerleave', finGeste);

  function auClavier(e) {
    if (!document.getElementById('np-pages')) { document.removeEventListener('keydown', auClavier); return; }
    if (e.key === 'ArrowRight') allerA(index + 1);
    else if (e.key === 'ArrowLeft') allerA(index - 1);
  }
  document.addEventListener('keydown', auClavier);

  // Mise à jour immédiate quand l'admin change une icône, un nom ou l'ordre.
  subscribeAppRegistry(() => {
    if (!document.getElementById('np-pages')) return;
    charger();
  });

  await charger();
}

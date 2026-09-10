// ============================================================================
// NEWPAD — coquille commune des applications
// ============================================================================
// Toutes les applications Newpad partagent le châssis de la tablette (§3) et,
// à l'intérieur, la même barre d'application : icône, nom, onglets. Chaque
// application garde sa personnalité par sa couleur d'accent (§86), pas par une
// mise en page qui lui serait propre — sinon passer d'une application à l'autre
// donnerait l'impression de changer d'appareil.

import { renderTabletShell } from '../pages/newpad/tabletShell.js';
import { appIconSvg } from '../lib/appIcons.js';
import { escapeHtml } from '../lib/format.js';
import { findAppBySlug } from '../lib/newpadApi.js';

/**
 * @param {HTMLElement} root    #app
 * @param {object} profile      profil connecté
 * @param {string} slug         slug de l'application dans le registre
 * @param {object} opts         { tabs: [{key,label}], active, onTab, actions }
 * @returns {Promise<{ body: HTMLElement, app: object }>}
 */
export async function renderAppShell(root, profile, slug, opts = {}) {
  // Le nom, l'icône et la couleur viennent du registre : si l'admin renomme
  // l'application ou change son icône, l'en-tête suit sans redéploiement.
  const app = (await findAppBySlug(slug).catch(() => null)) || { name: slug, icon_key: 'grid', accent_color: '#c9a227' };
  const couleur = app.accent_color || 'var(--gold)';

  const { body } = renderTabletShell(root, profile, {
    showHome: true,
    scroll: false,
    footerLeft: app.name,
  });

  const onglets = (opts.tabs || []);
  body.innerHTML = `
    <div class="app-frame" style="--app-accent:${escapeHtml(couleur)};">
      <header class="app-bar">
        <span class="app-bar-icon">${app.icon_url
          ? `<img src="${escapeHtml(app.icon_url)}" alt="" />`
          : appIconSvg(app.icon_key, 22)}</span>
        <span class="app-bar-name">${escapeHtml(app.name)}</span>
        ${onglets.length ? `<nav class="app-tabs">${onglets.map((t) => `
          <button class="app-tab ${t.key === opts.active ? 'is-active' : ''}" data-tab="${escapeHtml(t.key)}">
            ${escapeHtml(t.label)}
          </button>`).join('')}</nav>` : ''}
        <span class="app-bar-actions" id="app-actions">${opts.actions || ''}</span>
      </header>
      <div class="app-content" id="app-content"></div>
    </div>
  `;

  body.querySelectorAll('.app-tab').forEach((b) => {
    b.addEventListener('click', () => opts.onTab && opts.onTab(b.getAttribute('data-tab')));
  });

  return { body: document.getElementById('app-content'), app };
}

// ============================================================================
// NEWPAD — écran d'une application déclarée mais pas encore construite
// ============================================================================
// §95 : « pas de boutons sans fonctionnement ». Les 22 applications à venir
// existent déjà dans le registre, donc leur icône est visible sur la tablette ;
// il faut qu'un clic mène quelque part de propre plutôt qu'à une page blanche
// ou à un « Page introuvable » qui donne l'impression d'un site cassé.

import { renderTabletShell } from './tabletShell.js';
import { appIconSvg } from '../../lib/appIcons.js';
import { escapeHtml } from '../../lib/format.js';
import { navigate } from '../../lib/router.js';

export function renderAppPlaceholder(root, profile, app) {
  const { body } = renderTabletShell(root, profile, {
    showHome: true,
    footerLeft: app.name,
  });

  const couleur = app.accent_color || 'var(--gold)';
  const visuel = app.icon_url
    ? `<img src="${escapeHtml(app.icon_url)}" alt="" style="width:56px;height:56px;object-fit:contain;" />`
    : `<span style="color:${escapeHtml(couleur)};display:flex;">${appIconSvg(app.icon_key, 46)}</span>`;

  const enMaintenance = app.status === 'maintenance';

  body.innerHTML = `
    <div class="np-soon">
      <div class="np-soon-icon">${visuel}</div>
      <h1>${escapeHtml(app.name)}</h1>
      ${app.description ? `<p>${escapeHtml(app.description)}</p>` : ''}
      <p style="color:${enMaintenance ? 'var(--status-pending)' : 'var(--gold-light)'};letter-spacing:.14em;text-transform:uppercase;font-size:11.5px;">
        ${enMaintenance ? 'Application en maintenance' : 'Application en cours de construction'}
      </p>
      <button class="btn btn-secondary" id="np-back">Retour à l'accueil</button>
    </div>
  `;
  document.getElementById('np-back')?.addEventListener('click', () => navigate('/'));
}

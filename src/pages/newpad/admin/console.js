// ============================================================================
// NEWPAD — console d'administration générale (§84)
// ============================================================================
// Point d'entrée unique vers TOUS les back-offices : celui de Newpad lui-même,
// et celui de chaque application qui en possède un.
//
// La liste des applications n'est pas écrite ici. Elle est lue dans
// `app_registry.admin_route` : une application qui déclare sa route
// d'administration apparaît d'elle-même dans cette console, sans qu'on
// revienne modifier ce fichier. C'est la même règle que pour l'écran d'accueil
// — sinon on recrée exactement la liste codée en dur que le registre
// dynamique existe pour supprimer.

import { navigate } from '../../../lib/router.js';
import { escapeHtml } from '../../../lib/format.js';
import { appIconSvg } from '../../../lib/appIcons.js';
import { listApps, isNewpadAdmin } from '../../../lib/newpadApi.js';

// Les espaces qui appartiennent à Newpad lui-même, et non à une application.
// Ceux qui ne sont pas encore construits sont affichés désactivés plutôt que
// masqués : l'admin voit ce qui existera, et ne cherche pas une page absente.
const ESPACES_NEWPAD = [
  { titre: 'Applications', desc: 'Registre, icônes, pages, ordre, visibilité', route: '/newpad/apps', icon: 'grid', pret: true },
  { titre: 'Organisations', desc: 'Entreprises, gouvernement, médias, labels', route: '/newpad/organizations', icon: 'briefcase', pret: false },
  { titre: 'Utilisateurs', desc: 'Profils Newpad, rôles, administrateurs', route: '/newpad/users', icon: 'work', pret: false },
  { titre: 'Publicité', desc: 'Régie NewAds, campagnes, emplacements', route: '/newpad/ads', icon: 'megaphone', pret: false },
  { titre: 'Documents', desc: 'Coffre NewFiles et permissions', route: '/newpad/files', icon: 'folder', pret: false },
  { titre: 'Journal & sécurité', desc: 'Audit, connexions, alertes', route: '/newpad/audit', icon: 'shield', pret: false },
];

function carte({ titre, desc, route, icon, couleur, pret, badge }) {
  const teinte = couleur || 'var(--gold)';
  return `
    <button class="np-console-card ${pret ? '' : 'is-soon'}" ${pret ? `data-route="${escapeHtml(route)}"` : 'disabled'}>
      <span class="np-console-icon" style="color:${escapeHtml(teinte)};">${appIconSvg(icon, 26)}</span>
      <span class="np-console-text">
        <strong>${escapeHtml(titre)}</strong>
        <small>${escapeHtml(desc)}</small>
      </span>
      ${badge ? `<span class="badge badge-neutral">${escapeHtml(badge)}</span>` : ''}
      ${pret ? '<span class="np-console-go">›</span>' : '<span class="np-console-go muted">à venir</span>'}
    </button>`;
}

export async function renderNewpadConsole(root, profile) {
  if (!(await isNewpadAdmin())) {
    navigate('/');
    return;
  }

  let apps = [];
  try {
    apps = await listApps({ force: true });
  } catch (_) { /* la console reste utilisable sans le registre */ }

  const avecAdmin = apps.filter((a) => a.admin_route);
  const sansAdmin = apps.filter((a) => !a.admin_route);

  root.innerHTML = `
    <div class="npadmin">
      <header class="npadmin-top">
        <div>
          <div class="font-display" style="font-size:20px;color:var(--ivory);">Console d'administration</div>
          <div class="muted" style="font-size:12.5px;">${escapeHtml(profile.display_name || '')} — administrateur Newpad</div>
        </div>
        <button class="btn btn-ghost" id="np-quit">◀ Tablette</button>
      </header>

      <div class="npadmin-scroll">
        <section class="np-console-section">
          <h2>Newpad</h2>
          <p class="muted">Ce qui gouverne la tablette et le socle commun à toutes les applications.</p>
          <div class="np-console-grid">
            ${ESPACES_NEWPAD.map(carte).join('')}
          </div>
        </section>

        <section class="np-console-section">
          <h2>Applications</h2>
          <p class="muted">
            ${avecAdmin.length
              ? 'Chaque application déclare la route de son back-office dans le registre.'
              : 'Aucune application ne déclare encore de back-office.'}
          </p>
          <div class="np-console-grid">
            ${avecAdmin.map((a) => carte({
              titre: a.name,
              desc: a.description || 'Administration de l\'application',
              route: a.admin_route,
              icon: a.icon_key,
              couleur: a.accent_color,
              pret: true,
              badge: a.status === 'live' ? '' : 'en construction',
            })).join('')}
          </div>
        </section>

        ${sansAdmin.length ? `
        <section class="np-console-section">
          <h2>Sans administration</h2>
          <p class="muted">
            ${sansAdmin.length} application${sansAdmin.length > 1 ? 's' : ''} n'${sansAdmin.length > 1 ? 'ont' : 'a'} pas encore de back-office.
            Renseignez sa route d'administration dans le registre pour la faire apparaître ici.
          </p>
          <div class="np-console-tags">
            ${sansAdmin.map((a) => `<span class="np-console-tag">${escapeHtml(a.name)}</span>`).join('')}
          </div>
        </section>` : ''}
      </div>
    </div>
  `;

  document.getElementById('np-quit').addEventListener('click', () => navigate('/'));
  root.querySelectorAll('.np-console-card[data-route]').forEach((b) => {
    b.addEventListener('click', () => navigate(b.getAttribute('data-route')));
  });
}

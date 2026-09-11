// ============================================================================
// NEWPAD — châssis de la tablette
// ============================================================================
// §3 du cahier des charges : « Chaque page de la tablette doit garder
// exactement le même format, le même header, le même footer, le même fond, les
// mêmes dimensions, la même grille. Seules les applications changent. »
//
// C'est pour cela que ce fichier existe : le châssis est écrit UNE fois ici, et
// chaque écran Newpad se contente de remplir l'intérieur. Une application qui
// dessinerait son propre en-tête casserait l'illusion de l'objet physique.

import logoUrl from '../../assets/logo.svg';
import { supabase } from '../../lib/supabaseClient.js';
import { navigate } from '../../lib/router.js';
import { setupNotifications } from '../../lib/shell.js';
import { escapeHtml } from '../../lib/format.js';
import { isNewpadAdmin } from '../../lib/newpadApi.js';
import { quitterLeModeInvite } from '../../lib/guestMode.js';

function initiales(nom) {
  return (nom || '?').split(' ').filter(Boolean).slice(0, 2).map((m) => m[0].toUpperCase()).join('');
}

let horloge = null;

function texteHorloge() {
  const d = new Date();
  const heure = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const jour = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  return { heure, jour };
}

/**
 * Dessine le châssis et renvoie le conteneur central à remplir.
 * @param {HTMLElement} root      point de montage (#app)
 * @param {object} profile        profil connecté
 * @param {object} opts           { showHome: bool, footerLeft: string }
 */
export function renderTabletShell(root, profile, opts = {}) {
  const { heure, jour } = texteHorloge();
  // Écran verrouillé : la tablette est allumée mais personne n'est identifié.
  // Le châssis reste rigoureusement le même (§3) ; seules disparaissent les
  // commandes qui n'ont pas de sens sans session — notifications, profil,
  // déconnexion.
  const verrouille = !profile;
  // Le mode invité n'est ni « connecté » ni « verrouillé » : la tablette est
  // utilisable, mais il n'y a ni profil, ni notifications, ni déconnexion — à
  // la place, une invitation à se connecter.
  const invite = verrouille && opts.invite === true;

  // Le châssis (fond, cadre, écran) vit désormais dans index.html et enveloppe
  // toute l'application. Ici on ne dessine plus que ce qui appartient à
  // l'accueil Newpad : en-tête, corps, pied.
  root.innerHTML = `
    <header class="np-header">
      ${opts.showHome
        ? `<button id="np-home" class="np-chip" title="Retour à l'accueil Newpad" aria-label="Accueil Newpad">◀ Accueil</button>`
        : ''}
      <div class="np-brand">
        <img src="${logoUrl}" alt="" />
        <div class="np-brand-name">NEWPAD</div>
      </div>

      <div class="np-clock">
        <strong id="np-clock-time">${heure}</strong>
        <span id="np-clock-date">${jour}</span>
      </div>

      <div class="np-header-actions" style="position:relative;">
        ${invite ? '<button id="np-signin" class="np-chip">Se connecter</button>' : ''}
        ${verrouille ? '' : `
        <button id="np-admin" class="np-chip" style="display:none;" title="Console d'administration">⚙</button>
        <button id="notif-bell" class="notif-bell" aria-label="Notifications">
          🔔
          <span id="notif-badge" class="notif-badge" style="display:none;">0</span>
        </button>
        <button class="np-chip np-chip-user" id="np-user">
          <span class="avatar" style="width:24px;height:24px;font-size:11px;">${initiales(profile.display_name)}</span>
          <strong>${escapeHtml(profile.display_name || '')}</strong>
        </button>
        <div id="notif-panel" class="notif-panel">
          <div class="notif-panel-header">
            <strong style="font-size:13px;">Notifications</strong>
            <button id="notif-mark-all" class="btn btn-ghost" style="padding:4px 8px; font-size:12px;">Tout marquer lu</button>
          </div>
          <div id="notif-list"></div>
        </div>`}
      </div>
    </header>

    <div class="np-body ${opts.scroll ? 'np-body-scroll' : ''}" id="np-body"></div>

    <footer class="np-footer">
      <span>${escapeHtml(opts.footerLeft || 'Newpad')}</span>
      <div id="np-footer-center" style="margin:0 auto;"></div>
      ${invite
        ? '<span class="muted" style="font-size:11px;letter-spacing:.12em;">Mode invité</span>'
        : (verrouille ? '<span></span>'
          : '<button id="np-logout" class="np-chip" style="height:28px;font-size:11px;letter-spacing:.1em;">Déconnexion</button>')}
    </footer>
  `;

  document.getElementById('np-home')?.addEventListener('click', () => navigate('/'));
  document.getElementById('np-signin')?.addEventListener('click', () => {
    quitterLeModeInvite();
    navigate('/login');
  });
  document.getElementById('np-user')?.addEventListener('click', () => navigate('/newpad/profil'));
  document.getElementById('np-logout')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    navigate('/login');
  });

  // Une horloge qui n'avance pas trahit immédiatement l'objet : le joueur
  // laisse sa tablette ouverte plusieurs minutes en jeu.
  if (horloge) clearInterval(horloge);
  horloge = setInterval(() => {
    const t = document.getElementById('np-clock-time');
    const j = document.getElementById('np-clock-date');
    if (!t || !j) { clearInterval(horloge); horloge = null; return; }
    const v = texteHorloge();
    t.textContent = v.heure;
    j.textContent = v.jour;
  }, 15000);

  if (!verrouille) {
    setupNotifications(profile).catch(() => { /* la tablette reste utilisable */ });

    // La console d'administration n'est pas une icône du lanceur : ce n'est pas
    // une application, et elle n'a pas à occuper une place sur l'écran d'accueil
    // de tous les joueurs. Elle apparaît dans l'en-tête, et seulement pour qui
    // y a droit — la vérification est faite en base, l'affichage n'est qu'un
    // confort : la route elle-même refuse quiconque n'est pas administrateur.
    const bouton = document.getElementById('np-admin');
    if (bouton) {
      isNewpadAdmin()
        .then((oui) => { if (oui) bouton.style.display = ''; })
        .catch(() => { /* pas d'accès : le bouton reste caché */ });
      bouton.addEventListener('click', () => navigate('/newpad/admin'));
    }
  }

  return {
    body: document.getElementById('np-body'),
    footerCenter: document.getElementById('np-footer-center'),
  };
}

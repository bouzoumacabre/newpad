// ============================================================================
// NEWPAD — écran d'une application réservée
// ============================================================================
// Cliquer sur une icône cadenassée ne doit pas se solder par un refus sec. Le
// joueur voit ce que l'application fait, pourquoi elle lui est fermée, et ce
// qu'il doit faire pour l'ouvrir — sinon le cadenas n'est qu'une frustration.

import { renderTabletShell } from './tabletShell.js';
import { appIconSvg } from '../../lib/appIcons.js';
import { escapeHtml } from '../../lib/format.js';
import { navigate } from '../../lib/router.js';
import { estInvite, quitterLeModeInvite } from '../../lib/guestMode.js';

export function renderLockedApp(root, profile, app) {
  const invite = !profile;
  const { body } = renderTabletShell(root, profile, {
    showHome: true,
    scroll: true,
    invite,
    footerLeft: app.name,
  });

  const couleur = app.accent_color || 'var(--gold)';
  const prospect = profile && profile.role === 'prospect';

  // Trois situations, trois issues différentes. Renvoyer tout le monde vers
  // « ouvrez un compte » serait faux pour un prospect dont la demande est déjà
  // en cours d'examen.
  let titre; let texte; let boutons;
  if (invite) {
    titre = 'Réservé aux clients';
    texte = "Vous consultez Newpad en invité. Cette application demande un compte Newman Bank — "
          + "c'est la même identité pour toutes les applications, jamais un compte par service.";
    boutons = `
      <button class="btn btn-primary" id="la-signup">Demander un compte</button>
      <button class="btn btn-secondary" id="la-login">J'ai déjà un compte</button>`;
  } else if (prospect) {
    titre = 'Demande en cours';
    texte = "Votre demande d'adhésion à Newman Bank est à l'étude. Dès qu'elle sera validée, "
          + 'cette application et toutes les autres s\'ouvriront automatiquement.';
    boutons = '<button class="btn btn-secondary" id="la-bank">Suivre ma demande</button>';
  } else {
    titre = 'Accès non accordé';
    texte = "Cette application n'est pas ouverte à votre compte. Si vous pensez qu'il s'agit d'une "
          + "erreur, contactez l'administration du serveur.";
    boutons = '<button class="btn btn-secondary" id="la-home">Retour à l\'accueil</button>';
  }

  body.innerHTML = `
    <div class="np-soon">
      <div class="np-soon-icon">
        <span style="color:${escapeHtml(couleur)};display:flex;">${appIconSvg(app.icon_key, 46)}</span>
      </div>
      <h1>${escapeHtml(app.name)}</h1>
      ${app.description ? `<p>${escapeHtml(app.description)}</p>` : ''}
      <p style="color:var(--gold-light);letter-spacing:.14em;text-transform:uppercase;font-size:11.5px;">
        ${escapeHtml(titre)}
      </p>
      <p>${escapeHtml(texte)}</p>
      <div class="flex items-center gap-sm" style="justify-content:center;flex-wrap:wrap;">${boutons}</div>
    </div>
  `;

  document.getElementById('la-signup')?.addEventListener('click', () => { quitterLeModeInvite(); navigate('/signup'); });
  document.getElementById('la-login')?.addEventListener('click', () => { quitterLeModeInvite(); navigate('/login'); });
  document.getElementById('la-bank')?.addEventListener('click', () => navigate('/prospect'));
  document.getElementById('la-home')?.addEventListener('click', () => navigate('/'));

  // `estInvite` sert au diagnostic : si le drapeau est posé mais qu'un profil
  // existe, c'est que la session a été ouverte sans quitter le mode invité.
  if (profile && estInvite()) quitterLeModeInvite();
}

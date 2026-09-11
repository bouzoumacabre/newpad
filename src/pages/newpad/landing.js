// ============================================================================
// NEWPAD — page de présentation
// ============================================================================
// Premier écran d'un visiteur sans compte. Son travail n'est pas de faire une
// belle promesse : c'est de rendre lisible en dix secondes ce que Newpad
// remplace, et d'ouvrir trois portes — se connecter, ouvrir un compte, ou
// simplement regarder.

import { renderTabletShell } from './tabletShell.js';
import { navigate, resolve } from '../../lib/router.js';
import { entrerEnInvite } from '../../lib/guestMode.js';
import { appIconSvg } from '../../lib/appIcons.js';
import { listLauncherApps } from '../../lib/newpadApi.js';
import { escapeHtml } from '../../lib/format.js';

// Ce que Newpad déplace hors de Discord (§0). Volontairement formulé par
// l'usage — « déposer une annonce », pas « NewMarket » : un nouveau joueur ne
// connaît aucun de ces noms.
const USAGES = [
  ['bank', 'Gérer son argent', 'Comptes, virements, prêts, coffres et lingots chez Newman Bank.'],
  ['news', "Suivre l'actualité", 'Le journal de la ville, ses enquêtes et ses annonces officielles.'],
  ['social', 'Exister publiquement', 'Réseau social, chaînes vidéo, audience et réputation.'],
  ['work', 'Travailler', 'Offres d\'emploi, candidatures, CV, back-office des entreprises.'],
  ['government', 'Faire ses démarches', 'Licences, permis, formulaires et rendez-vous administratifs.'],
  ['folder', 'Garder ses papiers', 'Un coffre documentaire unique, partagé par autorisation — jamais par copie.'],
];

const NIVEAUX = [
  ['Invité', 'Sans compte', 'Consultez les médias, les vidéos et le réseau social. Lecture seule.'],
  ['Client Newman Bank', 'Avec un compte', 'Toutes les applications : emploi, entreprises, démarches, assurances, immobilier, documents.'],
  ['Sur invitation', 'Accordé nommément', "Certains espaces ne s'ouvrent que si l'administration vous y autorise."],
];

export async function renderLanding(root) {
  const { body } = renderTabletShell(root, null, { scroll: true, footerLeft: 'Newpad' });

  // Le nombre d'applications vient du registre, il n'est pas écrit dans le
  // texte : une promesse chiffrée qui se périme au premier ajout est pire que
  // pas de chiffre du tout.
  let nbApps = 0;
  try { nbApps = (await listLauncherApps()).length; } catch (_) { /* le chiffre est facultatif */ }

  body.innerHTML = `
    <div class="np-landing">
      <section class="np-hero">
        <span class="np-hero-eyebrow">Hurricane FA</span>
        <h1>Newpad</h1>
        <p class="np-hero-claim">
          Toute la ville dans un seul appareil.
        </p>
        <p class="np-hero-sub">
          La banque, les médias, l'emploi, les entreprises, les démarches, vos papiers.
          Ce qui se réglait sur Discord se règle maintenant ici, en jeu.
        </p>
        <div class="np-hero-actions">
          <button class="btn btn-primary" id="np-go-login">Se connecter</button>
          <button class="btn btn-secondary" id="np-go-signup">Créer un compte</button>
          <button class="btn btn-ghost" id="np-go-guest">Entrer en invité →</button>
        </div>
        ${nbApps ? `<p class="np-hero-count">${nbApps} applications disponibles</p>` : ''}
      </section>

      <section class="np-section">
        <h2>Ce que vous y faites</h2>
        <div class="np-usages">
          ${USAGES.map(([icone, titre, texte]) => `
            <article class="np-usage">
              <span class="np-usage-icon">${appIconSvg(icone, 22)}</span>
              <h3>${escapeHtml(titre)}</h3>
              <p>${escapeHtml(texte)}</p>
            </article>`).join('')}
        </div>
      </section>

      <section class="np-section">
        <h2>Trois niveaux d'accès</h2>
        <div class="np-levels">
          ${NIVEAUX.map(([titre, condition, texte], i) => `
            <article class="np-level ${i === 1 ? 'is-highlight' : ''}">
              <span class="np-level-cond">${escapeHtml(condition)}</span>
              <h3>${escapeHtml(titre)}</h3>
              <p>${escapeHtml(texte)}</p>
            </article>`).join('')}
        </div>
        <p class="np-note">
          Un compte Newpad, c'est un compte Newman Bank : une seule identité pour
          toutes les applications, jamais un compte par service.
        </p>
      </section>

      <section class="np-closing">
        <p>Prêt ?</p>
        <button class="btn btn-primary" id="np-go-signup-2">Demander un compte</button>
      </section>
    </div>
  `;

  document.getElementById('np-go-login').addEventListener('click', () => navigate('/login'));
  document.getElementById('np-go-signup').addEventListener('click', () => navigate('/signup'));
  document.getElementById('np-go-signup-2').addEventListener('click', () => navigate('/signup'));
  document.getElementById('np-go-guest').addEventListener('click', async () => {
    entrerEnInvite();
    // On reste sur « / » : c'est le même écran qui, selon l'état, affiche la
    // présentation ou la tablette. Changer le hash ne redéclencherait rien.
    await resolve();
  });
}

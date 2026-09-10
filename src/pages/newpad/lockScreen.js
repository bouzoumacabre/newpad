// ============================================================================
// NEWPAD — écran verrouillé
// ============================================================================
// L'objet FiveM n'ouvre qu'une seule URL (§1). Ce que le joueur doit voir en
// l'utilisant, c'est SA TABLETTE — allumée, verrouillée, en attente de son
// identifiant. Renvoyer un visiteur non connecté sur la page vitrine de Newman
// Bank donnait l'impression que Newpad n'existait pas : la banque n'est qu'une
// application parmi les vingt-trois.
//
// L'authentification elle-même n'est pas réécrite : c'est le même
// `signInWithUsername` que l'écran de connexion existant, avec la même
// traduction d'erreurs. Seule la présentation change.

import { renderTabletShell } from './tabletShell.js';
import { signInWithUsername } from '../../lib/supabaseClient.js';
import { humanError } from '../../lib/errorMessages.js';
import { navigate } from '../../lib/router.js';

export function renderLockScreen(root) {
  const { body } = renderTabletShell(root, null, { footerLeft: 'Verrouillé' });

  body.innerHTML = `
    <div class="np-lock">
      <div class="np-lock-card">
        <h1>Newpad</h1>
        <p class="muted">Identifiez-vous pour accéder à vos applications.</p>
        <form id="np-lock-form" autocomplete="on">
          <div class="field">
            <label for="np-user-id">Identifiant</label>
            <input id="np-user-id" name="username" autocomplete="username" required />
          </div>
          <div class="field">
            <label for="np-pass">Mot de passe</label>
            <input id="np-pass" name="password" type="password" autocomplete="current-password" required />
          </div>
          <div id="np-lock-error" class="text-danger" style="display:none;margin-bottom:12px;font-size:13px;"></div>
          <button type="submit" class="btn btn-primary" style="width:100%;" id="np-lock-submit">Déverrouiller</button>
        </form>
        <div class="np-lock-links">
          <a href="#/signup">Pas encore de compte ?</a>
          <a href="#/forgot-password">Mot de passe oublié ?</a>
          <a href="#/bank/home">Découvrir Newman Bank</a>
        </div>
      </div>
    </div>
  `;

  document.getElementById('np-lock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const erreur = document.getElementById('np-lock-error');
    const bouton = document.getElementById('np-lock-submit');
    erreur.style.display = 'none';
    bouton.disabled = true;
    bouton.textContent = 'Connexion…';
    try {
      await signInWithUsername(
        document.getElementById('np-user-id').value,
        document.getElementById('np-pass').value
      );
      // La redirection est prise en charge par onAuthStateChange dans main.js :
      // un seul endroit décide où l'on atterrit après connexion.
    } catch (err) {
      erreur.textContent = humanError(err);
      erreur.style.display = 'block';
      bouton.disabled = false;
      bouton.textContent = 'Déverrouiller';
    }
  });

  document.getElementById('np-lock-card')?.addEventListener('click', () => navigate('/'));
}

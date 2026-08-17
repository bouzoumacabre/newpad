import logoUrl from '../../assets/logo.svg';
import { signUpProspect } from '../../lib/supabaseClient.js';
import { navigate } from '../../lib/router.js';

export function renderSignup(app) {
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card card">
        <div class="auth-brand">
          <img src="${logoUrl}" alt="Newman Bank" width="44" height="44" />
          <div>
            <div class="font-display auth-brand-title">Newman Bank</div>
            <div class="muted auth-brand-sub">BNW-VLT-1924</div>
          </div>
        </div>
        <h2>Devenir client</h2>
        <p class="muted" style="margin-bottom:20px;">
          Créez un accès prospect pour consulter nos services et soumettre une demande d'adhésion.
        </p>
        <form id="signup-form">
          <div class="field">
            <label for="display_name">Nom complet</label>
            <input id="display_name" name="display_name" required />
          </div>
          <div class="field">
            <label for="username">Identifiant souhaité</label>
            <input id="username" name="username" required pattern="[a-zA-Z0-9_.\\-]{3,32}" title="3 à 32 caractères, sans espace" />
          </div>
          <div class="field">
            <label for="password">Mot de passe</label>
            <input id="password" name="password" type="password" minlength="8" required />
          </div>
          <div class="field">
            <label for="discord_id">ID Discord (facultatif)</label>
            <input id="discord_id" name="discord_id" placeholder="Ex: 123456789012345678" />
            <div class="muted" style="font-size:12px; margin-top:4px;">Utilisé pour la réinitialisation de mot de passe et la liaison de compte.</div>
          </div>
          <div id="signup-error" class="text-danger" style="display:none;margin-bottom:12px;font-size:13px;"></div>
          <div id="signup-success" class="text-success" style="display:none;margin-bottom:12px;font-size:13px;"></div>
          <button type="submit" class="btn btn-primary" style="width:100%;">Créer mon accès prospect</button>
        </form>
        <p class="muted" style="margin-top:20px;text-align:center;font-size:13px;">
          Déjà client ou membre du personnel ? <a href="#/login">Se connecter</a>
        </p>
      </div>
    </div>
    <style>
      .auth-screen { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
      .auth-card { width:100%; max-width:420px; }
      .auth-brand { display:flex; align-items:center; gap:12px; margin-bottom:24px; }
      .auth-brand-title { font-size:20px; margin:0; }
      .auth-brand-sub { font-size:12px; letter-spacing:0.05em; }
    </style>
  `;

  document.getElementById('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('signup-error');
    const successEl = document.getElementById('signup-success');
    errorEl.style.display = 'none';
    successEl.style.display = 'none';
    const displayName = document.getElementById('display_name').value;
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const discordId = document.getElementById('discord_id').value.trim();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await signUpProspect({ username, password, displayName, discordId });
      successEl.textContent = 'Accès créé. Vous pouvez maintenant vous connecter et demander à devenir client.';
      successEl.style.display = 'block';
      setTimeout(() => navigate('/login'), 1800);
    } catch (err) {
      errorEl.textContent = err.message?.includes('already') || err.message?.includes('exist')
        ? 'Cet identifiant est déjà utilisé.'
        : "Impossible de créer l'accès pour le moment.";
      errorEl.style.display = 'block';
      submitBtn.disabled = false;
    }
  });
}

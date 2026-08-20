import logoUrl from '../../assets/logo.svg';
import { signInWithUsername } from '../../lib/supabaseClient.js';
import { navigate } from '../../lib/router.js';
import { DISCORD_INVITE_URL } from '../../lib/constants.js';
import { attachExternalLinkCopy } from '../../lib/externalLink.js';

export async function renderLogin(app) {
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
        <h2>Espace client &amp; personnel</h2>
        <p class="muted" style="margin-bottom:20px;">Connectez-vous avec votre identifiant Newpad.</p>
        <form id="login-form">
          <div class="field">
            <label for="username">Identifiant</label>
            <input id="username" name="username" autocomplete="username" required />
          </div>
          <div class="field">
            <label for="password">Mot de passe</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required />
          </div>
          <div id="login-error" class="text-danger" style="display:none;margin-bottom:12px;font-size:13px;"></div>
          <button type="submit" class="btn btn-primary" style="width:100%;">Se connecter</button>
        </form>
        <p class="muted" style="margin-top:20px;text-align:center;font-size:13px;">
          Pas encore client ? <a href="#/signup">Demander à devenir client</a>
        </p>
        <p style="margin-top:8px;text-align:center;font-size:13px;">
          <a href="#/forgot-password">Mot de passe oublié ?</a>
        </p>
        <p style="margin-top:8px;text-align:center;font-size:13px;">
          <a href="#/" class="muted">&larr; Retour à l'accueil</a>
        </p>
        <p style="margin-top:8px;text-align:center;font-size:13px;">
          <a href="${DISCORD_INVITE_URL}" target="_blank" rel="noopener noreferrer" data-copy="${DISCORD_INVITE_URL}">Discord Newman Bank</a>
        </p>
      </div>
    </div>
    <style>
      .auth-screen { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
      .auth-card { width:100%; max-width:400px; }
      .auth-brand { display:flex; align-items:center; gap:12px; margin-bottom:24px; }
      .auth-brand-title { font-size:20px; margin:0; }
      .auth-brand-sub { font-size:12px; letter-spacing:0.05em; }
    </style>
  `;

  attachExternalLinkCopy(app);

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('login-error');
    errorEl.style.display = 'none';
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Connexion…';
    try {
      await signInWithUsername(username, password);
      // La redirection par rôle est gérée par onAuthStateChange dans main.js
    } catch (err) {
      errorEl.textContent = "Identifiant ou mot de passe incorrect.";
      errorEl.style.display = 'block';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Se connecter';
    }
  });
}

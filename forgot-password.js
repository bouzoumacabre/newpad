import logoUrl from '../../assets/logo.svg';
import { requestPasswordReset, confirmPasswordReset } from '../../lib/supabaseClient.js';
import { navigate } from '../../lib/router.js';

export function renderForgotPassword(app) {
  let step = 'request'; // 'request' -> 'confirm'
  let rememberedUsername = '';

  function draw() {
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
          <h2>Mot de passe oublié</h2>

          ${
            step === 'request'
              ? `
            <p class="muted" style="margin-bottom:20px;">
              Un code à usage unique sera envoyé par message privé Discord au compte lié à votre identifiant.
              Vous devez être membre du serveur Hurricane FA et autoriser les messages privés des membres du serveur.
            </p>
            <form id="request-form">
              <div class="field">
                <label for="username">Identifiant</label>
                <input id="username" name="username" required value="${rememberedUsername.replace(/"/g, '&quot;')}" />
              </div>
              <div id="request-error" class="text-danger" style="display:none;margin-bottom:12px;font-size:13px;"></div>
              <div id="request-info" class="muted" style="display:none;margin-bottom:12px;font-size:13px;"></div>
              <button type="submit" class="btn btn-primary" style="width:100%;">Recevoir un code par Discord</button>
            </form>
          `
              : `
            <p class="muted" style="margin-bottom:20px;">
              Un code a été envoyé par Discord si un compte existe pour <strong>${rememberedUsername}</strong> avec un ID Discord enregistré.
              Il est valable 15 minutes.
            </p>
            <form id="confirm-form">
              <div class="field">
                <label for="code">Code reçu par Discord</label>
                <input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" placeholder="123456" required />
              </div>
              <div class="field">
                <label for="new-password">Nouveau mot de passe</label>
                <input id="new-password" name="new-password" type="password" minlength="8" required />
              </div>
              <div id="confirm-error" class="text-danger" style="display:none;margin-bottom:12px;font-size:13px;"></div>
              <div id="confirm-success" class="text-success" style="display:none;margin-bottom:12px;font-size:13px;"></div>
              <button type="submit" class="btn btn-primary" style="width:100%;">Réinitialiser le mot de passe</button>
            </form>
            <p class="muted" style="margin-top:14px;text-align:center;font-size:13px;">
              <a href="#" id="back-to-request">&larr; Je n'ai pas reçu de code, recommencer</a>
            </p>
          `
          }

          <p class="muted" style="margin-top:20px;text-align:center;font-size:13px;">
            <a href="#/login">&larr; Retour à la connexion</a>
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

    if (step === 'request') {
      document.getElementById('request-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = document.getElementById('request-error');
        const infoEl = document.getElementById('request-info');
        errorEl.style.display = 'none';
        infoEl.style.display = 'none';
        const username = document.getElementById('username').value.trim();
        if (!username) return;
        const submitBtn = e.target.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Envoi…';
        try {
          const result = await requestPasswordReset(username);
          rememberedUsername = username;
          step = 'confirm';
          draw();
          void result;
        } catch (err) {
          errorEl.textContent = err.message || 'Une erreur est survenue.';
          errorEl.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Recevoir un code par Discord';
        }
      });
    } else {
      document.getElementById('confirm-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errorEl = document.getElementById('confirm-error');
        const successEl = document.getElementById('confirm-success');
        errorEl.style.display = 'none';
        successEl.style.display = 'none';
        const code = document.getElementById('code').value.trim();
        const newPassword = document.getElementById('new-password').value;
        const submitBtn = e.target.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.textContent = 'Réinitialisation…';
        try {
          await confirmPasswordReset({ username: rememberedUsername, code, newPassword });
          successEl.textContent = 'Mot de passe mis à jour. Vous pouvez maintenant vous connecter.';
          successEl.style.display = 'block';
          setTimeout(() => navigate('/login'), 1800);
        } catch (err) {
          errorEl.textContent = err.message || 'Une erreur est survenue.';
          errorEl.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = 'Réinitialiser le mot de passe';
        }
      });
      document.getElementById('back-to-request').addEventListener('click', (e) => {
        e.preventDefault();
        step = 'request';
        draw();
      });
    }
  }

  draw();
}

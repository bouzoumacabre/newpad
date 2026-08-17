import { renderAdminShell } from './shell.js';
import { updateDisplayName, updatePassword } from '../../lib/employeeApi.js';
import { escapeHtml } from '../../lib/format.js';

export async function renderAdminSettings(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'settings');

  content.innerHTML = `
    <h1 style="margin-bottom:20px;">Paramètres</h1>

    <div class="grid" style="grid-template-columns: 1fr 1fr; align-items:start;">
      <div class="card">
        <h3 style="margin-bottom:16px;">Profil</h3>
        <div class="field">
          <label>Identifiant</label>
          <input type="text" value="${escapeHtml(profile.username)}" disabled />
        </div>
        <div class="field">
          <label>Nom affiché</label>
          <input type="text" id="display-name" value="${escapeHtml(profile.display_name)}" />
        </div>
        <div class="field">
          <label>Fonction</label>
          <input type="text" value="${escapeHtml(profile.employee_title || '—')}" disabled />
        </div>
        <div id="profile-msg" style="font-size:13px; margin-bottom:12px; display:none;"></div>
        <button id="save-profile" class="btn btn-primary">Enregistrer</button>
      </div>

      <div class="card">
        <h3 style="margin-bottom:16px;">Mot de passe</h3>
        <div class="field">
          <label>Nouveau mot de passe</label>
          <input type="password" id="new-password" placeholder="••••••••" />
        </div>
        <div class="field">
          <label>Confirmer le mot de passe</label>
          <input type="password" id="confirm-password" placeholder="••••••••" />
        </div>
        <div id="password-msg" style="font-size:13px; margin-bottom:12px; display:none;"></div>
        <button id="save-password" class="btn btn-primary">Changer le mot de passe</button>
      </div>
    </div>
  `;

  document.getElementById('save-profile').addEventListener('click', async () => {
    const msg = document.getElementById('profile-msg');
    const displayName = document.getElementById('display-name').value.trim();
    if (!displayName) return;
    try {
      await updateDisplayName(displayName);
      msg.textContent = 'Profil mis à jour.';
      msg.className = 'text-success';
      msg.style.display = 'block';
    } catch (err) {
      msg.textContent = err.message || 'Erreur.';
      msg.className = 'text-danger';
      msg.style.display = 'block';
    }
  });

  document.getElementById('save-password').addEventListener('click', async () => {
    const msg = document.getElementById('password-msg');
    const pw = document.getElementById('new-password').value;
    const confirm = document.getElementById('confirm-password').value;
    if (!pw || pw.length < 8) {
      msg.textContent = 'Le mot de passe doit contenir au moins 8 caractères.';
      msg.className = 'text-danger';
      msg.style.display = 'block';
      return;
    }
    if (pw !== confirm) {
      msg.textContent = 'Les mots de passe ne correspondent pas.';
      msg.className = 'text-danger';
      msg.style.display = 'block';
      return;
    }
    try {
      await updatePassword(pw);
      msg.textContent = 'Mot de passe changé avec succès.';
      msg.className = 'text-success';
      msg.style.display = 'block';
      document.getElementById('new-password').value = '';
      document.getElementById('confirm-password').value = '';
    } catch (err) {
      msg.textContent = err.message || 'Erreur.';
      msg.className = 'text-danger';
      msg.style.display = 'block';
    }
  });
}

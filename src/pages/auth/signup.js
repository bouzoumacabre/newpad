import logoUrl from '../../assets/logo.svg';
import { signUpProspect } from '../../lib/supabaseClient.js';
import { submitMembershipRequest } from '../../lib/clientApi.js';
import { navigate } from '../../lib/router.js';
import { getSystemFlags } from '../../lib/systemSettings.js';
import { escapeHtml } from '../../lib/format.js';
import { humanError } from '../../lib/errorMessages.js';

const ACCOUNT_TYPES = [
  { value: 'courant', label: 'Compte courant' },
  { value: 'epargne', label: 'Compte épargne' },
  { value: 'entreprise', label: 'Compte entreprise' },
];

export async function renderSignup(app) {
  const flags = await getSystemFlags().catch(() => null);
  if (flags?.maintenanceEnabled) {
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
          <h2>Ouvertures de compte suspendues</h2>
          <p class="muted" style="margin-bottom:20px;">
            🛠 Newman Bank effectue actuellement une opération de maintenance. L'ouverture de nouveaux comptes est temporairement indisponible — réessayez un peu plus tard.
          </p>
          ${flags.bannerMessage ? `<p class="muted" style="margin-bottom:20px;">${escapeHtml(flags.bannerMessage)}</p>` : ''}
          <p class="muted" style="text-align:center;font-size:13px;">
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
    return;
  }

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
          Créez votre accès et soumettez votre demande d'adhésion en une seule étape.
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
            <label for="discord_id">ID Discord (obligatoire)</label>
            <input id="discord_id" name="discord_id" placeholder="Ex: 123456789012345678" required pattern="[0-9]{15,25}" title="Identifiant numérique Discord (clic droit sur votre profil → Copier l'identifiant, en mode développeur)" />
            <div class="muted" style="font-size:12px; margin-top:4px;">
              Obligatoire : c'est le seul moyen de réinitialiser votre mot de passe en cas d'oubli (via un message privé Discord). Sans ID Discord valide et à jour, un mot de passe perdu ne pourra pas être récupéré.
            </div>
          </div>
          <div class="field">
            <label for="phone_number">Numéro de téléphone (obligatoire)</label>
            <input id="phone_number" name="phone_number" placeholder="Ex: 555394399" required />
            <div class="muted" style="font-size:12px; margin-top:4px;">
              Obligatoire : c'est le moyen que la banque utilise pour vous joindre directement.
            </div>
          </div>
          <hr style="border-color: var(--border-color, rgba(255,255,255,0.1)); margin: 20px 0;" />
          <h3 style="font-size:15px; margin: 0 0 4px;">Demande d'adhésion</h3>
          <p class="muted" style="font-size:13px; margin-bottom:16px;">
            Devenez client de Newman Bank en une seule étape — cette demande sera examinée par notre personnel.
          </p>
          <div class="field">
            <label for="account_type">Type de compte souhaité</label>
            <select id="account_type" name="account_type">
              ${ACCOUNT_TYPES.map((t) => `<option value="${t.value}">${t.label}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="initial_deposit">Dépôt initial ($)</label>
            <input id="initial_deposit" name="initial_deposit" type="number" min="0" step="0.01" required />
          </div>
          <div class="field">
            <label for="motivation">Motivation</label>
            <textarea id="motivation" name="motivation" rows="4" placeholder="Présentez-vous brièvement..."></textarea>
          </div>
          <div style="position:absolute; left:-9999px; top:-9999px;" aria-hidden="true">
            <label for="website">Laissez ce champ vide</label>
            <input id="website" name="website" type="text" tabindex="-1" autocomplete="off" />
          </div>
          <div id="signup-error" class="text-danger" style="display:none;margin-bottom:12px;font-size:13px;"></div>
          <div id="signup-success" class="text-success" style="display:none;margin-bottom:12px;font-size:13px;"></div>
          <button type="submit" class="btn btn-primary" style="width:100%;">Créer mon compte et envoyer ma demande</button>
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
    const phoneNumber = document.getElementById('phone_number').value.trim();
    const requestedAccountType = document.getElementById('account_type').value;
    const initialDeposit = parseFloat(document.getElementById('initial_deposit').value);
    const motivation = document.getElementById('motivation').value.trim();
    const honeypot = document.getElementById('website').value;
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await signUpProspect({ username, password, displayName, discordId, phoneNumber, honeypot });
      // Le compte est créé et la session ouverte immédiatement (email de
      // confirmation désactivé côté Supabase) : on peut donc enchaîner
      // directement sur la demande d'adhésion, en une seule étape pour
      // l'utilisateur, sans repasser par un écran de connexion intermédiaire.
      try {
        await submitMembershipRequest({ requestedAccountType, initialDeposit, motivation });
        successEl.textContent = 'Accès créé et demande d\'adhésion envoyée. Redirection...';
        successEl.style.display = 'block';
        setTimeout(() => navigate('/prospect'), 1200);
      } catch (reqErr) {
        // Le compte existe déjà à ce stade — on ne le perd pas : on renvoie
        // simplement vers l'espace prospect pour que la demande soit
        // (re)soumise manuellement depuis là. La raison exacte de l'échec est
        // affichée, sans quoi l'utilisateur réessaierait à l'aveugle.
        successEl.textContent = `Accès créé. En revanche, l'envoi de la demande a échoué : ${humanError(reqErr)} Redirection vers votre espace pour réessayer…`;
        successEl.style.display = 'block';
        setTimeout(() => navigate('/prospect'), 2600);
      }
    } catch (err) {
      errorEl.textContent = humanError(err, "Impossible de créer l'accès pour le moment. Réessayez dans un instant.");
      errorEl.style.display = 'block';
      submitBtn.disabled = false;
    }
  });
}

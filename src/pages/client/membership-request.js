import logoUrl from '../../assets/logo.svg';
import { supabase } from '../../lib/supabaseClient.js';
import { getMyMembershipRequest, submitMembershipRequest } from '../../lib/clientApi.js';
import { formatMoney, formatDateTime, statusLabel, escapeHtml } from '../../lib/format.js';
import { humanError } from '../../lib/errorMessages.js';

const ACCOUNT_TYPES = [
  { value: 'courant', label: 'Compte courant' },
  { value: 'epargne', label: 'Compte épargne' },
  { value: 'entreprise', label: 'Compte entreprise' },
];

export async function renderMembershipRequest(app, profile) {
  const existing = await getMyMembershipRequest().catch(() => null);

  if (existing && existing.status !== 'rejected') {
    renderStatus(app, profile, existing);
    return;
  }

  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card card" style="max-width:480px;">
        <div class="auth-brand">
          <img src="${logoUrl}" alt="Newman Bank" width="44" height="44" />
          <div>
            <div class="font-display auth-brand-title">Newman Bank</div>
            <div class="muted auth-brand-sub">BNW-VLT-1924</div>
          </div>
        </div>
        <h2>Demande d'adhésion</h2>
        <p class="muted" style="margin-bottom:20px;">
          Bienvenue, ${escapeHtml(profile.display_name)}. Complétez cette demande pour devenir client de Newman Bank —
          elle sera examinée par notre personnel.
          ${existing ? '<br/><span class="text-danger">Votre précédente demande a été refusée ; vous pouvez en soumettre une nouvelle.</span>' : ''}
        </p>
        <form id="membership-form">
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
          <div id="membership-error" class="text-danger" style="display:none;margin-bottom:12px;font-size:13px;"></div>
          <button type="submit" class="btn btn-primary" style="width:100%;">Envoyer ma demande</button>
        </form>
        <button id="logout-btn" class="btn btn-ghost" style="width:100%; margin-top:12px;">Déconnexion</button>
      </div>
    </div>
    <style>
      .auth-screen { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
      .auth-card { width:100%; }
      .auth-brand { display:flex; align-items:center; gap:12px; margin-bottom:24px; }
      .auth-brand-title { font-size:20px; margin:0; }
      .auth-brand-sub { font-size:12px; letter-spacing:0.05em; }
    </style>
  `;

  document.getElementById('logout-btn').addEventListener('click', async () => { await supabase.auth.signOut(); });

  document.getElementById('membership-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('membership-error');
    errorEl.style.display = 'none';
    const requestedAccountType = document.getElementById('account_type').value;
    const initialDeposit = parseFloat(document.getElementById('initial_deposit').value);
    const motivation = document.getElementById('motivation').value.trim();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    try {
      await submitMembershipRequest({ requestedAccountType, initialDeposit, motivation });
      const fresh = await getMyMembershipRequest();
      renderStatus(app, profile, fresh);
    } catch (err) {
      // Cas fréquent depuis la migration 0020 : une demande est déjà ouverte.
      // L'écran est alors rafraîchi vers l'état réel plutôt que de laisser un
      // formulaire qui ne pourra jamais aboutir.
      const message = humanError(err, "Impossible d'envoyer la demande pour le moment.");
      if (/déjà une demande/i.test(message)) {
        const fresh = await getMyMembershipRequest().catch(() => null);
        if (fresh) { renderStatus(app, profile, fresh); return; }
      }
      errorEl.textContent = message;
      errorEl.style.display = 'block';
      submitBtn.disabled = false;
    }
  });
}

function renderStatus(app, profile, request) {
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card card" style="max-width:480px; text-align:center;">
        <div class="auth-brand" style="justify-content:center;">
          <img src="${logoUrl}" alt="Newman Bank" width="44" height="44" />
        </div>
        <h2>Demande en cours d'examen</h2>
        <p class="muted" style="margin-bottom:20px;">
          Votre demande d'adhésion soumise le ${formatDateTime(request.created_at)} pour un dépôt initial de
          ${formatMoney(request.initial_deposit)} est actuellement <strong class="gold">${statusLabel(request.status)}</strong>.
          Vous serez notifié(e) dès qu'un membre du personnel aura traité votre dossier.
        </p>
        <button id="refresh-btn" class="btn btn-secondary" style="width:100%; margin-bottom:12px;">Actualiser</button>
        <button id="logout-btn" class="btn btn-ghost" style="width:100%;">Déconnexion</button>
      </div>
    </div>
    <style>
      .auth-screen { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
      .auth-brand { display:flex; align-items:center; gap:12px; margin-bottom:24px; }
    </style>
  `;
  document.getElementById('logout-btn').addEventListener('click', async () => { await supabase.auth.signOut(); });
  document.getElementById('refresh-btn').addEventListener('click', () => window.location.reload());
}

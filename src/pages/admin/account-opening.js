import { renderAdminShell } from './shell.js';
import {
  getManualAccountOpenings,
  createManualAccountOpening,
  finalizeManualAccountOpening,
  searchProfilesAnyRole,
  createAccount,
} from '../../lib/employeeApi.js';
import { formatMoney, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';

const ACCOUNT_TYPES = [
  { value: 'courant', label: 'Compte courant' },
  { value: 'epargne', label: 'Compte épargne' },
  { value: 'entreprise', label: 'Compte entreprise' },
];

export async function renderAdminAccountOpening(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'account-opening');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const openings = await getManualAccountOpenings().catch(() => []);

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Ouverture de compte au guichet</h1>
      <p class="muted" style="margin-bottom:20px;">
        Enregistrez la demande ci-dessous, puis finalisez-la soit en créant directement le compte de la personne
        (identifiant + mot de passe), soit en reliant une demande à un profil qu'elle a déjà créé elle-même
        (auto-inscription prospect depuis la page d'accueil).
      </p>

      <div class="grid" style="grid-template-columns: 1fr 1.3fr; align-items:start;">
        <div class="card">
          <h3 style="margin-bottom:16px;">Nouvelle demande</h3>
          <div class="field">
            <label>Nom du client</label>
            <input type="text" id="opening-name" placeholder="Nom complet" />
          </div>
          <div class="field">
            <label>Type de compte</label>
            <select id="opening-type">
              ${ACCOUNT_TYPES.map((t) => `<option value="${t.value}">${t.label}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Dépôt initial ($)</label>
            <input type="number" id="opening-deposit" min="0" step="0.01" value="0" />
          </div>
          <div id="opening-error" class="text-danger" style="font-size:13px; margin-bottom:12px; display:none;"></div>
          <button id="opening-submit" class="btn btn-primary" style="width:100%;">Enregistrer la demande</button>
        </div>

        <div class="card">
          <h3 style="margin-bottom:12px;">Demandes en cours</h3>
          ${
            openings.length
              ? openings
                  .map(
                    (o) => `
            <div style="padding:14px 0; border-bottom:1px solid var(--card-border);">
              <div class="flex justify-between items-center" style="margin-bottom:6px;">
                <div style="font-weight:600;">${escapeHtml(o.display_name)}</div>
                ${statusBadge(o.status)}
              </div>
              <div class="muted" style="font-size:12px; margin-bottom:8px;">
                ${escapeHtml(o.account_type)} — ${formatMoney(o.initial_deposit)} — ${formatDateTime(o.created_at)}
                ${o.requires_admin_override ? ' — <span class="text-danger">autorisation admin requise</span>' : ''}
              </div>
              ${
                o.status === 'pending'
                  ? `
                <div class="flex gap-sm" style="margin-bottom:8px;">
                  <button class="btn btn-primary create-toggle-btn" data-id="${o.id}" style="flex:1;">Créer le compte maintenant</button>
                </div>
                <div class="create-account-form" data-id="${o.id}" style="display:none; margin-bottom:8px; padding:10px; background:rgba(255,255,255,0.02); border-radius:var(--radius-sm);">
                  <div class="field" style="margin-bottom:8px;">
                    <label style="font-size:11px;">Identifiant</label>
                    <input type="text" class="create-username" data-id="${o.id}" placeholder="ex: jdupont" />
                  </div>
                  <div class="field" style="margin-bottom:8px;">
                    <label style="font-size:11px;">Mot de passe (min. 8 caractères)</label>
                    <input type="password" class="create-password" data-id="${o.id}" placeholder="••••••••" />
                  </div>
                  <div class="field" style="margin-bottom:8px;">
                    <label style="font-size:11px;">ID Discord (facultatif)</label>
                    <input type="text" class="create-discord-id" data-id="${o.id}" placeholder="Ex: 123456789012345678" />
                  </div>
                  <div class="create-account-error text-danger" data-id="${o.id}" style="font-size:12px; margin-bottom:8px; display:none;"></div>
                  <button class="btn btn-primary create-submit-btn" data-id="${o.id}" style="width:100%;">Créer et finaliser</button>
                </div>
                <div class="flex gap-sm">
                  <input type="text" class="finalize-username" data-id="${o.id}" placeholder="...ou identifiant d'un profil déjà existant" style="flex:1;" />
                  <button class="btn btn-secondary finalize-btn" data-id="${o.id}">Finaliser</button>
                </div>
              `
                  : ''
              }
            </div>
          `
                  )
                  .join('')
              : `<p class="muted">Aucune demande enregistrée.</p>`
          }
        </div>
      </div>
    `;

    document.getElementById('opening-submit').addEventListener('click', async () => {
      const errorEl = document.getElementById('opening-error');
      errorEl.style.display = 'none';
      const displayName = document.getElementById('opening-name').value.trim();
      const accountType = document.getElementById('opening-type').value;
      const initialDeposit = parseFloat(document.getElementById('opening-deposit').value) || 0;
      if (!displayName) {
        errorEl.textContent = 'Veuillez renseigner le nom du client.';
        errorEl.style.display = 'block';
        return;
      }
      try {
        await createManualAccountOpening({ displayName, accountType, initialDeposit });
        await draw();
      } catch (err) {
        errorEl.textContent = err.message || "Erreur lors de l'enregistrement.";
        errorEl.style.display = 'block';
      }
    });

    content.querySelectorAll('.finalize-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const input = content.querySelector(`.finalize-username[data-id="${id}"]`);
        const username = input.value.trim();
        if (!username) { await showAlert('Veuillez saisir l\'identifiant du profil déjà créé par le client.'); return; }
        try {
          const matches = await searchProfilesAnyRole(username);
          const exact = matches.find((m) => m.username.toLowerCase() === username.toLowerCase());
          if (!exact) { await showAlert('Aucun profil trouvé avec cet identifiant exact. Le client doit d\'abord créer son accès prospect.'); return; }
          await finalizeManualAccountOpening(id, exact.id);
          await draw();
        } catch (err) {
          await showAlert(err.message || 'Erreur lors de la finalisation.');
        }
      });
    });

    content.querySelectorAll('.create-toggle-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const form = content.querySelector(`.create-account-form[data-id="${id}"]`);
        form.style.display = form.style.display === 'none' ? 'block' : 'none';
      });
    });

    content.querySelectorAll('.create-submit-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const opening = openings.find((o) => o.id === id);
        const errorEl = content.querySelector(`.create-account-error[data-id="${id}"]`);
        errorEl.style.display = 'none';
        const username = content.querySelector(`.create-username[data-id="${id}"]`).value.trim();
        const password = content.querySelector(`.create-password[data-id="${id}"]`).value;
        const discordId = content.querySelector(`.create-discord-id[data-id="${id}"]`).value.trim();
        if (!username || !password) {
          errorEl.textContent = 'Identifiant et mot de passe requis.';
          errorEl.style.display = 'block';
          return;
        }
        try {
          const created = await createAccount({ username, password, displayName: opening.display_name, role: 'client', discordId: discordId || null });
          await finalizeManualAccountOpening(id, created.id);
          await draw();
        } catch (err) {
          errorEl.textContent = err.message || 'Erreur lors de la création du compte.';
          errorEl.style.display = 'block';
        }
      });
    });
  }

  await draw();
}

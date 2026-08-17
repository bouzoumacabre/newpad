import { renderAdminShell } from './shell.js';
import {
  getManualAccountOpenings,
  createManualAccountOpening,
  finalizeManualAccountOpening,
  searchProfilesAnyRole,
} from '../../lib/employeeApi.js';
import { formatMoney, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';

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
        La création d'un tout nouveau compte d'authentification nécessite une fonctionnalité serveur (Edge Function,
        clé service_role) pas encore déployée. En attendant : enregistrez la demande ci-dessous, puis finalisez-la
        une fois que la personne a créé son accès prospect (auto-inscription) depuis la page d'accueil.
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
                <div class="flex gap-sm">
                  <input type="text" class="finalize-username" data-id="${o.id}" placeholder="Identifiant du profil existant..." style="flex:1;" />
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
        if (!username) { alert('Veuillez saisir l\'identifiant du profil déjà créé par le client.'); return; }
        try {
          const matches = await searchProfilesAnyRole(username);
          const exact = matches.find((m) => m.username.toLowerCase() === username.toLowerCase());
          if (!exact) { alert('Aucun profil trouvé avec cet identifiant exact. Le client doit d\'abord créer son accès prospect.'); return; }
          await finalizeManualAccountOpening(id, exact.id);
          await draw();
        } catch (err) {
          alert(err.message || 'Erreur lors de la finalisation.');
        }
      });
    });
  }

  await draw();
}

import { renderAdminShell } from './shell.js';
import { getVisibilityMasks, setVisibilityMask } from '../../lib/adminApi.js';
import { searchClients, getClientAccounts, listStaffTransactions } from '../../lib/employeeApi.js';
import { formatDateTime, formatMoney, escapeHtml } from '../../lib/format.js';

const TARGET_TYPES = ['account', 'transaction'];
const INTERFACES = ['client', 'employee', 'admin', 'irs', 'public'];

export async function renderAdminVisibility(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'visibility');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  let query = '';
  let clientResults = [];
  let selectedClient = null;
  let selectedAccounts = [];
  let selectedTransactions = [];
  let selectedTargetType = 'account';
  let selectedTargetId = '';
  let selectedTargetLabel = '';

  async function draw() {
    const masks = await getVisibilityMasks().catch(() => []);

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Masquage par interface</h1>
      <p class="muted" style="margin-bottom:20px;">
        Masque un compte ou une transaction précis sur une ou plusieurs interfaces (ex : dissimuler une opération à
        l'IRS). Recherchez un client ci-dessous pour choisir directement l'un de ses comptes ou l'une de ses
        transactions — la saisie manuelle d'un UUID reste possible si vous le connaissez déjà.
      </p>

      <div class="grid" style="grid-template-columns: 1fr 1fr; align-items:start; margin-bottom:24px;">
        <div class="card">
          <h3 style="margin-bottom:12px;">1. Choisir un client</h3>
          <div class="field">
            <input type="text" id="mask-client-search" placeholder="Nom ou identifiant..." value="${escapeHtml(query)}" />
          </div>
          <div style="max-height:220px; overflow-y:auto;">
            ${
              clientResults.length
                ? clientResults
                    .map(
                      (r) => `
              <div class="mask-client-row" data-id="${r.id}" style="padding:10px 8px; border-radius:var(--radius-sm); cursor:pointer; ${selectedClient?.id === r.id ? 'background: rgba(201,162,39,0.1);' : ''}">
                <div style="font-weight:600; font-size:14px;">${escapeHtml(r.display_name)}</div>
                <div class="muted" style="font-size:12px;">@${escapeHtml(r.username)}</div>
              </div>
            `
                    )
                    .join('')
                : `<p class="muted" style="padding:8px;">${query.trim().length < 2 ? 'Saisissez au moins 2 caractères.' : 'Aucun résultat.'}</p>`
            }
          </div>
        </div>

        <div class="card">
          <h3 style="margin-bottom:12px;">2. Choisir un compte ou une transaction</h3>
          ${
            selectedClient
              ? `
            <div class="muted" style="font-size:12px; margin-bottom:8px;">Comptes de ${escapeHtml(selectedClient.display_name)}</div>
            ${
              selectedAccounts.length
                ? selectedAccounts
                    .map(
                      (a) => `
              <div class="mask-pick-row" data-type="account" data-id="${a.id}" data-label="Compte ${escapeHtml(a.iban)}" style="padding:8px; border-radius:var(--radius-sm); cursor:pointer; font-size:13px; ${selectedTargetType === 'account' && selectedTargetId === a.id ? 'background: rgba(201,162,39,0.1);' : ''}">
                ${escapeHtml(a.account_type)} — ${escapeHtml(a.iban)} — ${formatMoney(a.balance)}
              </div>
            `
                    )
                    .join('')
                : '<p class="muted" style="font-size:12px;">Aucun compte.</p>'
            }
            <div class="muted" style="font-size:12px; margin:12px 0 8px;">Transactions récentes</div>
            ${
              selectedTransactions.length
                ? selectedTransactions
                    .map(
                      (t) => `
              <div class="mask-pick-row" data-type="transaction" data-id="${t.id}" data-label="Transaction du ${formatDateTime(t.created_at)}" style="padding:8px; border-radius:var(--radius-sm); cursor:pointer; font-size:13px; ${selectedTargetType === 'transaction' && selectedTargetId === t.id ? 'background: rgba(201,162,39,0.1);' : ''}">
                ${escapeHtml(t.tx_type)} — ${formatMoney(t.amount)} — ${formatDateTime(t.created_at)}
              </div>
            `
                    )
                    .join('')
                : '<p class="muted" style="font-size:12px;">Aucune transaction récente.</p>'
            }
          `
              : `<p class="muted">Sélectionnez d'abord un client à gauche.</p>`
          }
        </div>
      </div>

      <div class="card" style="margin-bottom:24px;">
        <h3 style="margin-bottom:16px;">3. Ajouter / mettre à jour le masquage</h3>
        ${selectedTargetId ? `<p style="font-size:13px; margin-bottom:12px;">Cible sélectionnée : <strong class="gold">${escapeHtml(selectedTargetLabel)}</strong></p>` : ''}
        <div class="grid" style="grid-template-columns: 1fr 2fr; gap:10px;">
          <div class="field" style="margin:0;">
            <label>Type de cible</label>
            <select id="mask-type">
              ${TARGET_TYPES.map((t) => `<option value="${t}" ${t === selectedTargetType ? 'selected' : ''}>${t}</option>`).join('')}
            </select>
          </div>
          <div class="field" style="margin:0;">
            <label>Identifiant (UUID)</label>
            <input type="text" id="mask-id" placeholder="00000000-0000-0000-0000-000000000000" value="${escapeHtml(selectedTargetId)}" />
          </div>
        </div>
        <div class="field">
          <label>Masquer sur les interfaces</label>
          <div class="flex gap-md" style="flex-wrap:wrap;">
            ${INTERFACES.map((i) => `
              <label class="flex items-center gap-sm" style="font-size:13px; font-weight:400;">
                <input type="checkbox" class="mask-iface" value="${i}" /> ${i}
              </label>
            `).join('')}
          </div>
        </div>
        <div class="field">
          <label>Motif</label>
          <input type="text" id="mask-reason" placeholder="Optionnel" />
        </div>
        <div id="mask-error" class="text-danger" style="font-size:13px; margin-bottom:10px; display:none;"></div>
        <button id="mask-submit" class="btn btn-primary">Enregistrer</button>
      </div>

      <h3 style="margin-bottom:12px;">Masquages actifs (${masks.length})</h3>
      <div class="card">
        ${
          masks.length
            ? `<table>
                <thead><tr><th>Type</th><th>Identifiant</th><th>Masqué sur</th><th>Motif</th><th>Créé le</th></tr></thead>
                <tbody>
                  ${masks
                    .map(
                      (m) => `
                    <tr>
                      <td>${escapeHtml(m.target_type)}</td>
                      <td class="muted" style="font-size:12px;">${escapeHtml(m.target_id)}</td>
                      <td>${(m.hidden_from_interfaces || []).map((i) => `<span class="badge badge-neutral" style="margin-right:4px;">${escapeHtml(i)}</span>`).join('') || '—'}</td>
                      <td class="muted" style="font-size:12px;">${escapeHtml(m.reason || '—')}</td>
                      <td class="muted" style="font-size:12px;">${formatDateTime(m.created_at)}</td>
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>`
            : `<p class="muted">Aucun masquage actif.</p>`
        }
      </div>
    `;

    document.getElementById('mask-submit').addEventListener('click', async () => {
      const errorEl = document.getElementById('mask-error');
      errorEl.style.display = 'none';
      const type = document.getElementById('mask-type').value;
      const id = document.getElementById('mask-id').value.trim();
      const reason = document.getElementById('mask-reason').value.trim();
      const hiddenFrom = Array.from(content.querySelectorAll('.mask-iface:checked')).map((el) => el.value);
      if (!id) {
        errorEl.textContent = "Veuillez renseigner l'identifiant UUID de la cible (ou choisir un compte/une transaction ci-dessus).";
        errorEl.style.display = 'block';
        return;
      }
      try {
        await setVisibilityMask({ type, id, hiddenFrom, reason: reason || null });
        selectedTargetId = '';
        selectedTargetLabel = '';
        await draw();
      } catch (err) {
        errorEl.textContent = err.message || "Erreur lors de l'enregistrement (vérifiez que l'identifiant est un UUID valide).";
        errorEl.style.display = 'block';
      }
    });

    const clientSearchInput = document.getElementById('mask-client-search');
    let debounce;
    clientSearchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        query = clientSearchInput.value;
        clientResults = query.trim().length >= 2 ? await searchClients(query).catch(() => []) : [];
        draw();
      }, 300);
    });

    content.querySelectorAll('.mask-client-row').forEach((el) => {
      el.addEventListener('click', async () => {
        selectedClient = clientResults.find((r) => r.id === el.getAttribute('data-id')) || null;
        selectedAccounts = [];
        selectedTransactions = [];
        if (selectedClient) {
          const [accounts, txResult] = await Promise.all([
            getClientAccounts(selectedClient.id).catch(() => []),
            listStaffTransactions({ search: selectedClient.display_name, limit: 15 }).catch(() => []),
          ]);
          selectedAccounts = accounts;
          selectedTransactions = txResult;
        }
        await draw();
      });
    });

    content.querySelectorAll('.mask-pick-row').forEach((el) => {
      el.addEventListener('click', () => {
        selectedTargetType = el.getAttribute('data-type');
        selectedTargetId = el.getAttribute('data-id');
        selectedTargetLabel = el.getAttribute('data-label');
        draw();
      });
    });
  }

  await draw();
}

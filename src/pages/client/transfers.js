import { renderClientShell } from './shell.js';
import {
  getMyAccounts,
  getBeneficiaries,
  resolveAccountByIban,
  submitTransfer,
  getMyTransfers,
  getEconomicSetting,
} from '../../lib/clientApi.js';
import { formatMoney, formatDateTime, escapeHtml } from '../../lib/format.js';
import { loadAll, loadErrorBanner } from '../../lib/loadState.js';

// Libellés spécifiques au suivi de virement (distincts du statut générique
// partagé par les autres écrans) : le client doit voir la progression réelle
// du traitement plutôt qu'un mot générique.
const TRANSFER_STATUS_LABELS = {
  pending: 'Demande envoyée',
  processing: 'En cours de traitement',
  validated: 'Virement effectué',
  rejected: 'Refusé',
  cancelled: 'Annulé',
};
const TRANSFER_STATUS_CLASSES = {
  pending: 'badge-pending',
  processing: 'badge-pending',
  validated: 'badge-success',
  rejected: 'badge-danger',
  cancelled: 'badge-neutral',
};
function transferStatusBadge(status) {
  const cls = TRANSFER_STATUS_CLASSES[status] || 'badge-neutral';
  const label = TRANSFER_STATUS_LABELS[status] || status;
  return `<span class="badge ${cls}">${label}</span>`;
}

export async function renderClientTransfers(app, profile) {
  const { content } = await renderClientShell(app, profile, 'transfers');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const { data, errors } = await loadAll({
    accounts: getMyAccounts(),
    beneficiaries: getBeneficiaries(),
    transfers: getMyTransfers(),
    minSetting: { promise: getEconomicSetting('min_transfer_amount'), fallback: null },
    maxSetting: { promise: getEconomicSetting('max_transfer_amount'), fallback: null },
  });
  const { accounts, beneficiaries, transfers, minSetting, maxSetting } = data;

  const minAmount = minSetting?.amount ?? 100000;
  const maxAmount = maxSetting?.amount ?? 0; // 0 = pas de plafond configuré
  let resolvedRecipient = null; // { account_id, owner_display_name, account_type }

  function accountLabel(id) {
    const a = accounts.find((x) => x.id === id);
    return a ? `${a.account_type} — ${a.iban}` : id;
  }

  content.innerHTML = `
    <h1 style="margin-bottom:20px;">Virements</h1>
    ${loadErrorBanner(errors)}
    <div class="grid" style="grid-template-columns: 1fr 1.2fr; align-items:start;">
      <div class="card">
        <h3 style="margin-bottom:16px;">Nouveau virement</h3>
        <div class="field">
          <label>Compte débiteur</label>
          <select id="sender-account">
            ${accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.account_type)} — ${escapeHtml(a.iban)} (${formatMoney(a.balance)})</option>`).join('')}
          </select>
        </div>

        <div class="field">
          <label>Destinataire</label>
          <select id="recipient-mode">
            <option value="own">Un de mes comptes</option>
            ${beneficiaries.length ? `<option value="beneficiary">Un bénéficiaire enregistré</option>` : ''}
            <option value="iban">IBAN externe</option>
          </select>
        </div>

        <div id="recipient-own" class="field">
          <select id="recipient-own-select">
            ${accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.account_type)} — ${escapeHtml(a.iban)}</option>`).join('')}
          </select>
        </div>

        <div id="recipient-beneficiary" class="field" style="display:none;">
          <select id="recipient-beneficiary-select">
            ${beneficiaries.map((b) => `<option value="${escapeHtml(b.beneficiary_iban || '')}">${escapeHtml(b.label)} — ${escapeHtml(b.beneficiary_iban || '')}</option>`).join('')}
          </select>
        </div>

        <div id="recipient-iban" class="field" style="display:none;">
          <input type="text" id="recipient-iban-input" placeholder="Ex: BNW26XXXXXXXX" />
          <div id="iban-resolve-status" class="muted" style="font-size:12px; margin-top:6px;"></div>
        </div>

        <div class="field">
          <label>Montant ($)</label>
          <input type="number" id="amount" min="1" step="0.01" placeholder="0.00" />
          <div class="muted" style="font-size:12px; margin-top:4px;">
            Minimum ${formatMoney(minAmount)} pour un virement externe (aucun minimum entre vos propres comptes).${maxAmount > 0 ? ` Plafond par virement : ${formatMoney(maxAmount)}.` : ''}
          </div>
        </div>

        <div class="field">
          <label>Motif</label>
          <input type="text" id="motif" placeholder="Ex: Loyer, remboursement..." />
        </div>

        <div id="transfer-error" class="text-danger" style="font-size:13px; margin-bottom:12px; display:none;"></div>
        <div id="transfer-success" class="text-success" style="font-size:13px; margin-bottom:12px; display:none;"></div>

        <button id="submit-transfer" class="btn btn-primary" style="width:100%;">Envoyer le virement</button>
      </div>

      <div class="card">
        <h3 style="margin-bottom:12px;">Historique des virements</h3>
        ${
          transfers.length
            ? `<table>
                <thead><tr><th>Date</th><th>Montant</th><th>Type</th><th>Statut</th></tr></thead>
                <tbody>
                  ${transfers
                    .map(
                      (t) => `
                    <tr>
                      <td class="muted">${formatDateTime(t.requested_at)}</td>
                      <td style="font-weight:600;">${formatMoney(t.amount)}</td>
                      <td class="muted">${t.is_internal ? 'Interne' : 'Externe'}</td>
                      <td>${transferStatusBadge(t.status)}</td>
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>`
            : `<p class="muted">Aucun virement pour l'instant.</p>`
        }
      </div>
    </div>
  `;

  const modeSelect = document.getElementById('recipient-mode');
  const ownDiv = document.getElementById('recipient-own');
  const beneficiaryDiv = document.getElementById('recipient-beneficiary');
  const ibanDiv = document.getElementById('recipient-iban');
  const ibanInput = document.getElementById('recipient-iban-input');
  const ibanStatus = document.getElementById('iban-resolve-status');
  const beneficiarySelect = document.getElementById('recipient-beneficiary-select');

  function updateMode() {
    const mode = modeSelect.value;
    ownDiv.style.display = mode === 'own' ? 'block' : 'none';
    beneficiaryDiv.style.display = mode === 'beneficiary' ? 'block' : 'none';
    ibanDiv.style.display = mode === 'iban' ? 'block' : 'none';
    resolvedRecipient = null;
  }
  modeSelect.addEventListener('change', updateMode);
  updateMode();

  async function resolveIban(iban) {
    if (!iban || iban.length < 5) { ibanStatus.textContent = ''; resolvedRecipient = null; return; }
    ibanStatus.textContent = 'Recherche…';
    try {
      const found = await resolveAccountByIban(iban.trim().toUpperCase());
      if (found) {
        resolvedRecipient = found;
        ibanStatus.textContent = `✓ ${found.owner_display_name} — ${found.account_type}`;
        ibanStatus.className = 'text-success';
        ibanStatus.style.fontSize = '12px';
        ibanStatus.style.marginTop = '6px';
      } else {
        resolvedRecipient = null;
        ibanStatus.textContent = 'Aucun compte actif trouvé pour cet IBAN.';
        ibanStatus.className = 'text-danger';
      }
    } catch (err) {
      resolvedRecipient = null;
      ibanStatus.textContent = 'Erreur de recherche.';
      ibanStatus.className = 'text-danger';
    }
  }

  let ibanDebounce;
  ibanInput.addEventListener('input', () => {
    clearTimeout(ibanDebounce);
    ibanDebounce = setTimeout(() => resolveIban(ibanInput.value), 400);
  });
  beneficiarySelect?.addEventListener('change', () => resolveIban(beneficiarySelect.value));
  if (modeSelect.value === 'beneficiary' && beneficiarySelect) resolveIban(beneficiarySelect.value);

  document.getElementById('submit-transfer').addEventListener('click', async () => {
    const errorEl = document.getElementById('transfer-error');
    const successEl = document.getElementById('transfer-success');
    errorEl.style.display = 'none';
    successEl.style.display = 'none';

    const senderAccountId = document.getElementById('sender-account').value;
    const amount = parseFloat(document.getElementById('amount').value);
    const motif = document.getElementById('motif').value.trim();
    const mode = modeSelect.value;

    let recipientAccountId = null;
    if (mode === 'own') {
      recipientAccountId = document.getElementById('recipient-own-select').value;
    } else if (mode === 'beneficiary' || mode === 'iban') {
      if (!resolvedRecipient) {
        errorEl.textContent = "Veuillez saisir un IBAN valide et attendre la résolution du compte destinataire.";
        errorEl.style.display = 'block';
        return;
      }
      recipientAccountId = resolvedRecipient.account_id;
    }

    if (!amount || amount <= 0) {
      errorEl.textContent = 'Montant invalide.';
      errorEl.style.display = 'block';
      return;
    }

    const btn = document.getElementById('submit-transfer');
    btn.disabled = true;
    btn.textContent = 'Envoi…';
    try {
      await submitTransfer({ senderAccountId, recipientAccountId, amount, motif });
      successEl.textContent = 'Demande de virement envoyée — vous serez notifié à chaque étape du traitement.';
      successEl.style.display = 'block';
      setTimeout(() => renderClientTransfers(app, profile), 1200);
    } catch (err) {
      errorEl.textContent = err.message || 'Une erreur est survenue.';
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Envoyer le virement';
    }
  });
}

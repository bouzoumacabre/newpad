import { renderClientShell } from './shell.js';
import { getMyLoans, getLoanSchedule, requestLoan, repayLoanEarly, getEconomicSetting, getMyAccounts } from '../../lib/clientApi.js';
import { formatMoney, formatDate, statusBadge, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';

// L'énumération `installment_status` ne connaît que pending|paid|late : une
// échéance prélevée AVEC pénalité de retard est enregistrée en 'late', ce qui
// affichait « En retard » sur une échéance pourtant bel et bien réglée. La
// donnée distingue déjà les deux cas via `paid_at` — on s'appuie dessus plutôt
// que de modifier l'énumération (opération autrement plus risquée en base).
function installmentBadge(s) {
  if (s.status === 'late' && s.paid_at) {
    return '<span class="badge badge-neutral">Payée en retard</span>';
  }
  return statusBadge(s.status);
}

export async function renderClientLoans(app, profile) {
  const { content } = await renderClientShell(app, profile, 'loans');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  let expandedLoanId = null;

  async function draw() {
    const [loans, capSetting, accounts] = await Promise.all([
      getMyLoans().catch(() => []),
      getEconomicSetting('loan_cap').catch(() => null),
      getMyAccounts().catch(() => []),
    ]);
    const cap = capSetting?.amount ?? 50000000;
    const hasPending = loans.some((l) => l.status === 'pending' || l.status === 'processing');
    const hasActive = loans.some((l) => l.status === 'active');

    // Compte réellement crédité puis prélevé par la banque : le premier compte
    // actif, dans le même ordre que côté serveur.
    const payingAccount = accounts
      .filter((a) => a.status === 'active')
      .sort((a, b) => new Date(a.opened_at) - new Date(b.opened_at))[0] || null;

    // Depuis la migration 0027, la banque refuse une seconde demande tant qu'un
    // dossier est ouvert (le plafond s'appliquait par prêt, pas par client :
    // rien n'empêchait d'en empiler dix au plafond). Le formulaire dit
    // désormais la même chose que le serveur, avant l'envoi.
    let formBlock = '';
    if (hasActive) formBlock = 'Vous avez un prêt en cours. Soldez-le avant d’en demander un autre.';
    else if (hasPending) formBlock = 'Une demande est déjà en cours de traitement.';
    else if (!payingAccount) formBlock = 'Vous n’avez aucun compte actif pour recevoir le décaissement.';

    let scheduleHtml = '';
    if (expandedLoanId) {
      const schedule = await getLoanSchedule(expandedLoanId).catch(() => []);
      scheduleHtml = `
        <div class="card" style="margin-top:16px;">
          <h3 style="margin-bottom:12px;">Échéancier</h3>
          <table>
            <thead><tr><th>#</th><th>Échéance</th><th style="text-align:right;">Montant</th><th>Statut</th></tr></thead>
            <tbody>
              ${schedule
                .map(
                  (s) => `
                <tr>
                  <td>${s.installment_number}</td>
                  <td class="muted">${formatDate(s.due_date)}</td>
                  <td style="text-align:right;">${formatMoney(s.amount_due)}${s.penalty_applied > 0 ? `<div class="muted" style="font-size:11px;">dont ${formatMoney(s.penalty_applied)} de pénalité</div>` : ''}</td>
                  <td>${installmentBadge(s)}</td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Prêts professionnels</h1>

      <div class="grid" style="grid-template-columns: 1fr 1.3fr; align-items:start;">
        <div class="card">
          <h3 style="margin-bottom:16px;">Nouvelle demande</h3>
          ${
            formBlock
              ? `<p class="muted">${escapeHtml(formBlock)}</p>`
              : `
            <div class="field">
              <label>Montant demandé ($)</label>
              <input type="number" id="loan-amount" min="1" step="0.01" placeholder="0.00" />
              <div class="muted" style="font-size:12px; margin-top:4px;">Plafond autorisé : ${formatMoney(cap)}</div>
            </div>
            <div class="field">
              <label>Objet du prêt</label>
              <textarea id="loan-purpose" rows="3" placeholder="Décrivez l'usage prévu des fonds..."></textarea>
            </div>
            <div class="field">
              <label>Durée (mois)</label>
              <input type="number" id="loan-term" min="1" max="120" value="12" />
              <div class="muted" style="font-size:12px; margin-top:4px;">De 1 à 120 mois.</div>
            </div>
            <div id="loan-error" class="text-danger" style="font-size:13px; margin-bottom:12px; display:none;"></div>
            <button id="loan-submit" class="btn btn-primary" style="width:100%;">Soumettre la demande</button>
          `
          }
        </div>

        <div>
          <div class="card">
            <h3 style="margin-bottom:12px;">Mes prêts</h3>
            ${
              loans.length
                ? `<table>
                    <thead><tr><th>Montant</th><th>Solde restant</th><th>Statut</th><th></th></tr></thead>
                    <tbody>
                      ${loans
                        .map(
                          (l) => `
                        <tr>
                          <td style="font-weight:600;">${formatMoney(l.requested_amount)}</td>
                          <td class="muted">${l.status === 'active' ? formatMoney(l.outstanding_balance) : '—'}</td>
                          <td>${statusBadge(l.status)}</td>
                          <td style="text-align:right;">
                            <button class="btn btn-ghost view-schedule" data-id="${l.id}" style="padding:4px 8px; font-size:12px;">Échéancier</button>
                            ${l.status === 'active' ? `<button class="btn btn-ghost repay-early" data-id="${l.id}" style="padding:4px 8px; font-size:12px; color:var(--gold-light);">Solder</button>` : ''}
                          </td>
                        </tr>
                      `
                        )
                        .join('')}
                    </tbody>
                  </table>`
                : `<p class="muted">Aucun prêt pour l'instant.</p>`
            }
          </div>
          ${scheduleHtml}
        </div>
      </div>
    `;

    document.getElementById('loan-submit')?.addEventListener('click', async () => {
      const errorEl = document.getElementById('loan-error');
      errorEl.style.display = 'none';
      const amount = parseFloat(document.getElementById('loan-amount').value);
      const purpose = document.getElementById('loan-purpose').value.trim();
      const termMonths = parseInt(document.getElementById('loan-term').value, 10);
      if (!amount || amount <= 0 || !purpose || !termMonths) {
        errorEl.textContent = 'Veuillez remplir tous les champs.';
        errorEl.style.display = 'block';
        return;
      }
      if (termMonths < 1 || termMonths > 120) {
        errorEl.textContent = 'La durée doit être comprise entre 1 et 120 mois.';
        errorEl.style.display = 'block';
        return;
      }
      if (amount > cap) {
        errorEl.textContent = `Le montant dépasse le plafond autorisé (${formatMoney(cap)}).`;
        errorEl.style.display = 'block';
        return;
      }
      try {
        await requestLoan({ amount, purpose, termMonths });
        await draw();
      } catch (err) {
        errorEl.textContent = err.message || 'Erreur lors de la demande.';
        errorEl.style.display = 'block';
      }
    });

    content.querySelectorAll('.view-schedule').forEach((btn) => {
      btn.addEventListener('click', () => {
        expandedLoanId = expandedLoanId === btn.getAttribute('data-id') ? null : btn.getAttribute('data-id');
        draw();
      });
    });

    content.querySelectorAll('.repay-early').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const loanId = btn.getAttribute('data-id');
        // Le montant réellement prélevé est la somme des échéances RESTANTES
        // (capital + intérêts), pas le seul capital restant dû affiché dans le
        // tableau. Le client confirmait jusqu'ici un montant qu'il ne voyait
        // nulle part — et depuis la migration 0027 la banque refuse le
        // prélèvement s'il dépasse le solde du compte.
        const schedule = await getLoanSchedule(loanId).catch(() => null);
        if (schedule === null) {
          await showAlert('Impossible de charger l’échéancier — réessayez dans un instant.');
          return;
        }
        const payoff = schedule
          .filter((s) => s.status === 'pending')
          .reduce((sum, s) => sum + Number(s.amount_due), 0);
        if (payoff <= 0) {
          await showAlert('Aucune échéance restante sur ce prêt.');
          return;
        }
        if (payingAccount && payoff > Number(payingAccount.balance)) {
          await showAlert(
            `Solde insuffisant : solder ce prêt coûte ${formatMoney(payoff)} et votre compte ${payingAccount.iban} ` +
            `dispose de ${formatMoney(payingAccount.balance)}.`
          );
          return;
        }
        const ok = await showConfirm(
          `Solder ce prêt maintenant ?\n\n` +
          `Montant prélevé : ${formatMoney(payoff)} (${schedule.filter((s) => s.status === 'pending').length} échéance(s) restante(s), intérêts compris).`
        );
        if (!ok) return;
        btn.disabled = true;
        try {
          await repayLoanEarly(loanId);
          await draw();
        } catch (err) {
          await showAlert(err.message || 'Erreur lors du remboursement.');
          btn.disabled = false;
        }
      });
    });
  }

  await draw();
}

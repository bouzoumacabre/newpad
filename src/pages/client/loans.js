import { renderClientShell } from './shell.js';
import { getMyLoans, getLoanSchedule, requestLoan, repayLoanEarly, getEconomicSetting } from '../../lib/clientApi.js';
import { formatMoney, formatDate, statusBadge, escapeHtml } from '../../lib/format.js';

export async function renderClientLoans(app, profile) {
  const { content } = await renderClientShell(app, profile, 'loans');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  let expandedLoanId = null;

  async function draw() {
    const [loans, capSetting] = await Promise.all([
      getMyLoans().catch(() => []),
      getEconomicSetting('loan_cap').catch(() => null),
    ]);
    const cap = capSetting?.amount ?? 50000000;
    const hasPending = loans.some((l) => l.status === 'pending' || l.status === 'processing');

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
                  <td style="text-align:right;">${formatMoney(s.amount_due)}</td>
                  <td>${statusBadge(s.status)}</td>
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
            hasPending
              ? `<p class="muted">Une demande est déjà en cours de traitement.</p>`
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
              <input type="number" id="loan-term" min="1" max="60" value="12" />
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
        if (!confirm('Confirmer le remboursement anticipé du solde restant ?')) return;
        try {
          await repayLoanEarly(btn.getAttribute('data-id'));
          await draw();
        } catch (err) {
          alert(err.message || 'Erreur lors du remboursement.');
        }
      });
    });
  }

  await draw();
}

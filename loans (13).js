import { renderEmployeeShell } from './shell.js';
import { getLoansQueue, reviewLoan } from '../../lib/employeeApi.js';
import { formatMoney, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';

export async function renderEmployeeLoans(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'loans');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const loans = await getLoansQueue().catch(() => []);
    const pending = loans.filter((l) => l.status === 'pending');
    const inReview = loans.filter((l) => l.status === 'processing');

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Prêts professionnels</h1>
      <p class="muted" style="margin-bottom:20px;">La décision finale (validation/refus) est réservée à l'administration ; votre rôle est de réceptionner et transmettre les demandes.</p>

      <h3 style="margin-bottom:12px;">Nouvelles demandes</h3>
      <div class="card" style="margin-bottom:24px;">
        ${
          pending.length
            ? pending
                .map(
                  (l) => `
          <div style="padding:14px 0; border-bottom:1px solid var(--card-border);">
            <div class="flex justify-between items-center" style="margin-bottom:8px;">
              <div>
                <div style="font-weight:600;">${escapeHtml(l.profiles?.display_name || '')}</div>
                <div class="muted" style="font-size:12px;">${formatDateTime(l.requested_at)} — ${l.term_months} mois</div>
              </div>
              ${statusBadge(l.status)}
            </div>
            <div style="font-size:14px; margin-bottom:10px;">
              Montant : <strong class="gold">${formatMoney(l.requested_amount)}</strong>
              ${l.purpose ? ` — ${escapeHtml(l.purpose)}` : ''}
            </div>
            <button class="btn btn-secondary review-btn" data-id="${l.id}">Transmettre à l'admin</button>
          </div>
        `
                )
                .join('')
            : `<p class="muted">Aucune nouvelle demande.</p>`
        }
      </div>

      <h3 style="margin-bottom:12px;">En attente de décision admin</h3>
      <div class="card">
        ${
          inReview.length
            ? inReview
                .map(
                  (l) => `
          <div style="padding:12px 0; border-bottom:1px solid var(--card-border);" class="flex justify-between items-center">
            <div>
              <div style="font-weight:600;">${escapeHtml(l.profiles?.display_name || '')}</div>
              <div class="muted" style="font-size:12px;">${formatMoney(l.requested_amount)} — ${l.term_months} mois</div>
            </div>
            ${statusBadge(l.status)}
          </div>
        `
                )
                .join('')
            : `<p class="muted">Aucune demande en attente de décision.</p>`
        }
      </div>
    `;

    content.querySelectorAll('.review-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = await showPrompt('Note pour l\'admin (optionnel) :') || null;
        try { await reviewLoan(btn.getAttribute('data-id'), note); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

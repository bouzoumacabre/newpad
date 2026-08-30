import { renderAdminShell } from './shell.js';
import { getLoansQueue, decideLoanFinal, getTreasuryStats } from '../../lib/adminApi.js';
import { formatMoney, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';

export async function renderAdminLoans(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'loans');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const [loans, treasury] = await Promise.all([
      getLoansQueue().catch(() => []),
      getTreasuryStats().catch(() => null),
    ]);
    // Depuis la migration 0027, la banque refuse un décaissement supérieur à
    // ses fonds propres. L'admin doit donc voir ce plafond AVANT de cliquer sur
    // « Approuver et débloquer », pas dans un message d'erreur après coup.
    const fondsPropres = treasury ? Number(treasury.fonds_propres) : null;
    const pending = loans.filter((l) => l.status === 'pending');
    const processing = loans.filter((l) => l.status === 'processing');
    const decided = loans.filter((l) => ['approved', 'rejected', 'active', 'closed'].includes(l.status)).slice(0, 20);

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Prêts professionnels</h1>
      <p class="muted" style="margin-bottom:8px;">Décision finale (validation/refus, déblocage des fonds et génération de l'échéancier).</p>
      <p class="muted" style="margin-bottom:20px; font-size:13px;">
        Fonds propres disponibles pour le décaissement :
        <strong class="gold">${fondsPropres !== null ? formatMoney(fondsPropres) : '—'}</strong>.
        Un prêt supérieur à ce montant est refusé par la banque.
      </p>

      <h3 style="margin-bottom:12px;">En attente de décision finale</h3>
      <div class="card" style="margin-bottom:24px;">
        ${
          processing.length
            ? processing
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
              ${l.requires_admin_override ? ' — <span class="text-danger">nécessite une autorisation admin (sous le solde minimum)</span>' : ''}
              ${fondsPropres !== null && Number(l.requested_amount) > fondsPropres ? ` — <span class="text-danger">dépasse les fonds propres (${formatMoney(fondsPropres)})</span>` : ''}
            </div>
            <div class="flex gap-sm">
              <button class="btn btn-primary decide-approve" data-id="${l.id}" ${fondsPropres !== null && Number(l.requested_amount) > fondsPropres ? 'disabled' : ''}>Approuver et débloquer</button>
              <button class="btn btn-danger decide-reject" data-id="${l.id}">Refuser</button>
            </div>
          </div>
        `
                )
                .join('')
            : `<p class="muted">Aucune demande en attente de décision.</p>`
        }
      </div>

      <h3 style="margin-bottom:12px;">Nouvelles demandes (non encore réceptionnées par un employé)</h3>
      <p class="muted" style="margin-bottom:12px; font-size:12px;">
        L'admin dispose déjà de toutes les permissions du personnel — inutile d'attendre qu'un employé la réceptionne
        d'abord, vous pouvez décider directement ci-dessous.
      </p>
      <div class="card" style="margin-bottom:24px;">
        ${
          pending.length
            ? pending
                .map(
                  (l) => `
          <div style="padding:12px 0; border-bottom:1px solid var(--card-border);">
            <div class="flex justify-between items-center" style="margin-bottom:8px;">
              <div>
                <div style="font-weight:600;">${escapeHtml(l.profiles?.display_name || '')}</div>
                <div class="muted" style="font-size:12px;">${formatMoney(l.requested_amount)} — ${l.term_months} mois${l.purpose ? ' — ' + escapeHtml(l.purpose) : ''}</div>
                ${fondsPropres !== null && Number(l.requested_amount) > fondsPropres ? `<div class="text-danger" style="font-size:12px;">Dépasse les fonds propres (${formatMoney(fondsPropres)}) — décaissement refusé par la banque.</div>` : ''}
              </div>
              ${statusBadge(l.status)}
            </div>
            <div class="flex gap-sm">
              <button class="btn btn-primary decide-approve" data-id="${l.id}" ${fondsPropres !== null && Number(l.requested_amount) > fondsPropres ? 'disabled' : ''}>Approuver et débloquer</button>
              <button class="btn btn-danger decide-reject" data-id="${l.id}">Refuser</button>
            </div>
          </div>
        `
                )
                .join('')
            : `<p class="muted">Aucune nouvelle demande.</p>`
        }
      </div>

      <h3 style="margin-bottom:12px;">Historique des décisions</h3>
      <div class="card">
        ${
          decided.length
            ? decided
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
            : `<p class="muted">Aucune décision enregistrée.</p>`
        }
      </div>
    `;

    content.querySelectorAll('.decide-approve').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = await showPrompt('Note (optionnel) :') || null;
        try { await decideLoanFinal(btn.getAttribute('data-id'), true, note); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.decide-reject').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = await showPrompt('Motif du refus (optionnel) :') || null;
        try { await decideLoanFinal(btn.getAttribute('data-id'), false, note); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

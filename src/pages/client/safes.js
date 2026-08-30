import { renderClientShell } from './shell.js';
import { getAvailableSafeBoxes, getMySafeBoxes, getMySafeRequests, requestSafeBox, endSafeRental, getMyAccounts } from '../../lib/clientApi.js';
import { formatMoney, formatDate, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';

// Date du prochain prélèvement hebdomadaire. Depuis la migration 0027 elle est
// portée par la colonne `last_charged_at` du coffre — plus par le libellé de la
// dernière transaction, qui pouvait être réécrit ou entrer en collision avec un
// autre code de coffre.
function nextChargeDate(box) {
  if (!box.last_charged_at) return null;
  const d = new Date(box.last_charged_at);
  d.setDate(d.getDate() + 7);
  return d;
}

export async function renderClientSafes(app, profile) {
  const { content } = await renderClientShell(app, profile, 'safes');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const [available, myBoxes, myRequests, accounts] = await Promise.all([
      getAvailableSafeBoxes().catch(() => []),
      getMySafeBoxes().catch(() => []),
      getMySafeRequests().catch(() => []),
      getMyAccounts().catch(() => []),
    ]);

    const rentedBoxes = myBoxes.filter((b) => b.status === 'rented');
    const hasPending = myRequests.some((r) => r.status === 'pending' || r.status === 'processing');
    const alreadyRenting = rentedBoxes.length > 0;

    // Compte réellement débité par la banque : le premier compte actif, dans le
    // même ordre que côté serveur. Le loyer de la première semaine est prélevé
    // dès l'autorisation, et depuis la migration 0027 la banque refuse un
    // prélèvement qui mettrait ce compte en négatif. Autant l'annoncer avant
    // d'envoyer une demande vouée au refus.
    const payingAccount = accounts
      .filter((a) => a.status === 'active')
      .sort((a, b) => new Date(a.opened_at) - new Date(b.opened_at))[0] || null;
    const cheapest = available.length
      ? Math.min(...available.map((b) => Number(b.weekly_fee)))
      : null;
    const cannotAfford =
      payingAccount && cheapest !== null && cheapest > Number(payingAccount.balance);

    let blockReason = '';
    if (alreadyRenting) blockReason = 'Vous louez déjà un coffre-fort.';
    else if (hasPending) blockReason = 'Une demande est déjà en cours de traitement.';
    else if (!available.length) blockReason = 'Aucun coffre n’est disponible actuellement.';
    else if (!payingAccount) blockReason = 'Vous n’avez aucun compte actif pour régler le loyer.';
    else if (cannotAfford) blockReason = `Le coffre le moins cher coûte ${formatMoney(cheapest)}/semaine, votre compte dispose de ${formatMoney(payingAccount.balance)}.`;

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Coffres-forts</h1>

      <div class="grid" style="grid-template-columns: 1.2fr 1fr; align-items:start; margin-bottom:28px;">
        <div class="card">
          <div class="flex justify-between items-center" style="margin-bottom:12px;">
            <h3 style="margin:0;">Coffres disponibles</h3>
            <button id="request-safe" class="btn btn-primary" ${blockReason ? 'disabled' : ''}>
              ${hasPending ? 'Demande en cours' : 'Demander un coffre'}
            </button>
          </div>
          ${blockReason ? `<p class="muted" style="font-size:12px; margin:-4px 0 12px;">${escapeHtml(blockReason)}</p>` : ''}
          ${
            available.length
              ? `<table>
                  <thead><tr><th>Code</th><th>Succursale</th><th style="text-align:right;">Loyer hebdomadaire</th></tr></thead>
                  <tbody>
                    ${available
                      .map(
                        (b) => `
                      <tr>
                        <td style="font-weight:600;">${escapeHtml(b.code)}</td>
                        <td class="muted">${escapeHtml(b.branch || '—')}</td>
                        <td style="text-align:right;">${formatMoney(b.weekly_fee)}/semaine</td>
                      </tr>
                    `
                      )
                      .join('')}
                  </tbody>
                </table>`
              : `<p class="muted">Aucun coffre disponible actuellement.</p>`
          }
          <p class="muted" style="font-size:12px; margin:12px 0 0;">
            Le loyer est prélevé à l’ouverture puis tous les 7 jours, jusqu’à résiliation.
          </p>
        </div>

        <div class="card">
          <h3 style="margin-bottom:12px;">Mes coffres loués</h3>
          ${
            rentedBoxes.length
              ? rentedBoxes
                  .map((b) => {
                    const next = nextChargeDate(b);
                    return `
              <div style="padding:12px 0; border-bottom:1px solid var(--card-border);">
                <div class="flex justify-between items-center" style="gap:10px;">
                  <div>
                    <div style="font-weight:600;">${escapeHtml(b.code)}${b.branch ? ' — ' + escapeHtml(b.branch) : ''}</div>
                    <div class="muted" style="font-size:12px;">Loué depuis le ${formatDate(b.rented_since)} — ${formatMoney(b.weekly_fee)}/semaine</div>
                    <div class="muted" style="font-size:12px;">Prochain prélèvement : ${next ? formatDate(next) : '—'}</div>
                  </div>
                  <button class="btn btn-danger end-rental" data-id="${b.id}" data-code="${escapeHtml(b.code)}" data-fee="${b.weekly_fee}" style="padding:5px 12px; font-size:12px; white-space:nowrap;">Résilier</button>
                </div>
              </div>
            `;
                  })
                  .join('')
              : `<p class="muted">Vous ne louez aucun coffre actuellement.</p>`
          }
        </div>
      </div>

      <div class="card">
        <h3 style="margin-bottom:12px;">Mes demandes</h3>
        ${
          myRequests.length
            ? `<table>
                <thead><tr><th>Date</th><th>Rendez-vous</th><th>Statut</th><th>Motif</th></tr></thead>
                <tbody>
                  ${myRequests
                    .map(
                      (r) => `
                    <tr>
                      <td class="muted">${formatDateTime(r.requested_at)}</td>
                      <td class="muted">${r.appointment_at ? formatDateTime(r.appointment_at) + (r.appointment_location ? ' — ' + escapeHtml(r.appointment_location) : '') : '—'}</td>
                      <td>${statusBadge(r.status)}</td>
                      <td class="muted">${r.status === 'rejected' && r.decision_note ? escapeHtml(r.decision_note) : '—'}</td>
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>`
            : `<p class="muted">Aucune demande envoyée.</p>`
        }
      </div>
    `;

    document.getElementById('request-safe')?.addEventListener('click', async () => {
      if (blockReason) return;
      const btn = document.getElementById('request-safe');
      btn.disabled = true;
      btn.textContent = 'Envoi…';
      try {
        await requestSafeBox();
        await draw();
      } catch (err) {
        await showAlert(err.message || 'Erreur lors de la demande.');
        btn.disabled = false;
        btn.textContent = 'Demander un coffre';
      }
    });

    content.querySelectorAll('.end-rental').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const code = btn.getAttribute('data-code');
        const fee = Number(btn.getAttribute('data-fee') || 0);
        const ok = await showConfirm(
          `Résilier la location du coffre ${code} ?\n\n` +
          `Le loyer de ${formatMoney(fee)}/semaine cessera immédiatement. La semaine déjà payée n’est pas remboursée, ` +
          `et le coffre repartira à la location : sa réattribution ne vous est pas garantie.`
        );
        if (!ok) return;
        btn.disabled = true;
        try {
          await endSafeRental(btn.getAttribute('data-id'), 'Résiliation à la demande du client');
          await draw();
        } catch (err) {
          await showAlert(err.message || 'Erreur lors de la résiliation.');
          btn.disabled = false;
        }
      });
    });
  }

  await draw();
}

import { renderClientShell } from './shell.js';
import { getAvailableSafeBoxes, getMySafeBoxes, getMySafeRequests, requestSafeBox } from '../../lib/clientApi.js';
import { formatMoney, formatDate, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';

export async function renderClientSafes(app, profile) {
  const { content } = await renderClientShell(app, profile, 'safes');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const [available, myBoxes, myRequests] = await Promise.all([
      getAvailableSafeBoxes().catch(() => []),
      getMySafeBoxes().catch(() => []),
      getMySafeRequests().catch(() => []),
    ]);

    const hasPending = myRequests.some((r) => r.status === 'pending' || r.status === 'processing');

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Coffres-forts</h1>

      <div class="grid" style="grid-template-columns: 1.2fr 1fr; align-items:start; margin-bottom:28px;">
        <div class="card">
          <div class="flex justify-between items-center" style="margin-bottom:12px;">
            <h3 style="margin:0;">Coffres disponibles</h3>
            <button id="request-safe" class="btn btn-primary" ${hasPending ? 'disabled' : ''}>
              ${hasPending ? 'Demande en cours' : 'Demander un coffre'}
            </button>
          </div>
          ${
            available.length
              ? `<table>
                  <thead><tr><th>Code</th><th>Succursale</th><th style="text-align:right;">Frais annuels</th></tr></thead>
                  <tbody>
                    ${available
                      .map(
                        (b) => `
                      <tr>
                        <td style="font-weight:600;">${escapeHtml(b.code)}</td>
                        <td class="muted">${escapeHtml(b.branch)}</td>
                        <td style="text-align:right;">${formatMoney(b.annual_fee)}</td>
                      </tr>
                    `
                      )
                      .join('')}
                  </tbody>
                </table>`
              : `<p class="muted">Aucun coffre disponible actuellement.</p>`
          }
        </div>

        <div class="card">
          <h3 style="margin-bottom:12px;">Mes coffres loués</h3>
          ${
            myBoxes.length
              ? myBoxes
                  .map(
                    (b) => `
              <div style="padding:10px 0; border-bottom:1px solid var(--card-border);">
                <div style="font-weight:600;">${escapeHtml(b.code)} — ${escapeHtml(b.branch)}</div>
                <div class="muted" style="font-size:12px;">Loué depuis le ${formatDate(b.rented_since)}</div>
              </div>
            `
                  )
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
                <thead><tr><th>Date</th><th>Rendez-vous</th><th>Statut</th></tr></thead>
                <tbody>
                  ${myRequests
                    .map(
                      (r) => `
                    <tr>
                      <td class="muted">${formatDateTime(r.requested_at)}</td>
                      <td class="muted">${r.appointment_at ? formatDateTime(r.appointment_at) + (r.appointment_location ? ' — ' + escapeHtml(r.appointment_location) : '') : '—'}</td>
                      <td>${statusBadge(r.status)}</td>
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
      if (hasPending) return;
      const btn = document.getElementById('request-safe');
      btn.disabled = true;
      btn.textContent = 'Envoi…';
      try {
        await requestSafeBox();
        await draw();
      } catch (err) {
        alert(err.message || 'Erreur lors de la demande.');
        btn.disabled = false;
        btn.textContent = 'Demander un coffre';
      }
    });
  }

  await draw();
}

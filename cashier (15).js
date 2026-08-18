import { renderEmployeeShell } from './shell.js';
import { getCashierReports } from '../../lib/employeeApi.js';
import { formatMoney, formatDate, escapeHtml } from '../../lib/format.js';

export async function renderEmployeeCashier(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'cashier');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const reports = await getCashierReports(30).catch(() => []);

  content.innerHTML = `
    <h1 style="margin-bottom:6px;">Rapport de caisse</h1>
    <p class="muted" style="margin-bottom:20px;">Consultation en lecture seule. Généré automatiquement chaque nuit ; toute correction est réservée à l'administration.</p>

    <div class="card">
      ${
        reports.length
          ? `<table>
              <thead><tr><th>Date</th><th style="text-align:right;">Ouverture</th><th style="text-align:right;">Entrées</th><th style="text-align:right;">Sorties</th><th style="text-align:right;">Clôture</th></tr></thead>
              <tbody>
                ${reports
                  .map(
                    (r) => `
                  <tr>
                    <td>${formatDate(r.report_date)}</td>
                    <td style="text-align:right;" class="muted">${formatMoney(r.opening_balance)}</td>
                    <td style="text-align:right;" class="text-success">+${formatMoney(r.total_in)}</td>
                    <td style="text-align:right;" class="text-danger">−${formatMoney(r.total_out)}</td>
                    <td style="text-align:right; font-weight:600;">${formatMoney(r.closing_balance)}</td>
                  </tr>
                  ${r.adjustment_amount ? `<tr><td colspan="5" class="muted" style="font-size:12px;">Ajustement admin : ${formatMoney(r.adjustment_amount)} — ${escapeHtml(r.adjustment_note || '')}</td></tr>` : ''}
                `
                  )
                  .join('')}
              </tbody>
            </table>`
          : `<p class="muted">Aucun rapport disponible.</p>`
      }
    </div>
  `;
}

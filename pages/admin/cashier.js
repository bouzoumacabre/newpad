import { renderAdminShell } from './shell.js';
import { getCashierReports, adjustCashierReport } from '../../lib/adminApi.js';
import { formatMoney, formatDate, escapeHtml } from '../../lib/format.js';

export async function renderAdminCashier(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'cashier');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  let correctingId = null;

  async function draw() {
    const reports = await getCashierReports(30).catch(() => []);

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Rapport de caisse</h1>
      <p class="muted" style="margin-bottom:20px;">Généré automatiquement chaque nuit. Toute correction manuelle est journalisée.</p>

      <div class="card">
        ${
          reports.length
            ? `<table>
                <thead><tr><th>Date</th><th style="text-align:right;">Ouverture</th><th style="text-align:right;">Entrées</th><th style="text-align:right;">Sorties</th><th style="text-align:right;">Clôture</th><th></th></tr></thead>
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
                      <td style="text-align:right;"><button class="btn btn-secondary correct-btn" data-id="${r.id}" style="padding:4px 10px; font-size:12px;">Corriger</button></td>
                    </tr>
                    ${r.adjustment_amount ? `<tr><td colspan="6" class="muted" style="font-size:12px;">Ajustement admin : ${formatMoney(r.adjustment_amount)} — ${escapeHtml(r.adjustment_note || '')}</td></tr>` : ''}
                    ${
                      correctingId === r.id
                        ? `
                    <tr>
                      <td colspan="6">
                        <div class="grid" style="grid-template-columns: 1fr 2fr auto; gap:10px; align-items:end; padding:10px 0;">
                          <div class="field" style="margin:0;">
                            <label>Montant de l'ajustement</label>
                            <input type="number" step="0.01" id="adjust-amount" />
                          </div>
                          <div class="field" style="margin:0;">
                            <label>Note</label>
                            <input type="text" id="adjust-note" placeholder="Motif de la correction..." />
                          </div>
                          <button class="btn btn-primary adjust-submit" data-id="${r.id}">Enregistrer</button>
                        </div>
                      </td>
                    </tr>
                    `
                        : ''
                    }
                  `
                    )
                    .join('')}
                </tbody>
              </table>`
            : `<p class="muted">Aucun rapport disponible.</p>`
        }
      </div>
    `;

    content.querySelectorAll('.correct-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        correctingId = correctingId === btn.getAttribute('data-id') ? null : btn.getAttribute('data-id');
        draw();
      });
    });

    content.querySelectorAll('.adjust-submit').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const amount = parseFloat(document.getElementById('adjust-amount').value);
        const note = document.getElementById('adjust-note').value.trim();
        if (!amount) { alert('Veuillez saisir un montant.'); return; }
        try {
          await adjustCashierReport(btn.getAttribute('data-id'), amount, note || null);
          correctingId = null;
          await draw();
        } catch (err) { alert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

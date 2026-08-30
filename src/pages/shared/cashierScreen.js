// ============================================================================
// NEWPAD — Rapport de caisse, partagé par les interfaces Employé et Admin.
// ============================================================================
// L'admin dispose en plus de la correction manuelle ; le reste est identique.
// ============================================================================

import { getCashierReports } from '../../lib/employeeApi.js';
import { adjustCashierReport } from '../../lib/adminApi.js';
import { formatMoney, formatDate, escapeHtml } from '../../lib/format.js';
import { showAlert } from '../../lib/uiDialogs.js';
import { loadAll, loadErrorBanner } from '../../lib/loadState.js';

// Un écart non nul entre le solde calculé et le solde réel de la trésorerie
// signale un mouvement que le rapport n'explique pas. La colonne n'existe que
// depuis la migration 0031 : les rapports antérieurs affichent « — » plutôt
// qu'un faux zéro rassurant.
function ecartCell(r) {
  if (r.discrepancy === null || r.discrepancy === undefined) {
    return `<td style="text-align:right;" class="muted" title="Rapport antérieur à la réconciliation">—</td>`;
  }
  const v = Number(r.discrepancy);
  if (Math.abs(v) < 0.01) {
    return `<td style="text-align:right;" class="text-success">0,00 $</td>`;
  }
  return `<td style="text-align:right; font-weight:600;" class="text-danger">${formatMoney(v)}</td>`;
}

export async function renderCashierScreen(content, profile, { canAdjust = false } = {}) {
  content.innerHTML = `<p class="muted">Chargement…</p>`;
  let correctingId = null;

  async function draw() {
    const { data, errors } = await loadAll({ reports: getCashierReports(30) });
    const reports = data.reports;
    const dernier = reports[0] || null;
    const ecarts = reports.filter((r) => r.discrepancy !== null && Math.abs(Number(r.discrepancy)) >= 0.01);

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Rapport de caisse</h1>
      <p class="muted" style="margin-bottom:16px;">
        Généré automatiquement chaque nuit.
        ${canAdjust ? 'Toute correction manuelle est journalisée.' : "Consultation en lecture seule ; la correction est réservée à l'administration."}
      </p>
      ${loadErrorBanner(errors)}

      ${
        dernier
          ? `
      <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); margin-bottom:20px;">
        <div class="card">
          <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.05em;">Trésorerie (fonds propres)</div>
          <div class="font-display gold" style="font-size:24px; margin-top:6px;">${formatMoney(dernier.actual_balance ?? dernier.closing_balance)}</div>
          <div class="muted" style="font-size:12px; margin-top:4px;">Au ${formatDate(dernier.report_date)}</div>
        </div>
        <div class="card">
          <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.05em;">Écart de caisse</div>
          <div class="font-display ${dernier.discrepancy !== null && Math.abs(Number(dernier.discrepancy)) >= 0.01 ? 'text-danger' : ''}" style="font-size:24px; margin-top:6px;">
            ${dernier.discrepancy === null || dernier.discrepancy === undefined ? '—' : formatMoney(dernier.discrepancy)}
          </div>
          <div class="muted" style="font-size:12px; margin-top:4px;">Calculé moins réel</div>
        </div>
        <div class="card">
          <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.05em;">Masse monétaire</div>
          <div class="font-display" style="font-size:24px; margin-top:6px;">${dernier.money_supply === null || dernier.money_supply === undefined ? '—' : formatMoney(dernier.money_supply)}</div>
          <div class="muted" style="font-size:12px; margin-top:4px;">Tous comptes confondus</div>
        </div>
      </div>`
          : ''
      }

      ${
        ecarts.length
          ? `<div class="card" style="margin-bottom:20px; border-color: var(--danger, #c0392b);">
               <div style="font-weight:600; margin-bottom:6px;">${ecarts.length} journée${ecarts.length > 1 ? 's' : ''} avec un écart de caisse</div>
               <div class="muted" style="font-size:13px;">
                 Le solde de clôture calculé ne correspond pas au solde réel du compte de trésorerie : un mouvement d'argent
                 n'est pas expliqué par les transactions de la journée. Une alerte de fraude est émise automatiquement pour chacune.
               </div>
             </div>`
          : ''
      }

      <div class="card" style="overflow-x:auto;">
        ${
          reports.length
            ? `<table>
                <thead><tr>
                  <th>Date</th>
                  <th style="text-align:right;">Ouverture</th>
                  <th style="text-align:right;">Entrées</th>
                  <th style="text-align:right;">Sorties</th>
                  <th style="text-align:right;">Clôture calculée</th>
                  <th style="text-align:right;">Solde réel</th>
                  <th style="text-align:right;">Écart</th>
                  ${canAdjust ? '<th></th>' : ''}
                </tr></thead>
                <tbody>
                  ${reports
                    .map(
                      (r) => `
                    <tr>
                      <td style="white-space:nowrap;">${formatDate(r.report_date)}</td>
                      <td style="text-align:right;" class="muted">${formatMoney(r.opening_balance)}</td>
                      <td style="text-align:right;" class="text-success">+${formatMoney(r.total_in)}</td>
                      <td style="text-align:right;" class="text-danger">−${formatMoney(r.total_out)}</td>
                      <td style="text-align:right; font-weight:600;">${formatMoney(r.closing_balance)}</td>
                      <td style="text-align:right;" class="muted">${r.actual_balance === null || r.actual_balance === undefined ? '—' : formatMoney(r.actual_balance)}</td>
                      ${ecartCell(r)}
                      ${canAdjust ? `<td style="text-align:right;"><button class="btn btn-secondary correct-btn" data-id="${r.id}" style="padding:4px 10px; font-size:12px;">Corriger</button></td>` : ''}
                    </tr>
                    ${r.adjustment_amount ? `<tr><td colspan="${canAdjust ? 8 : 7}" class="muted" style="font-size:12px; white-space:pre-wrap;">Ajustement admin : ${formatMoney(r.adjustment_amount)} — ${escapeHtml(r.adjustment_note || '')}</td></tr>` : ''}
                    ${
                      canAdjust && correctingId === r.id
                        ? `
                    <tr>
                      <td colspan="8">
                        <div class="grid" style="grid-template-columns: 1fr 2fr auto; gap:10px; align-items:end; padding:10px 0;">
                          <div class="field" style="margin:0;">
                            <label for="adjust-amount">Montant de l'ajustement</label>
                            <input type="number" step="0.01" id="adjust-amount" />
                          </div>
                          <div class="field" style="margin:0;">
                            <label for="adjust-note">Note (obligatoire)</label>
                            <input type="text" id="adjust-note" placeholder="Motif de la correction..." />
                          </div>
                          <button class="btn btn-primary adjust-submit" data-id="${r.id}">Enregistrer</button>
                        </div>
                      </td>
                    </tr>`
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
      <p class="muted" style="font-size:12px; margin-top:12px;">
        « Solde réel » et « Écart » n'existent que depuis la réconciliation ajoutée le 30/08 — les rapports antérieurs
        affichent « — » plutôt qu'un zéro qui laisserait croire qu'ils ont été vérifiés.
      </p>
    `;

    if (!canAdjust) return;

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
        if (!amount) { await showAlert('Veuillez saisir un montant non nul.'); return; }
        if (!note) { await showAlert('Une note justifiant la correction est requise.'); return; }
        btn.disabled = true;
        try {
          await adjustCashierReport(btn.getAttribute('data-id'), amount, note);
          correctingId = null;
          await draw();
        } catch (err) { await showAlert(err.message || 'Erreur.'); btn.disabled = false; }
      });
    });
  }

  await draw();
}

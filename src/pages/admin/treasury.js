// ============================================================================
// NEWPAD — Trésorerie & émission monétaire (admin)
// ============================================================================
// Écran de pilotage direct des montants. Il permet de fixer le solde de
// n'importe quel compte — client comme trésorerie de la banque — à la valeur
// voulue, en choisissant explicitement d'où vient l'argent.
//
// Le point important : aucun solde n'est écrasé « à la main ». Chaque
// modification écrit sa contrepartie au grand livre (migration 0024), donc le
// solde affiché reste à tout instant égal à la somme de son historique. C'est
// exactement ce qui permet au contrôle d'intégrité du tableau de bord de
// rester vert après une modification.
// ============================================================================

import { renderAdminShell } from './shell.js';
import {
  getAllAccountsForAdmin,
  adminSetAccountBalance,
  getTreasuryStats,
  checkLedgerIntegrity,
} from '../../lib/adminApi.js';
import { formatMoney, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { loadAll, loadErrorBanner } from '../../lib/loadState.js';

export async function renderAdminTreasury(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'treasury');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  let search = '';

  async function draw() {
    const { data, errors } = await loadAll({
      accounts: getAllAccountsForAdmin(),
      stats: { promise: getTreasuryStats(), fallback: null },
      anomalies: { promise: checkLedgerIntegrity(), fallback: [] },
    });
    const { accounts, stats, anomalies } = data;

    const needle = search.trim().toLowerCase();
    const shown = accounts.filter((a) => {
      if (!needle) return true;
      return (
        String(a.iban || '').toLowerCase().includes(needle) ||
        String(a.profiles?.display_name || '').toLowerCase().includes(needle) ||
        String(a.profiles?.username || '').toLowerCase().includes(needle)
      );
    });

    const emission = anomalies.find((a) => a.anomalie?.startsWith('Émission monétaire'));
    const vraiesAnomalies = anomalies.filter((a) => !a.anomalie?.startsWith('Émission monétaire'));

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Trésorerie &amp; émission monétaire</h1>
      <p class="muted" style="margin-bottom:20px; max-width:70ch;">
        Fixez ici le solde de n'importe quel compte. Chaque modification est inscrite au grand livre
        avec sa contrepartie — le solde reste donc toujours cohérent avec son historique.
      </p>
      ${loadErrorBanner(errors)}

      <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); margin-bottom:24px;">
        <div class="card card-tight">
          <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.04em;">Fonds propres</div>
          <div class="font-display gold" style="font-size:24px; margin-top:8px;">${stats ? formatMoney(stats.fonds_propres) : '—'}</div>
          <div class="muted" style="font-size:11px; margin-top:4px;">Argent appartenant à la banque</div>
        </div>
        <div class="card card-tight">
          <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.04em;">Actif en gestion</div>
          <div class="font-display gold" style="font-size:24px; margin-top:8px;">${stats ? formatMoney(stats.actif_gestion) : '—'}</div>
          <div class="muted" style="font-size:11px; margin-top:4px;">Argent des clients</div>
        </div>
        <div class="card card-tight" style="border-color: var(--gold);">
          <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.04em;">Masse monétaire</div>
          <div class="font-display gold" style="font-size:24px; margin-top:8px;">${stats ? formatMoney(stats.solde_total) : '—'}</div>
          <div class="muted" style="font-size:11px; margin-top:4px;">Total en circulation</div>
        </div>
        <div class="card card-tight">
          <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.04em;">Émis à la main</div>
          <div class="font-display" style="font-size:24px; margin-top:8px;">${emission ? formatMoney(emission.montant) : formatMoney(0)}</div>
          <div class="muted" style="font-size:11px; margin-top:4px;">${emission ? escapeHtml(emission.detail) : 'Aucune émission'}</div>
        </div>
      </div>

      ${
        vraiesAnomalies.length
          ? `<div class="card" style="border-color: var(--status-danger); margin-bottom:20px;">
               <h3 style="margin:0 0 8px;">⚠ ${vraiesAnomalies.length} anomalie(s) monétaire(s)</h3>
               <table><tbody>
                 ${vraiesAnomalies.map((a) => `<tr>
                   <td>${escapeHtml(a.anomalie)}</td>
                   <td class="muted">${escapeHtml(a.detail)}</td>
                   <td style="text-align:right; font-weight:600;">${formatMoney(a.montant)}</td>
                 </tr>`).join('')}
               </tbody></table>
             </div>`
          : `<div class="card card-tight" style="margin-bottom:20px;">
               <span class="text-success">✓</span>
               <span class="muted" style="margin-left:6px;">Grand livre cohérent — chaque solde correspond à son historique.</span>
             </div>`
      }

      <div class="card">
        <div class="flex justify-between items-center" style="margin-bottom:14px; flex-wrap:wrap; gap:10px;">
          <h3 style="margin:0;">Comptes (${shown.length})</h3>
          <input type="text" id="acc-search" placeholder="Rechercher un titulaire ou un IBAN…"
                 value="${escapeHtml(search)}" style="min-width:240px;" />
        </div>

        <div style="overflow-x:auto;">
        <table>
          <thead><tr>
            <th>Titulaire</th><th>IBAN</th><th>Type</th>
            <th style="text-align:right;">Solde actuel</th>
            <th style="min-width:150px;">Nouveau solde</th>
            <th style="min-width:150px;">Contrepartie</th>
            <th></th>
          </tr></thead>
          <tbody>
            ${shown.map((a) => `
              <tr>
                <td style="font-weight:${a.is_bank_treasury ? '600' : '400'};">
                  ${a.is_bank_treasury ? '🏦 Trésorerie de la banque' : escapeHtml(a.profiles?.display_name || '—')}
                </td>
                <td class="muted" style="font-size:12px;">${escapeHtml(a.iban || '')}</td>
                <td class="muted" style="font-size:12px;">${escapeHtml(a.account_type || '')}${a.status !== 'active' ? ` (${escapeHtml(a.status)})` : ''}</td>
                <td style="text-align:right; font-weight:600;" class="${Number(a.balance) < 0 ? 'text-danger' : ''}">${formatMoney(a.balance)}</td>
                <td><input type="number" class="new-balance" data-id="${a.id}" step="0.01"
                           placeholder="${a.balance}" style="width:140px; padding:4px 8px; font-size:13px;" /></td>
                <td>
                  <select class="counterpart" data-id="${a.id}" style="width:auto; padding:4px 8px; font-size:12px;">
                    ${a.is_bank_treasury ? '' : '<option value="treasury">Depuis la banque</option>'}
                    <option value="issuance" ${a.is_bank_treasury ? 'selected' : ''}>Émission monétaire</option>
                  </select>
                </td>
                <td><button class="btn btn-secondary apply-balance" data-id="${a.id}"
                            data-label="${escapeHtml(a.is_bank_treasury ? 'la trésorerie de la banque' : (a.profiles?.display_name || a.iban))}"
                            style="padding:4px 10px; font-size:12px;">Appliquer</button></td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        </div>

        <p class="muted" style="font-size:12px; margin-top:14px; line-height:1.6;">
          <strong>Depuis la banque</strong> : l'argent est pris sur les fonds propres ou y retourne.
          La masse monétaire totale ne change pas — c'est le cas normal.<br/>
          <strong>Émission monétaire</strong> : de l'argent est créé ou détruit. La masse totale change,
          et l'opération apparaît à part dans le contrôle d'intégrité.
        </p>
      </div>
    `;

    const searchEl = document.getElementById('acc-search');
    if (searchEl) {
      let debounce;
      searchEl.addEventListener('input', () => {
        clearTimeout(debounce);
        const value = searchEl.value;
        debounce = setTimeout(() => {
          search = value;
          draw().then(() => {
            const el = document.getElementById('acc-search');
            if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
          });
        }, 250);
      });
    }

    content.querySelectorAll('.apply-balance').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const input = content.querySelector(`.new-balance[data-id="${id}"]`);
        const select = content.querySelector(`.counterpart[data-id="${id}"]`);
        const raw = input?.value;
        if (raw === '' || raw === null || raw === undefined) {
          await showAlert('Saisissez le nouveau solde souhaité.');
          return;
        }
        const newBalance = parseFloat(raw);
        if (Number.isNaN(newBalance)) { await showAlert('Montant invalide.'); return; }

        const counterpart = select?.value || 'treasury';
        const label = btn.getAttribute('data-label');
        const ok = await showConfirm(
          `Fixer le solde de ${label} à ${formatMoney(newBalance)} ?\n\n` +
          (counterpart === 'issuance'
            ? "Contrepartie : ÉMISSION MONÉTAIRE — de l'argent va être créé ou détruit, la masse monétaire du serveur va changer."
            : 'Contrepartie : la trésorerie de la banque sera débitée ou créditée d\'autant.')
        );
        if (!ok) return;

        btn.disabled = true;
        try {
          await adminSetAccountBalance(id, newBalance, null, counterpart);
          await draw();
        } catch (err) {
          await showAlert(err.message || 'Modification impossible.');
          btn.disabled = false;
        }
      });
    });
  }

  await draw();
}

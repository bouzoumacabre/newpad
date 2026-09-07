// ============================================================================
// NEWPAD — Historique complet des opérations du client.
// ============================================================================
// Le personnel dispose d'un registre cherchable et filtrable depuis le 20/08.
// Le client, lui, n'avait que les opérations d'UN compte à la fois, sans
// recherche, sans filtre de date, et plafonnées sans que rien ne le signale.
// C'est pourtant lui qui a le plus de raisons de chercher une opération
// précise — « quand ai-je payé ce loyer de coffre ? ».
//
// Les données viennent de `my_transactions` (migration 0040) : filtrage et
// pagination côté base, avec le nombre total correspondant au filtre.
// ============================================================================

import { renderClientShell } from './shell.js';
import { listMyTransactions, getMyTransactionTypes } from '../../lib/clientApi.js';
import { formatMoney, formatDateTime, formatDate, statusBadge, escapeHtml, txTypeLabel } from '../../lib/format.js';
import { loadAll, loadErrorBanner } from '../../lib/loadState.js';

const PAS = 50;

export async function renderClientTransactions(app, profile) {
  const { content } = await renderClientShell(app, profile, 'transactions');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const filtres = { search: '', txType: '', from: '', to: '' };
  let affichees = PAS;

  async function draw() {
    const { data, errors } = await loadAll({
      page: { promise: listMyTransactions({ ...filtres, limit: affichees }), fallback: { rows: [], total: 0 } },
      types: getMyTransactionTypes(),
    });
    const lignes = data.page.rows || [];
    const total = data.page.total || 0;
    const types = data.types || [];

    // Le solde net de ce que montre le filtre : utile pour « combien m'ont
    // coûté les frais ce mois-ci ».
    const net = lignes.reduce((s, t) => s + Number(t.net_amount ?? (t.sens === 'debit' ? -t.amount : t.amount)), 0);

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Mes opérations</h1>
      <p class="muted" style="margin-bottom:20px;">Toutes les opérations de tous vos comptes, cherchables et filtrables.</p>
      ${loadErrorBanner(errors)}

      <div class="card" style="margin-bottom:20px;">
        <div class="grid" style="grid-template-columns: 2fr 1.3fr 1fr 1fr; gap:10px; align-items:end;">
          <div class="field" style="margin:0;">
            <label for="tx-search">Rechercher</label>
            <input type="text" id="tx-search" value="${escapeHtml(filtres.search)}" placeholder="Libellé ou montant…" />
          </div>
          <div class="field" style="margin:0;">
            <label for="tx-type">Type d'opération</label>
            <select id="tx-type">
              <option value="">Tous les types</option>
              ${types
                .map(
                  (t) =>
                    `<option value="${escapeHtml(t.tx_type)}" ${t.tx_type === filtres.txType ? 'selected' : ''}>${escapeHtml(txTypeLabel(t.tx_type))} (${t.total})</option>`
                )
                .join('')}
            </select>
          </div>
          <div class="field" style="margin:0;">
            <label for="tx-from">Du</label>
            <input type="date" id="tx-from" value="${filtres.from}" />
          </div>
          <div class="field" style="margin:0;">
            <label for="tx-to">Au</label>
            <input type="date" id="tx-to" value="${filtres.to}" />
          </div>
        </div>
        ${
          filtres.search || filtres.txType || filtres.from || filtres.to
            ? `<button id="tx-reset" class="btn btn-ghost" style="margin-top:10px; font-size:12px; padding:4px 10px;">Effacer les filtres</button>`
            : ''
        }
      </div>

      <div class="card">
        ${
          lignes.length
            ? `<table>
                <thead><tr><th>Date</th><th>Opération</th><th>Contrepartie</th><th style="text-align:right;">Montant</th><th>Statut</th></tr></thead>
                <tbody>
                  ${lignes
                    .map(
                      (t) => `
                    <tr>
                      <td class="muted" style="white-space:nowrap;">${formatDateTime(t.created_at)}</td>
                      <td>
                        <div>${escapeHtml(t.description || txTypeLabel(t.tx_type))}</div>
                        <div class="muted" style="font-size:11px;">${escapeHtml(txTypeLabel(t.tx_type))}</div>
                      </td>
                      <td class="muted">${escapeHtml(t.counterpart_label || '—')}</td>
                      <td style="text-align:right; font-weight:600;" class="${Number(t.net_amount) < 0 ? 'text-danger' : 'text-success'}">
                        ${Number(t.net_amount) < 0 ? '−' : '+'}${formatMoney(Math.abs(Number(t.net_amount)))}
                        ${
                          Number(t.fee_amount) > 0 && t.sens === 'credit'
                            ? `<div class="muted" style="font-size:11px; font-weight:400;">${formatMoney(t.amount)} envoyés, ${formatMoney(t.fee_amount)} de commission</div>`
                            : ''
                        }
                      </td>
                      <td>${statusBadge(t.status)}</td>
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>`
            : `<p class="muted">Aucune opération ne correspond à cette recherche.</p>`
        }

        ${
          lignes.length
            ? `<div class="flex justify-between items-center" style="margin-top:14px; flex-wrap:wrap; gap:10px;">
                 <span class="muted" style="font-size:13px;">
                   ${lignes.length} opération${lignes.length > 1 ? 's' : ''} sur ${total}
                   — solde net de la sélection :
                   <strong class="${net < 0 ? 'text-danger' : 'text-success'}">${net < 0 ? '−' : '+'}${formatMoney(Math.abs(net))}</strong>
                 </span>
                 <div class="flex gap-sm">
                   <button id="tx-csv" class="btn btn-ghost" style="font-size:12px; padding:4px 10px;">Exporter en CSV</button>
                   ${lignes.length < total ? `<button id="tx-plus" class="btn btn-secondary" style="font-size:13px; padding:5px 14px;">Afficher ${Math.min(PAS, total - lignes.length)} de plus</button>` : ''}
                 </div>
               </div>`
            : ''
        }
      </div>
    `;

    const relancer = () => {
      filtres.search = document.getElementById('tx-search').value.trim();
      filtres.txType = document.getElementById('tx-type').value;
      filtres.from = document.getElementById('tx-from').value;
      filtres.to = document.getElementById('tx-to').value;
      affichees = PAS; // tout changement de filtre repart de la première tranche
      draw();
    };

    let debounce;
    document.getElementById('tx-search')?.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(relancer, 300);
    });
    document.getElementById('tx-type')?.addEventListener('change', relancer);
    document.getElementById('tx-from')?.addEventListener('change', relancer);
    document.getElementById('tx-to')?.addEventListener('change', relancer);

    document.getElementById('tx-reset')?.addEventListener('click', () => {
      filtres.search = '';
      filtres.txType = '';
      filtres.from = '';
      filtres.to = '';
      affichees = PAS;
      draw();
    });

    document.getElementById('tx-plus')?.addEventListener('click', () => {
      affichees += PAS;
      draw();
    });

    document.getElementById('tx-csv')?.addEventListener('click', () => exporterCsv(lignes));
  }

  await draw();
}

// L'export porte sur ce qui est affiché — donc sur le filtre en cours, ce qui
// est justement l'intérêt : sortir un relevé d'une période ou d'un type précis.
function exporterCsv(lignes) {
  const echapper = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const entete = ['Date', 'Type', 'Libellé', 'Contrepartie', 'Sens', 'Montant porté au compte', 'Commission', 'Statut'];
  const corps = lignes.map((t) =>
    [
      formatDate(t.created_at),
      txTypeLabel(t.tx_type),
      t.description || '',
      t.counterpart_label || '',
      t.sens === 'debit' ? 'Débit' : 'Crédit',
      // Point décimal et signe explicite : un tableur français lira la colonne
      // comme un nombre plutôt que comme du texte.
      Number(t.net_amount ?? (t.sens === 'debit' ? -t.amount : t.amount)).toFixed(2),
      Number(t.fee_amount || 0).toFixed(2),
      t.status,
    ]
      .map(echapper)
      .join(';')
  );
  // BOM UTF-8 : sans lui, Excel affiche « Ã© » à la place des accents.
  const blob = new Blob(['﻿' + [entete.map(echapper).join(';'), ...corps].join('\r\n')], {
    type: 'text/csv;charset=utf-8;',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `newman-bank-operations-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

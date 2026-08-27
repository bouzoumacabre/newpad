import { renderClientShell } from './shell.js';
import { getMyAccounts, getAccountTransactions, getEconomicSetting } from '../../lib/clientApi.js';
import { formatMoney, formatDateTime, escapeHtml, txTypeLabel, statusBadge } from '../../lib/format.js';
import { loadAll, loadErrorBanner } from '../../lib/loadState.js';

const ACCOUNT_TYPE_LABELS = { courant: 'Compte courant', epargne: 'Compte épargne', entreprise: 'Compte entreprise' };

export async function renderClientAccounts(app, profile, params = {}) {
  const { content } = await renderClientShell(app, profile, 'accounts');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const initial = await loadAll({
    accounts: getMyAccounts(),
    savingsRate: { promise: getEconomicSetting('savings_rate'), fallback: null },
    savingsEnabled: { promise: getEconomicSetting('savings_interest_enabled'), fallback: null },
  });
  const accounts = initial.data.accounts;
  const savingsRate = initial.data.savingsRate?.amount ?? null;
  const savingsEnabled = initial.data.savingsEnabled?.enabled === true;

  if (!accounts.length) {
    content.innerHTML = `
      <h1>Mes comptes</h1>
      ${loadErrorBanner(initial.errors)}
      <div class="card"><p class="muted">Aucun compte trouvé.</p></div>`;
    return;
  }

  let activeId = params.id || accounts[0].id;
  let search = '';
  let typeFilter = '';

  async function renderAll() {
    const { data, errors } = await loadAll({
      transactions: getAccountTransactions(activeId, 200),
    });
    const transactions = data.transactions;
    const active = accounts.find((a) => a.id === activeId) || accounts[0];

    // Filtrage effectué sur les opérations déjà chargées : instantané, sans
    // aller-retour réseau — ce qui compte dans le navigateur intégré du jeu,
    // où chaque requête coûte cher en latence.
    const needle = search.trim().toLowerCase();
    const filtered = transactions.filter((t) => {
      if (typeFilter && t.tx_type !== typeFilter) return false;
      if (!needle) return true;
      return (
        String(t.description || '').toLowerCase().includes(needle) ||
        txTypeLabel(t.tx_type).toLowerCase().includes(needle) ||
        String(t.amount).includes(needle)
      );
    });

    const presentTypes = [...new Set(transactions.map((t) => t.tx_type))].sort((a, b) =>
      txTypeLabel(a).localeCompare(txTypeLabel(b))
    );

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Mes comptes</h1>
      ${loadErrorBanner([...initial.errors, ...errors])}
      <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); margin-bottom:24px;">
        ${accounts
          .map(
            (a) => `
          <div class="card card-tight account-card" data-id="${a.id}" style="cursor:pointer; ${a.id === activeId ? 'border-color: var(--gold); box-shadow: var(--shadow-gold-glow);' : ''}">
            <div class="muted" style="font-size:11px; text-transform:uppercase; letter-spacing:0.04em;">${ACCOUNT_TYPE_LABELS[a.account_type] || a.account_type}</div>
            <div class="font-display gold" style="font-size:22px; margin:6px 0;">${formatMoney(a.balance)}</div>
            <div class="muted" style="font-size:12px;">${escapeHtml(a.iban)}</div>
            ${
              a.status !== 'active'
                ? `<div style="margin-top:6px;">${statusBadge(a.status)}</div>`
                : ''
            }
            ${
              a.account_type === 'epargne' && savingsRate !== null
                ? `<div class="muted" style="font-size:11px; margin-top:6px; padding-top:6px; border-top:1px solid var(--card-border);">
                     ${savingsEnabled ? `Rémunéré à ${savingsRate} % par versement` : `Taux affiché : ${savingsRate} % — versements suspendus`}
                   </div>`
                : ''
            }
          </div>
        `
          )
          .join('')}
      </div>

      <div class="card">
        <div class="flex justify-between items-center" style="margin-bottom:12px; flex-wrap:wrap; gap:10px;">
          <h3 style="margin:0;">Historique — ${ACCOUNT_TYPE_LABELS[active.account_type] || active.account_type}</h3>
          <div style="display:flex; align-items:center; gap:12px;">
            <span class="muted" style="font-size:13px;">${escapeHtml(active.iban)}</span>
            ${filtered.length ? `<button id="export-csv" class="btn btn-secondary" style="font-size:12px; padding:4px 10px;">Exporter en CSV</button>` : ''}
          </div>
        </div>

        ${
          transactions.length
            ? `<div style="display:flex; gap:10px; margin-bottom:14px; flex-wrap:wrap;">
                 <input type="text" id="tx-search" placeholder="Rechercher (description, montant…)"
                        value="${escapeHtml(search)}" style="flex:1; min-width:180px;" />
                 <select id="tx-type" style="min-width:170px;">
                   <option value="">Tous les types</option>
                   ${presentTypes.map((t) => `<option value="${escapeHtml(t)}" ${t === typeFilter ? 'selected' : ''}>${escapeHtml(txTypeLabel(t))}</option>`).join('')}
                 </select>
               </div>`
            : ''
        }

        ${
          filtered.length
            ? `<table>
                <thead><tr><th>Date</th><th>Type</th><th>Description</th><th style="text-align:right;">Montant</th></tr></thead>
                <tbody>
                  ${filtered
                    .map((t) => {
                      const isCredit = t.to_account_id === activeId;
                      return `
                    <tr>
                      <td class="muted">${formatDateTime(t.created_at)}</td>
                      <td class="muted" style="font-size:12px;">${escapeHtml(txTypeLabel(t.tx_type))}</td>
                      <td>${escapeHtml(t.description || txTypeLabel(t.tx_type))}</td>
                      <td style="text-align:right; font-weight:600;" class="${isCredit ? 'text-success' : 'text-danger'}">
                        ${isCredit ? '+' : '−'}${formatMoney(t.amount)}
                      </td>
                    </tr>
                  `;
                    })
                    .join('')}
                </tbody>
              </table>
              ${
                filtered.length !== transactions.length
                  ? `<p class="muted" style="font-size:12px; margin-top:10px;">${filtered.length} opération(s) sur ${transactions.length} affichée(s).</p>`
                  : ''
              }`
            : transactions.length
              ? `<p class="muted">Aucune opération ne correspond à votre recherche.</p>`
              : `<p class="muted">Aucune opération sur ce compte.</p>`
        }
      </div>
    `;

    content.querySelectorAll('.account-card').forEach((el) => {
      el.addEventListener('click', () => {
        activeId = el.getAttribute('data-id');
        search = '';
        typeFilter = '';
        renderAll();
      });
    });

    const searchEl = document.getElementById('tx-search');
    if (searchEl) {
      let debounce;
      searchEl.addEventListener('input', () => {
        clearTimeout(debounce);
        const value = searchEl.value;
        debounce = setTimeout(() => {
          search = value;
          renderAll().then(() => {
            // Le rendu recrée le champ : on lui rend le focus et le curseur
            // en fin de saisie, sinon taper plus d'un caractère est impossible.
            const el = document.getElementById('tx-search');
            if (el) {
              el.focus();
              el.setSelectionRange(el.value.length, el.value.length);
            }
          });
        }, 250);
      });
    }

    document.getElementById('tx-type')?.addEventListener('change', (e) => {
      typeFilter = e.target.value;
      renderAll();
    });

    document.getElementById('export-csv')?.addEventListener('click', () => {
      exportTransactionsCsv(active, filtered, activeId);
    });
  }

  await renderAll();
}

function csvField(value) {
  const s = String(value ?? '');
  return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportTransactionsCsv(account, transactions, activeId) {
  const rows = [
    ['Date', 'Type', 'Description', 'Montant', 'Sens'],
    ...transactions.map((t) => {
      const isCredit = t.to_account_id === activeId;
      return [
        formatDateTime(t.created_at),
        txTypeLabel(t.tx_type),
        t.description || txTypeLabel(t.tx_type),
        t.amount,
        isCredit ? 'crédit' : 'débit',
      ];
    }),
  ];
  // BOM UTF-8 en tête : sans lui, Excel affiche les accents en mojibake.
  const csv = '﻿' + rows.map((r) => r.map(csvField).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `releve-${account.iban}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

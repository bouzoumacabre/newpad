import { renderAdminShell } from './shell.js';
import {
  getMembershipRequests,
  getTransfersQueue,
  getGoldBankQueue,
  getGoldMarketQueue,
  getSafeRequestsQueue,
  getLoansQueue,
  getFraudAlerts,
  getAllSupportTickets,
  getBranchQueue,
  getCashierReports,
  getConsultingQueue,
} from '../../lib/employeeApi.js';
import { getTreasuryStats, checkLedgerIntegrity } from '../../lib/adminApi.js';
import { formatMoney, formatDateTime, escapeHtml } from '../../lib/format.js';
import { navigate } from '../../lib/router.js';

function countPending(list, statuses = ['pending', 'processing']) {
  return list.filter((x) => statuses.includes(x.status)).length;
}

export async function renderAdminDashboard(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'dashboard');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const [membership, transfers, goldBank, goldMarket, safes, loans, fraud, tickets, queue, cashierReports, treasury, consulting] = await Promise.all([
    getMembershipRequests(['pending', 'processing']).catch(() => []),
    getTransfersQueue().catch(() => []),
    getGoldBankQueue().catch(() => []),
    getGoldMarketQueue().catch(() => []),
    getSafeRequestsQueue().catch(() => []),
    getLoansQueue().catch(() => []),
    getFraudAlerts('open').catch(() => []),
    getAllSupportTickets('open').catch(() => []),
    getBranchQueue().catch(() => []),
    getCashierReports(1).catch(() => []),
    getTreasuryStats().catch(() => null),
    getConsultingQueue().catch(() => []),
  ]);

  // Contrôle de conservation du grand livre. Volontairement placé sur le
  // tableau de bord admin et non dans un écran séparé : une anomalie monétaire
  // doit sauter aux yeux dès la connexion, pas attendre qu'on pense à aller
  // la chercher. `null` = le contrôle lui-même n'a pas pu tourner (on ne
  // prétend alors pas que tout va bien).
  const ledgerAnomalies = await checkLedgerIntegrity().catch(() => null);

  const loansAwaitingDecision = loans.filter((l) => l.status === 'processing').length;
  const lastReport = cashierReports[0];
  const consultingPending = consulting.filter((c) => c.status === 'pending');

  const stats = [
    { label: "Demandes d'adhésion", value: membership.length, path: '/admin/membership' },
    { label: 'Virements en attente', value: countPending(transfers), path: '/admin/transfers' },
    { label: 'Lingots (banque + marché)', value: countPending(goldBank) + countPending(goldMarket), path: '/admin/gold' },
    { label: 'Coffres en attente', value: countPending(safes), path: '/admin/safes' },
    { label: 'Consulting en attente', value: consultingPending.length, path: '/admin/consulting' },
    { label: "File d'attente", value: queue.filter((q) => q.status === 'waiting').length, path: '/admin/branch-queue' },
    { label: 'Alertes fraude ouvertes', value: fraud.length, path: '/admin/fraud' },
    { label: 'Tickets support ouverts', value: tickets.length, path: '/admin/support' },
    { label: 'Prêts en attente de décision finale', value: loansAwaitingDecision, path: '/admin/loans', highlight: true },
  ];

  // Vue 360 : aperçu combiné des demandes les plus récentes, tous types
  // confondus, pour ne pas avoir à ouvrir chaque écran un par un.
  const overview = [
    ...membership.map((m) => ({ type: 'Adhésion', name: m.profiles?.display_name || m.applicant_id, date: m.created_at, path: '/admin/membership' })),
    ...transfers.filter((t) => ['pending', 'processing'].includes(t.status)).map((t) => ({ type: 'Virement', name: t.motif || t.amount + ' $', date: t.requested_at || t.created_at, path: '/admin/transfers' })),
    ...safes.filter((s) => ['pending', 'processing'].includes(s.status)).map((s) => ({ type: 'Coffre-fort', name: s.profiles?.display_name || '', date: s.requested_at, path: '/admin/safes' })),
    ...loans.filter((l) => ['pending', 'processing'].includes(l.status)).map((l) => ({ type: 'Prêt', name: l.profiles?.display_name || '', date: l.requested_at, path: '/admin/loans' })),
    ...consultingPending.map((c) => ({ type: 'Consulting', name: c.profiles?.display_name || '', date: c.created_at, path: '/admin/consulting' })),
    ...tickets.map((t) => ({ type: 'Support', name: t.subject || '', date: t.created_at, path: '/admin/support' })),
    ...fraud.map((f) => ({ type: 'Fraude', name: f.description || '', date: f.created_at, path: '/admin/fraud' })),
  ]
    .filter((o) => o.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 12);

  content.innerHTML = `
    <h1 style="margin-bottom:6px;">Bienvenue, ${escapeHtml(profile.display_name)}.</h1>
    <p class="muted" style="margin-bottom:24px;">Aperçu de l'activité en attente de traitement et de décision.</p>

    <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));">
      ${stats
        .map(
          (s) => `
        <div class="card card-tight stat-card" data-path="${s.path}" style="cursor:pointer; ${s.highlight && s.value > 0 ? 'border-color: var(--gold);' : ''}">
          <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.04em;">${s.label}</div>
          <div class="font-display ${s.value > 0 ? 'gold' : ''}" style="font-size:28px; margin-top:8px;">${s.value}</div>
        </div>
      `
        )
        .join('')}
    </div>

    <h3 style="margin:28px 0 12px;">Aperçu global — activité récente en attente</h3>
    <div class="card" style="margin-bottom:28px;">
      ${
        overview.length
          ? `<table>
              <thead><tr><th>Type</th><th>Détail</th><th>Date</th></tr></thead>
              <tbody>
                ${overview
                  .map(
                    (o) => `
                  <tr class="overview-row" data-path="${o.path}" style="cursor:pointer;">
                    <td><span class="badge badge-neutral" style="font-size:11px;">${escapeHtml(o.type)}</span></td>
                    <td>${escapeHtml(String(o.name))}</td>
                    <td class="muted" style="white-space:nowrap;">${formatDateTime(o.date)}</td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>`
          : `<p class="muted">Rien en attente pour le moment — tout est à jour.</p>`
      }
    </div>

    ${
      ledgerAnomalies === null
        ? `<div class="card card-tight" style="margin-bottom:20px;">
             <span class="muted">⚠ Le contrôle d'intégrité du grand livre n'a pas pu être exécuté.</span>
           </div>`
        : ledgerAnomalies.length
          ? `<div class="card" style="border-color: var(--danger, #c0392b); margin-bottom:20px;">
               <h3 style="margin:0 0 10px;">⚠ Anomalies monétaires détectées (${ledgerAnomalies.length})</h3>
               <p class="muted" style="font-size:13px; margin-bottom:12px;">
                 Le total des soldes ne correspond pas à l'historique des mouvements. Chaque ligne
                 ci-dessous est de l'argent apparu ou disparu sans contrepartie.
               </p>
               <table>
                 <thead><tr><th>Anomalie</th><th>Détail</th><th style="text-align:right;">Montant</th></tr></thead>
                 <tbody>
                   ${ledgerAnomalies
                     .map(
                       (a) => `<tr>
                         <td>${escapeHtml(a.anomalie)}</td>
                         <td class="muted">${escapeHtml(a.detail)}</td>
                         <td style="text-align:right; font-weight:600;">${formatMoney(a.montant)}</td>
                       </tr>`
                     )
                     .join('')}
                 </tbody>
               </table>
             </div>`
          : `<div class="card card-tight" style="margin-bottom:20px;">
               <span class="text-success">✓</span>
               <span class="muted" style="margin-left:6px;">Grand livre cohérent — aucune anomalie monétaire.</span>
             </div>`
    }

    <h3 style="margin:28px 0 12px;">Trésorerie de la banque</h3>
    <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-bottom:28px;">
      <div class="card card-tight">
        <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.04em;">Fonds propres</div>
        <div class="font-display gold" style="font-size:26px; margin-top:8px;">${treasury ? formatMoney(treasury.fonds_propres) : '—'}</div>
        <div class="muted" style="font-size:11px; margin-top:4px;">Argent qui appartient réellement à la banque</div>
      </div>
      <div class="card card-tight">
        <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.04em;">Actif en gestion</div>
        <div class="font-display gold" style="font-size:26px; margin-top:8px;">${treasury ? formatMoney(treasury.actif_gestion) : '—'}</div>
        <div class="muted" style="font-size:11px; margin-top:4px;">Argent des clients géré par la banque</div>
      </div>
      <div class="card card-tight" style="border-color: var(--gold);">
        <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.04em;">Solde total</div>
        <div class="font-display gold" style="font-size:26px; margin-top:8px;">${treasury ? formatMoney(treasury.solde_total) : '—'}</div>
        <div class="muted" style="font-size:11px; margin-top:4px;">Fonds propres + actif en gestion</div>
      </div>
    </div>

    <h3 style="margin:28px 0 12px;">Caisse — dernière clôture</h3>
    <div class="card stat-card" data-path="/admin/cashier" style="cursor:pointer; max-width:340px;">
      ${
        lastReport
          ? `
        <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.04em;">Solde de clôture</div>
        <div class="font-display gold" style="font-size:28px; margin-top:8px;">${formatMoney(lastReport.closing_balance)}</div>
      `
          : `<p class="muted">Aucun rapport de caisse disponible.</p>`
      }
    </div>
  `;

  content.querySelectorAll('.stat-card, .overview-row').forEach((el) => {
    el.addEventListener('click', () => navigate(el.getAttribute('data-path')));
  });
}

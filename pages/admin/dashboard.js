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
} from '../../lib/employeeApi.js';
import { formatMoney, escapeHtml } from '../../lib/format.js';
import { navigate } from '../../lib/router.js';

function countPending(list, statuses = ['pending', 'processing']) {
  return list.filter((x) => statuses.includes(x.status)).length;
}

export async function renderAdminDashboard(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'dashboard');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const [membership, transfers, goldBank, goldMarket, safes, loans, fraud, tickets, queue, cashierReports] = await Promise.all([
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
  ]);

  const loansAwaitingDecision = loans.filter((l) => l.status === 'processing').length;
  const lastReport = cashierReports[0];

  const stats = [
    { label: "Demandes d'adhésion", value: membership.length, path: '/admin/membership' },
    { label: 'Virements en attente', value: countPending(transfers), path: '/admin/transfers' },
    { label: 'Lingots (banque + marché)', value: countPending(goldBank) + countPending(goldMarket), path: '/admin/gold' },
    { label: 'Coffres en attente', value: countPending(safes), path: '/admin/safes' },
    { label: "File d'attente", value: queue.filter((q) => q.status === 'waiting').length, path: '/admin/branch-queue' },
    { label: 'Alertes fraude ouvertes', value: fraud.length, path: '/admin/fraud' },
    { label: 'Tickets support ouverts', value: tickets.length, path: '/admin/support' },
    { label: 'Prêts en attente de décision finale', value: loansAwaitingDecision, path: '/admin/loans', highlight: true },
  ];

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

  content.querySelectorAll('.stat-card').forEach((el) => {
    el.addEventListener('click', () => navigate(el.getAttribute('data-path')));
  });
}

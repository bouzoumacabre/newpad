import { renderEmployeeShell } from './shell.js';
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
} from '../../lib/employeeApi.js';
import { escapeHtml } from '../../lib/format.js';
import { navigate } from '../../lib/router.js';

function countPending(list, statuses = ['pending', 'processing']) {
  return list.filter((x) => statuses.includes(x.status)).length;
}

export async function renderEmployeeDashboard(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'dashboard');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const [membership, transfers, goldBank, goldMarket, safes, loans, fraud, tickets, queue] = await Promise.all([
    getMembershipRequests(['pending', 'processing']).catch(() => []),
    getTransfersQueue().catch(() => []),
    getGoldBankQueue().catch(() => []),
    getGoldMarketQueue().catch(() => []),
    getSafeRequestsQueue().catch(() => []),
    getLoansQueue().catch(() => []),
    getFraudAlerts('open').catch(() => []),
    getAllSupportTickets('open').catch(() => []),
    getBranchQueue().catch(() => []),
  ]);

  const stats = [
    { label: "Demandes d'adhésion", value: membership.length, path: '/employee/membership' },
    { label: 'Virements en attente', value: countPending(transfers), path: '/employee/transfers' },
    { label: 'Lingots (banque + marché)', value: countPending(goldBank) + countPending(goldMarket), path: '/employee/gold' },
    { label: 'Coffres en attente', value: countPending(safes), path: '/employee/safes' },
    { label: 'Prêts à réceptionner', value: loans.filter((l) => l.status === 'pending').length, path: '/employee/loans' },
    { label: 'File d\'attente', value: queue.filter((q) => q.status === 'waiting').length, path: '/employee/branch-queue' },
    { label: 'Alertes fraude ouvertes', value: fraud.length, path: '/employee/fraud' },
    { label: 'Tickets support ouverts', value: tickets.length, path: '/employee/support' },
  ];

  content.innerHTML = `
    <h1 style="margin-bottom:6px;">Bienvenue, ${escapeHtml(profile.display_name)}.</h1>
    <p class="muted" style="margin-bottom:24px;">${profile.employee_title ? escapeHtml(profile.employee_title) + ' — ' : ''}Aperçu de l'activité en attente de traitement.</p>

    <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));">
      ${stats
        .map(
          (s) => `
        <div class="card card-tight stat-card" data-path="${s.path}" style="cursor:pointer;">
          <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.04em;">${s.label}</div>
          <div class="font-display ${s.value > 0 ? 'gold' : ''}" style="font-size:28px; margin-top:8px;">${s.value}</div>
        </div>
      `
        )
        .join('')}
    </div>
  `;

  content.querySelectorAll('.stat-card').forEach((el) => {
    el.addEventListener('click', () => navigate(el.getAttribute('data-path')));
  });
}

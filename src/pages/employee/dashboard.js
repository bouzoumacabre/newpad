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
  getConsultingQueue,
} from '../../lib/employeeApi.js';
import { formatDateTime, escapeHtml } from '../../lib/format.js';
import { navigate } from '../../lib/router.js';

function countPending(list, statuses = ['pending', 'processing']) {
  return list.filter((x) => statuses.includes(x.status)).length;
}

export async function renderEmployeeDashboard(app, profile) {
  const { content } = await renderEmployeeShell(app, profile, 'dashboard');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const [membership, transfers, goldBank, goldMarket, safes, loans, fraud, tickets, queue, consulting] = await Promise.all([
    getMembershipRequests(['pending', 'processing']).catch(() => []),
    getTransfersQueue().catch(() => []),
    getGoldBankQueue().catch(() => []),
    getGoldMarketQueue().catch(() => []),
    getSafeRequestsQueue().catch(() => []),
    getLoansQueue().catch(() => []),
    getFraudAlerts('open').catch(() => []),
    getAllSupportTickets('open').catch(() => []),
    getBranchQueue().catch(() => []),
    getConsultingQueue().catch(() => []),
  ]);

  const consultingPending = consulting.filter((c) => c.status === 'pending');

  const stats = [
    { label: "Demandes d'adhésion", value: membership.length, path: '/employee/membership' },
    { label: 'Virements en attente', value: countPending(transfers), path: '/employee/transfers' },
    { label: 'Lingots (banque + marché)', value: countPending(goldBank) + countPending(goldMarket), path: '/employee/gold' },
    { label: 'Coffres en attente', value: countPending(safes), path: '/employee/safes' },
    { label: 'Consulting en attente', value: consultingPending.length, path: '/employee/consulting' },
    { label: 'Prêts à réceptionner', value: loans.filter((l) => l.status === 'pending').length, path: '/employee/loans' },
    { label: 'File d\'attente', value: queue.filter((q) => q.status === 'waiting').length, path: '/employee/branch-queue' },
    { label: 'Alertes fraude ouvertes', value: fraud.length, path: '/employee/fraud' },
    { label: 'Tickets support ouverts', value: tickets.length, path: '/employee/support' },
  ];

  const overview = [
    ...membership.map((m) => ({ type: 'Adhésion', name: m.profiles?.display_name || m.applicant_id, date: m.created_at, path: '/employee/membership' })),
    ...transfers.filter((t) => ['pending', 'processing'].includes(t.status)).map((t) => ({ type: 'Virement', name: t.motif || t.amount + ' $', date: t.requested_at || t.created_at, path: '/employee/transfers' })),
    ...safes.filter((s) => ['pending', 'processing'].includes(s.status)).map((s) => ({ type: 'Coffre-fort', name: s.profiles?.display_name || '', date: s.requested_at, path: '/employee/safes' })),
    ...loans.filter((l) => ['pending', 'processing'].includes(l.status)).map((l) => ({ type: 'Prêt', name: l.profiles?.display_name || '', date: l.requested_at, path: '/employee/loans' })),
    ...consultingPending.map((c) => ({ type: 'Consulting', name: c.profiles?.display_name || '', date: c.created_at, path: '/employee/consulting' })),
    ...tickets.map((t) => ({ type: 'Support', name: t.subject || '', date: t.created_at, path: '/employee/support' })),
    ...fraud.map((f) => ({ type: 'Fraude', name: f.description || '', date: f.created_at, path: '/employee/fraud' })),
  ]
    .filter((o) => o.date)
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 12);

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

    <h3 style="margin:28px 0 12px;">Aperçu global — activité récente en attente</h3>
    <div class="card">
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
  `;

  content.querySelectorAll('.stat-card, .overview-row').forEach((el) => {
    el.addEventListener('click', () => navigate(el.getAttribute('data-path')));
  });
}

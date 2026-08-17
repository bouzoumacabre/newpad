// ============================================================================
// NEWPAD — Coquille de l'interface Employé
// ============================================================================

import { renderShell } from '../../lib/shell.js';
import { getFeatureFlags } from '../../lib/features.js';

export async function renderEmployeeShell(app, profile, activeKey) {
  let flags = {};
  try {
    flags = await getFeatureFlags('employee', 'employee');
  } catch (_) { /* en cas d'échec réseau, on affiche tout par défaut ci-dessous */ }

  const has = (key) => (key in flags ? flags[key] : true);

  const sections = [
    { key: 'dashboard', label: 'Tableau de bord', path: '/employee', icon: '◆' },
    {
      category: 'Clients',
      items: [
        ...(has('employee.clients.search') ? [{ key: 'clients', label: 'Recherche clients', path: '/employee/clients', icon: '⌕' }] : []),
        ...(has('employee.membership.review') ? [{ key: 'membership', label: "Demandes d'adhésion", path: '/employee/membership', icon: '✎' }] : []),
        ...(has('employee.accounts.open') ? [{ key: 'account-opening', label: 'Ouverture de compte', path: '/employee/account-opening', icon: '＋' }] : []),
        { key: 'branch-queue', label: "File d'attente", path: '/employee/branch-queue', icon: '☰' },
      ],
    },
    {
      category: 'Opérations',
      items: [
        ...(has('employee.transfers.process') ? [{ key: 'transfers', label: 'Virements', path: '/employee/transfers', icon: '⇄' }] : []),
        ...(has('employee.gold.process') ? [{ key: 'gold', label: 'Lingots & marché', path: '/employee/gold', icon: '●' }] : []),
        ...(has('employee.safes.process') ? [{ key: 'safes', label: 'Coffres-forts', path: '/employee/safes', icon: '▣' }] : []),
        ...(has('employee.loans.review') ? [{ key: 'loans', label: 'Prêts', path: '/employee/loans', icon: '§' }] : []),
        { key: 'consulting', label: 'Consulting Premium', path: '/employee/consulting', icon: '★' },
      ],
    },
    {
      category: 'Caisse & sécurité',
      items: [
        { key: 'cashier', label: 'Rapport de caisse', path: '/employee/cashier', icon: '▤' },
        ...(has('employee.fraud.flag') ? [{ key: 'fraud', label: 'Alertes fraude', path: '/employee/fraud', icon: '⚠' }] : []),
      ],
    },
    {
      category: 'Services',
      items: [
        { key: 'support', label: 'Support', path: '/employee/support', icon: '✉' },
        { key: 'audit', label: "Journal d'activité", path: '/employee/audit', icon: '▦' },
      ],
    },
  ].filter((s) => !s.category || s.items.length > 0);

  const footerItems = [{ key: 'settings', label: 'Paramètres', path: '/employee/settings', icon: '⚙' }];

  return renderShell(app, profile, 'Espace Employé', sections, activeKey, { footerItems });
}

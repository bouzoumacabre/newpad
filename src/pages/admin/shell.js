// ============================================================================
// NEWPAD — Coquille de l'interface Admin
// ============================================================================

import { renderShell } from '../../lib/shell.js';
import { getFeatureFlags } from '../../lib/features.js';
import { DISCORD_INVITE_URL } from '../../lib/constants.js';

export async function renderAdminShell(app, profile, activeKey) {
  let flags = {};
  try {
    flags = await getFeatureFlags('admin', 'admin');
  } catch (_) { /* en cas d'échec réseau, on affiche tout par défaut ci-dessous */ }

  const has = (key) => (key in flags ? flags[key] : true);

  const sections = [
    { key: 'dashboard', label: 'Tableau de bord', path: '/admin', icon: '◆' },
    {
      category: 'Clients',
      items: [
        { key: 'clients', label: 'Recherche clients', path: '/admin/clients', icon: '⌕' },
        { key: 'membership', label: "Demandes d'adhésion", path: '/admin/membership', icon: '✎' },
        { key: 'account-opening', label: 'Ouverture de compte', path: '/admin/account-opening', icon: '＋' },
        { key: 'branch-queue', label: "File d'attente", path: '/admin/branch-queue', icon: '☰' },
      ],
    },
    {
      category: 'Opérations',
      items: [
        { key: 'transfers', label: 'Virements', path: '/admin/transfers', icon: '⇄' },
        { key: 'gold', label: 'Lingots & marché', path: '/admin/gold', icon: '●' },
        { key: 'safes', label: 'Coffres-forts', path: '/admin/safes', icon: '▣' },
        ...(has('admin.loans.decide') ? [{ key: 'loans', label: 'Prêts', path: '/admin/loans', icon: '§' }] : []),
        { key: 'consulting', label: 'Consulting Premium', path: '/admin/consulting', icon: '★' },
        ...(has('admin.transactions.view') ? [{ key: 'transactions', label: 'Historique transactions', path: '/admin/transactions', icon: '≡' }] : []),
      ],
    },
    {
      category: 'Caisse & sécurité',
      items: [
        { key: 'cashier', label: 'Rapport de caisse', path: '/admin/cashier', icon: '▤' },
        { key: 'fraud', label: 'Alertes fraude', path: '/admin/fraud', icon: '⚠' },
      ],
    },
    {
      category: 'Administration',
      items: [
        { key: 'staff', label: 'Employés & rôles', path: '/admin/staff', icon: '♛' },
        ...(has('admin.permissions.manage') ? [{ key: 'permissions', label: 'Permissions', path: '/admin/permissions', icon: '✦' }] : []),
        { key: 'irs-accounts', label: 'Comptes IRS', path: '/admin/irs-accounts', icon: '⌘' },
        ...(has('admin.masking.manage') ? [{ key: 'visibility', label: 'Masquage', path: '/admin/visibility', icon: '◐' }] : []),
        { key: 'economic-settings', label: 'Pilotage économique', path: '/admin/economic-settings', icon: '⚖' },
        ...(has('admin.content.manage') ? [{ key: 'cms', label: 'Contenu du site', path: '/admin/cms', icon: '▧' }] : []),
        ...(has('admin.system.config') ? [{ key: 'system', label: 'Configuration système', path: '/admin/system', icon: '⚙' }] : []),
      ],
    },
    {
      category: 'Services',
      items: [
        { key: 'messages', label: 'Messagerie', path: '/admin/messages', icon: '✉' },
        { key: 'support', label: 'Support', path: '/admin/support', icon: '☏' },
        { key: 'audit', label: "Journal d'activité", path: '/admin/audit', icon: '▦' },
        { key: 'discord', label: 'Discord Newman Bank', path: DISCORD_INVITE_URL, icon: '💬', external: true },
      ],
    },
  ].filter((s) => !s.category || s.items.length > 0);

  const footerItems = [{ key: 'settings', label: 'Paramètres', path: '/admin/settings', icon: '⚙' }];

  return renderShell(app, profile, 'Espace Admin', sections, activeKey, { footerItems });
}

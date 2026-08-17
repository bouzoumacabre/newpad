// ============================================================================
// NEWPAD — Coquille de l'interface IRS (lecture seule)
// ============================================================================

import { renderShell } from '../../lib/shell.js';
import { getFeatureFlags } from '../../lib/features.js';

export async function renderIrsShell(app, profile, activeKey) {
  let flags = {};
  try {
    flags = await getFeatureFlags('irs', 'irs');
  } catch (_) { /* en cas d'échec réseau, on affiche tout par défaut ci-dessous */ }

  const has = (key) => (key in flags ? flags[key] : true);

  const sections = [
    { key: 'dashboard', label: 'Tableau de bord', path: '/irs', icon: '◆' },
    {
      category: 'Registres (lecture seule)',
      items: [
        ...(has('irs.clients.view') ? [{ key: 'clients', label: 'Clients', path: '/irs/clients', icon: '⌕' }] : []),
        ...(has('irs.accounts.view') ? [{ key: 'accounts', label: 'Comptes', path: '/irs/accounts', icon: '▣' }] : []),
        ...(has('irs.transactions.view') ? [{ key: 'transactions', label: 'Transactions', path: '/irs/transactions', icon: '⇄' }] : []),
        ...(has('irs.gold.view') ? [{ key: 'gold', label: 'Lingots d\'or', path: '/irs/gold', icon: '●' }] : []),
      ],
    },
  ].filter((s) => !s.category || s.items.length > 0);

  const footerItems = [{ key: 'settings', label: 'Paramètres', path: '/irs/settings', icon: '⚙' }];

  return renderShell(app, profile, 'Espace IRS', sections, activeKey, {
    footerItems,
    banner: '⚠ Accès en lecture seule — Hurricane FA. Aucune action de modification n\'est possible depuis cette interface.',
  });
}

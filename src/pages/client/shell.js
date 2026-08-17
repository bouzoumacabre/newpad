// ============================================================================
// NEWPAD — Coquille de l'interface Client (menu catégorisé, filtré par les
// fonctionnalités réellement activées pour ce client — registre générique +
// permissions par compte, voir getClientFeatures()).
// ============================================================================

import { renderShell } from '../../lib/shell.js';
import { getFeatureFlags } from '../../lib/features.js';

export async function renderClientShell(app, profile, activeKey) {
  let flags = {};
  try {
    flags = await getFeatureFlags('client', 'client');
  } catch (_) { /* en cas d'échec réseau, on affiche tout par défaut ci-dessous */ }

  const has = (key) => (key in flags ? flags[key] : true);

  const sections = [
    { key: 'dashboard', label: 'Tableau de bord', path: '/client', icon: '◆' },
    {
      category: 'Comptes & Virements',
      items: [
        { key: 'accounts', label: 'Mes comptes', path: '/client/accounts', icon: '▤' },
        ...(has('client.transfers.create') ? [{ key: 'transfers', label: 'Virements', path: '/client/transfers', icon: '⇄' }] : []),
        { key: 'beneficiaries', label: 'Bénéficiaires', path: '/client/beneficiaries', icon: '☺' },
      ],
    },
    {
      category: 'Patrimoine',
      items: [
        ...(has('client.gold.buy_bank') ? [{ key: 'gold', label: "Lingots d'or", path: '/client/gold', icon: '●' }] : []),
        ...(has('client.gold.market') ? [{ key: 'gold-market', label: 'Marché de revente', path: '/client/gold/market', icon: '⇌' }] : []),
        ...(has('client.safes.request') ? [{ key: 'safes', label: 'Coffres-forts', path: '/client/safes', icon: '▣' }] : []),
      ],
    },
    ...(has('client.loans.request')
      ? [
          {
            category: 'Financement',
            items: [{ key: 'loans', label: 'Prêts professionnels', path: '/client/loans', icon: '§' }],
          },
        ]
      : []),
    {
      category: 'Services',
      items: [
        ...(has('client.consulting') ? [{ key: 'consulting', label: 'Consulting Premium', path: '/client/consulting', icon: '★' }] : []),
        { key: 'documents', label: 'Documents', path: '/client/documents', icon: '▦' },
        { key: 'support', label: 'Support', path: '/client/support', icon: '✉' },
      ],
    },
  ].filter((s) => !s.category || s.items.length > 0);

  const footerItems = [{ key: 'settings', label: 'Paramètres', path: '/client/settings', icon: '⚙' }];

  return renderShell(app, profile, 'Espace Client', sections, activeKey, { footerItems });
}

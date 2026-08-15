import './styles/base.css';
import { route, setNotFound, initRouter, navigate } from './lib/router.js';
import { renderPublicHome } from './pages/public/home.js';
import { renderLogin } from './pages/auth/login.js';
import { renderSignup } from './pages/auth/signup.js';
import { getCurrentProfile, supabase } from './lib/supabaseClient.js';
import { renderRoleShellPlaceholder } from './pages/shell-placeholder.js';
import { renderMembershipRequest } from './pages/client/membership-request.js';
import { renderClientDashboard } from './pages/client/dashboard.js';
import { renderClientAccounts } from './pages/client/accounts.js';
import { renderClientTransfers } from './pages/client/transfers.js';
import { renderClientBeneficiaries } from './pages/client/beneficiaries.js';
import { renderClientGold } from './pages/client/gold.js';
import { renderClientGoldMarket } from './pages/client/gold-market.js';
import { renderClientSafes } from './pages/client/safes.js';
import { renderClientLoans } from './pages/client/loans.js';
import { renderClientConsulting } from './pages/client/consulting.js';
import { renderClientDocuments } from './pages/client/documents.js';
import { renderClientSupport } from './pages/client/support.js';
import { renderClientSettings } from './pages/client/settings.js';

const app = document.getElementById('app');

async function guardedRoleRender(expectedRole, renderFn) {
  const profile = await getCurrentProfile().catch(() => null);
  if (!profile) { navigate('/login'); return; }
  if (profile.role !== expectedRole) { navigate('/' + profile.role); return; }
  await renderFn(profile);
}

route('/', async () => renderPublicHome(app));
route('/login', async () => renderLogin(app));
route('/signup', async () => renderSignup(app));

// Prospect — en attente de validation de sa demande d'adhésion (comble
// l'absence antérieure de route pour ce rôle, qui provoquait une boucle de
// redirection vers l'accueil après inscription).
route('/prospect', async () => guardedRoleRender('prospect', (p) => renderMembershipRequest(app, p)));

// ----------------------------------------------------------------------------
// CLIENT — interface complète (phase 3)
// ----------------------------------------------------------------------------
route('/client', async () => guardedRoleRender('client', (p) => renderClientDashboard(app, p)));
route('/client/accounts', async () => guardedRoleRender('client', (p) => renderClientAccounts(app, p)));
route('/client/accounts/:id', async (params) => guardedRoleRender('client', (p) => renderClientAccounts(app, p, params)));
route('/client/transfers', async () => guardedRoleRender('client', (p) => renderClientTransfers(app, p)));
route('/client/beneficiaries', async () => guardedRoleRender('client', (p) => renderClientBeneficiaries(app, p)));
route('/client/gold', async () => guardedRoleRender('client', (p) => renderClientGold(app, p)));
route('/client/gold/market', async () => guardedRoleRender('client', (p) => renderClientGoldMarket(app, p)));
route('/client/safes', async () => guardedRoleRender('client', (p) => renderClientSafes(app, p)));
route('/client/loans', async () => guardedRoleRender('client', (p) => renderClientLoans(app, p)));
route('/client/consulting', async () => guardedRoleRender('client', (p) => renderClientConsulting(app, p)));
route('/client/documents', async () => guardedRoleRender('client', (p) => renderClientDocuments(app, p)));
route('/client/support', async () => guardedRoleRender('client', (p) => renderClientSupport(app, p)));
route('/client/support/:id', async (params) => guardedRoleRender('client', (p) => renderClientSupport(app, p, params)));
route('/client/settings', async () => guardedRoleRender('client', (p) => renderClientSettings(app, p)));

// Placeholders — construits en détail dans les phases 4 à 6. La structure de
// routing + garde d'accès par rôle est déjà en place et fonctionnelle.
route('/employee', async () => guardedRoleRender('employee', (p) => renderRoleShellPlaceholder(app, p, 'Employé')));
route('/admin', async () => guardedRoleRender('admin', (p) => renderRoleShellPlaceholder(app, p, 'Admin')));
route('/irs', async () => guardedRoleRender('irs', (p) => renderRoleShellPlaceholder(app, p, 'IRS')));

setNotFound(async () => { navigate('/'); });

initRouter();

// Redirection automatique après connexion selon le rôle du profil.
supabase.auth.onAuthStateChange(async (event) => {
  if (event === 'SIGNED_IN') {
    const profile = await getCurrentProfile().catch(() => null);
    if (profile) navigate('/' + profile.role);
  }
  if (event === 'SIGNED_OUT') {
    navigate('/login');
  }
});

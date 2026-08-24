import './styles/base.css';
import { route, setNotFound, initRouter, navigate } from './lib/router.js';
import { renderPublicHome } from './pages/public/home.js';
import { renderLogin } from './pages/auth/login.js';
import { renderSignup } from './pages/auth/signup.js';
import { renderForgotPassword } from './pages/auth/forgot-password.js';
import { getCurrentProfile, supabase } from './lib/supabaseClient.js';
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
import { renderClientMessages } from './pages/client/messages.js';
import { renderClientSettings } from './pages/client/settings.js';
import { renderEmployeeDashboard } from './pages/employee/dashboard.js';
import { renderEmployeeClients } from './pages/employee/clients.js';
import { renderEmployeeMembership } from './pages/employee/membership.js';
import { renderEmployeeAccountOpening } from './pages/employee/account-opening.js';
import { renderEmployeeBranchQueue } from './pages/employee/branch-queue.js';
import { renderEmployeeTransfers } from './pages/employee/transfers.js';
import { renderEmployeeGold } from './pages/employee/gold.js';
import { renderEmployeeTransactions } from './pages/employee/transactions.js';
import { renderEmployeeSafes } from './pages/employee/safes.js';
import { renderEmployeeLoans } from './pages/employee/loans.js';
import { renderEmployeeConsulting } from './pages/employee/consulting.js';
import { renderEmployeeCashier } from './pages/employee/cashier.js';
import { renderEmployeeFraud } from './pages/employee/fraud.js';
import { renderEmployeeSupport } from './pages/employee/support.js';
import { renderEmployeeMessages } from './pages/employee/messages.js';
import { renderEmployeeAudit } from './pages/employee/audit.js';
import { renderEmployeeSettings } from './pages/employee/settings.js';
import { renderAdminDashboard } from './pages/admin/dashboard.js';
import { renderAdminClients } from './pages/admin/clients.js';
import { renderAdminMembership } from './pages/admin/membership.js';
import { renderAdminAccountOpening } from './pages/admin/account-opening.js';
import { renderAdminBranchQueue } from './pages/admin/branch-queue.js';
import { renderAdminTransfers } from './pages/admin/transfers.js';
import { renderAdminGold } from './pages/admin/gold.js';
import { renderAdminTransactions } from './pages/admin/transactions.js';
import { renderAdminSafes } from './pages/admin/safes.js';
import { renderAdminLoans } from './pages/admin/loans.js';
import { renderAdminConsulting } from './pages/admin/consulting.js';
import { renderAdminCashier } from './pages/admin/cashier.js';
import { renderAdminFraud } from './pages/admin/fraud.js';
import { renderAdminSupport } from './pages/admin/support.js';
import { renderAdminMessages } from './pages/admin/messages.js';
import { renderAdminAudit } from './pages/admin/audit.js';
import { renderAdminSettings } from './pages/admin/settings.js';
import { renderAdminStaff } from './pages/admin/staff.js';
import { renderAdminPermissions } from './pages/admin/permissions.js';
import { renderAdminIrsAccounts } from './pages/admin/irs-accounts.js';
import { renderAdminVisibility } from './pages/admin/visibility.js';
import { renderAdminEconomicSettings } from './pages/admin/economic-settings.js';
import { renderAdminCms } from './pages/admin/cms.js';
import { renderAdminSystem } from './pages/admin/system.js';
import { renderIrsDashboard } from './pages/irs/dashboard.js';
import { renderIrsClients } from './pages/irs/clients.js';
import { renderIrsAccounts } from './pages/irs/accounts.js';
import { renderIrsTransactions } from './pages/irs/transactions.js';
import { renderIrsGold } from './pages/irs/gold.js';
import { renderIrsMessages } from './pages/irs/messages.js';
import { renderIrsSettings } from './pages/irs/settings.js';

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
route('/forgot-password', async () => renderForgotPassword(app));

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
route('/client/messages', async () => guardedRoleRender('client', (p) => renderClientMessages(app, p)));
route('/client/messages/:id', async (params) => guardedRoleRender('client', (p) => renderClientMessages(app, p, params)));
route('/client/settings', async () => guardedRoleRender('client', (p) => renderClientSettings(app, p)));

// ----------------------------------------------------------------------------
// EMPLOYÉ — interface complète (phase 4)
// ----------------------------------------------------------------------------
route('/employee', async () => guardedRoleRender('employee', (p) => renderEmployeeDashboard(app, p)));
route('/employee/clients', async () => guardedRoleRender('employee', (p) => renderEmployeeClients(app, p)));
route('/employee/clients/:id', async (params) => guardedRoleRender('employee', (p) => renderEmployeeClients(app, p, params)));
route('/employee/membership', async () => guardedRoleRender('employee', (p) => renderEmployeeMembership(app, p)));
route('/employee/account-opening', async () => guardedRoleRender('employee', (p) => renderEmployeeAccountOpening(app, p)));
route('/employee/branch-queue', async () => guardedRoleRender('employee', (p) => renderEmployeeBranchQueue(app, p)));
route('/employee/transfers', async () => guardedRoleRender('employee', (p) => renderEmployeeTransfers(app, p)));
route('/employee/gold', async () => guardedRoleRender('employee', (p) => renderEmployeeGold(app, p)));
route('/employee/transactions', async () => guardedRoleRender('employee', (p) => renderEmployeeTransactions(app, p)));
route('/employee/safes', async () => guardedRoleRender('employee', (p) => renderEmployeeSafes(app, p)));
route('/employee/loans', async () => guardedRoleRender('employee', (p) => renderEmployeeLoans(app, p)));
route('/employee/consulting', async () => guardedRoleRender('employee', (p) => renderEmployeeConsulting(app, p)));
route('/employee/cashier', async () => guardedRoleRender('employee', (p) => renderEmployeeCashier(app, p)));
route('/employee/fraud', async () => guardedRoleRender('employee', (p) => renderEmployeeFraud(app, p)));
route('/employee/support', async () => guardedRoleRender('employee', (p) => renderEmployeeSupport(app, p)));
route('/employee/support/:id', async (params) => guardedRoleRender('employee', (p) => renderEmployeeSupport(app, p, params)));
route('/employee/messages', async () => guardedRoleRender('employee', (p) => renderEmployeeMessages(app, p)));
route('/employee/messages/:id', async (params) => guardedRoleRender('employee', (p) => renderEmployeeMessages(app, p, params)));
route('/employee/audit', async () => guardedRoleRender('employee', (p) => renderEmployeeAudit(app, p)));
route('/employee/settings', async () => guardedRoleRender('employee', (p) => renderEmployeeSettings(app, p)));

// ----------------------------------------------------------------------------
// ADMIN — interface complète (phase 5)
// ----------------------------------------------------------------------------
route('/admin', async () => guardedRoleRender('admin', (p) => renderAdminDashboard(app, p)));
route('/admin/clients', async () => guardedRoleRender('admin', (p) => renderAdminClients(app, p)));
route('/admin/clients/:id', async (params) => guardedRoleRender('admin', (p) => renderAdminClients(app, p, params)));
route('/admin/membership', async () => guardedRoleRender('admin', (p) => renderAdminMembership(app, p)));
route('/admin/account-opening', async () => guardedRoleRender('admin', (p) => renderAdminAccountOpening(app, p)));
route('/admin/branch-queue', async () => guardedRoleRender('admin', (p) => renderAdminBranchQueue(app, p)));
route('/admin/transfers', async () => guardedRoleRender('admin', (p) => renderAdminTransfers(app, p)));
route('/admin/gold', async () => guardedRoleRender('admin', (p) => renderAdminGold(app, p)));
route('/admin/transactions', async () => guardedRoleRender('admin', (p) => renderAdminTransactions(app, p)));
route('/admin/safes', async () => guardedRoleRender('admin', (p) => renderAdminSafes(app, p)));
route('/admin/loans', async () => guardedRoleRender('admin', (p) => renderAdminLoans(app, p)));
route('/admin/consulting', async () => guardedRoleRender('admin', (p) => renderAdminConsulting(app, p)));
route('/admin/cashier', async () => guardedRoleRender('admin', (p) => renderAdminCashier(app, p)));
route('/admin/fraud', async () => guardedRoleRender('admin', (p) => renderAdminFraud(app, p)));
route('/admin/support', async () => guardedRoleRender('admin', (p) => renderAdminSupport(app, p)));
route('/admin/support/:id', async (params) => guardedRoleRender('admin', (p) => renderAdminSupport(app, p, params)));
route('/admin/messages', async () => guardedRoleRender('admin', (p) => renderAdminMessages(app, p)));
route('/admin/messages/:id', async (params) => guardedRoleRender('admin', (p) => renderAdminMessages(app, p, params)));
route('/admin/audit', async () => guardedRoleRender('admin', (p) => renderAdminAudit(app, p)));
route('/admin/settings', async () => guardedRoleRender('admin', (p) => renderAdminSettings(app, p)));
route('/admin/staff', async () => guardedRoleRender('admin', (p) => renderAdminStaff(app, p)));
route('/admin/permissions', async () => guardedRoleRender('admin', (p) => renderAdminPermissions(app, p)));
route('/admin/irs-accounts', async () => guardedRoleRender('admin', (p) => renderAdminIrsAccounts(app, p)));
route('/admin/visibility', async () => guardedRoleRender('admin', (p) => renderAdminVisibility(app, p)));
route('/admin/economic-settings', async () => guardedRoleRender('admin', (p) => renderAdminEconomicSettings(app, p)));
route('/admin/cms', async () => guardedRoleRender('admin', (p) => renderAdminCms(app, p)));
route('/admin/system', async () => guardedRoleRender('admin', (p) => renderAdminSystem(app, p)));

// Placeholder — construit en détail dans la phase 6. La structure de routing +
// garde d'accès par rôle est déjà en place et fonctionnelle.
// ----------------------------------------------------------------------------
// IRS — interface complète, strictement lecture seule (phase 6)
// ----------------------------------------------------------------------------
route('/irs', async () => guardedRoleRender('irs', (p) => renderIrsDashboard(app, p)));
route('/irs/clients', async () => guardedRoleRender('irs', (p) => renderIrsClients(app, p)));
route('/irs/accounts', async () => guardedRoleRender('irs', (p) => renderIrsAccounts(app, p)));
route('/irs/transactions', async () => guardedRoleRender('irs', (p) => renderIrsTransactions(app, p)));
route('/irs/gold', async () => guardedRoleRender('irs', (p) => renderIrsGold(app, p)));
route('/irs/messages', async () => guardedRoleRender('irs', (p) => renderIrsMessages(app, p)));
route('/irs/messages/:id', async (params) => guardedRoleRender('irs', (p) => renderIrsMessages(app, p, params)));
route('/irs/settings', async () => guardedRoleRender('irs', (p) => renderIrsSettings(app, p)));

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

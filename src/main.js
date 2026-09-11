import './styles/base.css';
import './styles/newpad.css';
import './styles/apps.css';
import { route, setNotFound, initRouter, navigate, resolve } from './lib/router.js';
import { renderPublicHome } from './pages/public/home.js';
import { renderLogin } from './pages/auth/login.js';
import { renderSignup } from './pages/auth/signup.js';
import { renderForgotPassword } from './pages/auth/forgot-password.js';
import { getCurrentProfile, supabase } from './lib/supabaseClient.js';
// ----------------------------------------------------------------------------
// Chargement à la demande des écrans internes
// ----------------------------------------------------------------------------
// Sans cela, un joueur qui ouvre sa tablette télécharge aussi la fiche client
// de l'employé, le pilotage économique de l'admin et les registres de l'IRS —
// des écrans qu'il ne verra jamais et que la base lui refuserait de toute
// façon. Chaque interface est un module séparé, chargé au premier écran de
// cette interface. C'est d'autant plus déterminant ici que les 22 applications
// Newpad à venir viendront s'ajouter au même paquet.
const renderMembershipRequest = (...a) => import('./pages/client/membership-request.js').then((m) => m.renderMembershipRequest(...a));
const renderClientDashboard = (...a) => import('./pages/client/dashboard.js').then((m) => m.renderClientDashboard(...a));
const renderClientAccounts = (...a) => import('./pages/client/accounts.js').then((m) => m.renderClientAccounts(...a));
const renderClientTransfers = (...a) => import('./pages/client/transfers.js').then((m) => m.renderClientTransfers(...a));
const renderClientBeneficiaries = (...a) => import('./pages/client/beneficiaries.js').then((m) => m.renderClientBeneficiaries(...a));
const renderClientGold = (...a) => import('./pages/client/gold.js').then((m) => m.renderClientGold(...a));
const renderClientGoldMarket = (...a) => import('./pages/client/gold-market.js').then((m) => m.renderClientGoldMarket(...a));
const renderClientSafes = (...a) => import('./pages/client/safes.js').then((m) => m.renderClientSafes(...a));
const renderClientLoans = (...a) => import('./pages/client/loans.js').then((m) => m.renderClientLoans(...a));
const renderClientConsulting = (...a) => import('./pages/client/consulting.js').then((m) => m.renderClientConsulting(...a));
const renderClientDocuments = (...a) => import('./pages/client/documents.js').then((m) => m.renderClientDocuments(...a));
const renderClientInfo = (...a) => import('./pages/client/info.js').then((m) => m.renderClientInfo(...a));
const renderClientSupport = (...a) => import('./pages/client/support.js').then((m) => m.renderClientSupport(...a));
const renderClientMessages = (...a) => import('./pages/client/messages.js').then((m) => m.renderClientMessages(...a));
const renderClientTransactions = (...a) => import('./pages/client/transactions.js').then((m) => m.renderClientTransactions(...a));
const renderClientSettings = (...a) => import('./pages/client/settings.js').then((m) => m.renderClientSettings(...a));
const renderEmployeeDashboard = (...a) => import('./pages/employee/dashboard.js').then((m) => m.renderEmployeeDashboard(...a));
const renderEmployeeClients = (...a) => import('./pages/employee/clients.js').then((m) => m.renderEmployeeClients(...a));
const renderEmployeeMembership = (...a) => import('./pages/employee/membership.js').then((m) => m.renderEmployeeMembership(...a));
const renderEmployeeAccountOpening = (...a) => import('./pages/employee/account-opening.js').then((m) => m.renderEmployeeAccountOpening(...a));
const renderEmployeeBranchQueue = (...a) => import('./pages/employee/branch-queue.js').then((m) => m.renderEmployeeBranchQueue(...a));
const renderEmployeeTransfers = (...a) => import('./pages/employee/transfers.js').then((m) => m.renderEmployeeTransfers(...a));
const renderEmployeeGold = (...a) => import('./pages/employee/gold.js').then((m) => m.renderEmployeeGold(...a));
const renderEmployeeTransactions = (...a) => import('./pages/employee/transactions.js').then((m) => m.renderEmployeeTransactions(...a));
const renderEmployeeSafes = (...a) => import('./pages/employee/safes.js').then((m) => m.renderEmployeeSafes(...a));
const renderEmployeeLoans = (...a) => import('./pages/employee/loans.js').then((m) => m.renderEmployeeLoans(...a));
const renderEmployeeConsulting = (...a) => import('./pages/employee/consulting.js').then((m) => m.renderEmployeeConsulting(...a));
const renderEmployeeCashier = (...a) => import('./pages/employee/cashier.js').then((m) => m.renderEmployeeCashier(...a));
const renderEmployeeFraud = (...a) => import('./pages/employee/fraud.js').then((m) => m.renderEmployeeFraud(...a));
const renderEmployeeSupport = (...a) => import('./pages/employee/support.js').then((m) => m.renderEmployeeSupport(...a));
const renderEmployeeMessages = (...a) => import('./pages/employee/messages.js').then((m) => m.renderEmployeeMessages(...a));
const renderEmployeeAudit = (...a) => import('./pages/employee/audit.js').then((m) => m.renderEmployeeAudit(...a));
const renderEmployeeDocuments = (...a) => import('./pages/employee/documents.js').then((m) => m.renderEmployeeDocuments(...a));
const renderEmployeeSettings = (...a) => import('./pages/employee/settings.js').then((m) => m.renderEmployeeSettings(...a));
const renderAdminDashboard = (...a) => import('./pages/admin/dashboard.js').then((m) => m.renderAdminDashboard(...a));
const renderAdminClients = (...a) => import('./pages/admin/clients.js').then((m) => m.renderAdminClients(...a));
const renderAdminMembership = (...a) => import('./pages/admin/membership.js').then((m) => m.renderAdminMembership(...a));
const renderAdminAccountOpening = (...a) => import('./pages/admin/account-opening.js').then((m) => m.renderAdminAccountOpening(...a));
const renderAdminBranchQueue = (...a) => import('./pages/admin/branch-queue.js').then((m) => m.renderAdminBranchQueue(...a));
const renderAdminTransfers = (...a) => import('./pages/admin/transfers.js').then((m) => m.renderAdminTransfers(...a));
const renderAdminGold = (...a) => import('./pages/admin/gold.js').then((m) => m.renderAdminGold(...a));
const renderAdminTransactions = (...a) => import('./pages/admin/transactions.js').then((m) => m.renderAdminTransactions(...a));
const renderAdminSafes = (...a) => import('./pages/admin/safes.js').then((m) => m.renderAdminSafes(...a));
const renderAdminLoans = (...a) => import('./pages/admin/loans.js').then((m) => m.renderAdminLoans(...a));
const renderAdminConsulting = (...a) => import('./pages/admin/consulting.js').then((m) => m.renderAdminConsulting(...a));
const renderAdminCashier = (...a) => import('./pages/admin/cashier.js').then((m) => m.renderAdminCashier(...a));
const renderAdminFraud = (...a) => import('./pages/admin/fraud.js').then((m) => m.renderAdminFraud(...a));
const renderAdminSupport = (...a) => import('./pages/admin/support.js').then((m) => m.renderAdminSupport(...a));
const renderAdminMessages = (...a) => import('./pages/admin/messages.js').then((m) => m.renderAdminMessages(...a));
const renderAdminAudit = (...a) => import('./pages/admin/audit.js').then((m) => m.renderAdminAudit(...a));
const renderAdminDocuments = (...a) => import('./pages/admin/documents.js').then((m) => m.renderAdminDocuments(...a));
const renderAdminSettings = (...a) => import('./pages/admin/settings.js').then((m) => m.renderAdminSettings(...a));
const renderAdminStaff = (...a) => import('./pages/admin/staff.js').then((m) => m.renderAdminStaff(...a));
const renderAdminPermissions = (...a) => import('./pages/admin/permissions.js').then((m) => m.renderAdminPermissions(...a));
const renderAdminIrsAccounts = (...a) => import('./pages/admin/irs-accounts.js').then((m) => m.renderAdminIrsAccounts(...a));
const renderAdminVisibility = (...a) => import('./pages/admin/visibility.js').then((m) => m.renderAdminVisibility(...a));
const renderAdminEconomicSettings = (...a) => import('./pages/admin/economic-settings.js').then((m) => m.renderAdminEconomicSettings(...a));
const renderAdminTreasury = (...a) => import('./pages/admin/treasury.js').then((m) => m.renderAdminTreasury(...a));
const renderAdminCms = (...a) => import('./pages/admin/cms.js').then((m) => m.renderAdminCms(...a));
const renderAdminSystem = (...a) => import('./pages/admin/system.js').then((m) => m.renderAdminSystem(...a));
const renderIrsDashboard = (...a) => import('./pages/irs/dashboard.js').then((m) => m.renderIrsDashboard(...a));
const renderIrsClients = (...a) => import('./pages/irs/clients.js').then((m) => m.renderIrsClients(...a));
const renderIrsAccounts = (...a) => import('./pages/irs/accounts.js').then((m) => m.renderIrsAccounts(...a));
const renderIrsTransactions = (...a) => import('./pages/irs/transactions.js').then((m) => m.renderIrsTransactions(...a));
const renderIrsGold = (...a) => import('./pages/irs/gold.js').then((m) => m.renderIrsGold(...a));
const renderIrsMessages = (...a) => import('./pages/irs/messages.js').then((m) => m.renderIrsMessages(...a));
const renderIrsSettings = (...a) => import('./pages/irs/settings.js').then((m) => m.renderIrsSettings(...a));
import { swallow, clearLoadFailures } from './lib/loadState.js';
import { resetNotificationsSubscription } from './lib/notifications.js';
import { renderLauncher } from './pages/newpad/launcher.js';
import { renderLockScreen } from './pages/newpad/lockScreen.js';
import { renderLanding } from './pages/newpad/landing.js';
import { estInvite, quitterLeModeInvite } from './lib/guestMode.js';
import { canOpenApp, findAppBySlug } from './lib/newpadApi.js';
import { renderTabletShell } from './pages/newpad/tabletShell.js';
import { renderAppPlaceholder } from './pages/newpad/appPlaceholder.js';
import { enterBank } from './pages/newpad/bankEntry.js';
const renderNewpadApps = (...a) => import('./pages/newpad/admin/apps.js').then((m) => m.renderNewpadApps(...a));
const renderNewpadConsole = (...a) => import('./pages/newpad/admin/console.js').then((m) => m.renderNewpadConsole(...a));
const renderFilesApp = (...a) => import('./apps/files/index.js').then((m) => m.renderFilesApp(...a));
const renderMailApp = (...a) => import('./apps/mail/index.js').then((m) => m.renderMailApp(...a));
const renderLockedApp = (...a) => import('./pages/newpad/lockedApp.js').then((m) => m.renderLockedApp(...a));
import { findAppByRoute } from './lib/newpadApi.js';

const app = document.getElementById('app');

// Écran opposé à un profil suspendu ou gelé.
// Jusqu'ici, le garde ne testait que le rôle : un compte suspendu par l'admin
// se connectait et naviguait normalement dans toute son interface. Le blocage
// réel est posé en base (déclencheur, migration 0022) ; cet écran évite que
// l'utilisateur découvre son état par un message d'erreur au moment de valider
// une opération, et lui indique quoi faire.
function renderBlockedProfile(profile) {
  const gelé = profile.status === 'frozen';
  // Même un compte bloqué reste dans la tablette : c'est son appareil, pas une
  // page d'erreur d'un site tiers.
  const { body } = renderTabletShell(app, null, { scroll: true, footerLeft: gelé ? 'Compte gelé' : 'Compte suspendu' });
  body.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card card" style="max-width:460px; text-align:center;">
        <h2 style="margin-bottom:12px;">${gelé ? 'Compte gelé' : 'Compte suspendu'}</h2>
        <p class="muted" style="margin-bottom:20px;">
          Votre accès à Newman Bank est temporairement ${gelé ? 'gelé' : 'suspendu'}.
          Aucune opération ne peut être effectuée pour le moment.
          Vos avoirs restent intacts.
        </p>
        <p class="muted" style="margin-bottom:24px; font-size:13px;">
          Pour comprendre la raison de cette mesure et la faire lever,
          contactez la banque sur le Discord Newman Bank.
        </p>
        <button id="blocked-logout" class="btn btn-secondary" style="width:100%;">Se déconnecter</button>
      </div>
    </div>
    <style>
      .auth-screen { min-height:100%; display:flex; align-items:center; justify-content:center; padding:24px; }
      .auth-card { width:100%; }
    </style>
  `;
  document.getElementById('blocked-logout')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    navigate('/login');
  });
}

async function guardedRoleRender(expectedRole, renderFn) {
  const profile = await getCurrentProfile().catch(swallow('getCurrentProfile', null));
  if (!profile) { navigate('/login'); return; }
  if (profile.status && profile.status !== 'active') { renderBlockedProfile(profile); return; }
  if (profile.role !== expectedRole) { navigate('/' + profile.role); return; }
  await renderFn(profile);
}

// ----------------------------------------------------------------------------
// NEWPAD — la tablette
// ----------------------------------------------------------------------------
// Contrairement à `guardedRoleRender`, ce garde ne réclame aucun rôle
// particulier : la tablette est commune à tout le monde. Elle exige seulement
// une session, parce que le registre d'applications n'est lisible que connecté.
// Enveloppe un écran existant dans le châssis Newpad. Sans cela, l'inscription,
// la connexion ou la vitrine de la banque s'affichaient bien à l'intérieur du
// cadre, mais SANS l'en-tête ni le pied de la tablette : le joueur avait
// l'impression de basculer sur un autre site au milieu de l'objet. Les écrans
// eux-mêmes ne sont pas réécrits — on leur donne simplement pour conteneur le
// corps de la tablette au lieu de la page entière.
async function dansLaTablette(renderFn, opts = {}) {
  const profile = opts.avecProfil
    ? await getCurrentProfile().catch(swallow('getCurrentProfile', null))
    : null;
  const { body } = renderTabletShell(app, profile, {
    scroll: true,
    showHome: opts.showHome !== false,
    footerLeft: opts.footerLeft,
  });
  await renderFn(body, profile);
}

// Garde d'entrée dans une application. La question « ai-je le droit ? » est
// posée à la BASE, pas au code : le calcul fait dans le lanceur ne sert qu'à
// dessiner un cadenas, et taper une adresse à la main contourne l'affichage.
async function guardedAppRender(slug, renderFn) {
  const profile = await getCurrentProfile().catch(swallow('getCurrentProfile', null));
  if (profile && profile.status && profile.status !== 'active') { renderBlockedProfile(profile); return; }
  const autorise = await canOpenApp(slug).catch(() => false);
  if (!autorise) {
    const cible = await findAppBySlug(slug).catch(() => null);
    if (cible) { await renderLockedApp(app, profile, cible); return; }
    navigate('/');
    return;
  }
  await renderFn(profile);
}

async function guardedNewpadRender(renderFn) {
  const profile = await getCurrentProfile().catch(swallow('getCurrentProfile', null));
  if (!profile) { navigate('/login'); return; }
  if (profile.status && profile.status !== 'active') { renderBlockedProfile(profile); return; }
  await renderFn(profile);
}

// La racine est l'unique URL que FiveM connaît (§1) : elle montre TOUJOURS la
// tablette. Connecté, l'écran d'accueil et ses applications ; déconnecté, la
// même tablette verrouillée, avec le formulaire d'identification. La vitrine
// publique de Newman Bank reste accessible depuis cet écran (#/bank/home) —
// c'est une application de Newpad, pas sa porte d'entrée.
route('/', async () => {
  const profile = await getCurrentProfile().catch(swallow('getCurrentProfile', null));
  if (profile) {
    // Une session ouverte l'emporte toujours sur un drapeau invité resté posé.
    quitterLeModeInvite();
    if (profile.status && profile.status !== 'active') { renderBlockedProfile(profile); return; }
    await renderLauncher(app, profile);
    return;
  }
  // Sans compte : la présentation d'abord, la tablette ensuite si le visiteur a
  // choisi d'entrer en invité.
  if (estInvite()) { await renderLauncher(app, null); return; }
  await renderLanding(app);
});

// Écran d'une application que l'on n'a pas le droit d'ouvrir. Il est atteint
// depuis le lanceur, mais aussi par le garde ci-dessous : taper l'adresse à la
// main mène au même endroit, pas à un refus muet.
route('/acces/:slug', async (params) => {
  const profile = await getCurrentProfile().catch(swallow('getCurrentProfile', null));
  const cible = await findAppBySlug(params.slug).catch(() => null);
  if (!cible) { navigate('/'); return; }
  await renderLockedApp(app, profile, cible);
});

route('/bank', async () => guardedNewpadRender((p) => enterBank(p)));
route('/bank/home', async () => dansLaTablette((c) => renderPublicHome(c), { avecProfil: true, footerLeft: 'Newman Bank' }));
// ----------------------------------------------------------------------------
// Applications Newpad
// ----------------------------------------------------------------------------
route('/files', async () => guardedAppRender('files', (p) => renderFilesApp(app, p)));
route('/mail', async () => guardedAppRender('mail', (p) => renderMailApp(app, p)));

route('/newpad/admin', async () => guardedNewpadRender((p) => renderNewpadConsole(app, p)));
route('/newpad/apps', async () => guardedNewpadRender((p) => renderNewpadApps(app, p)));
route('/login', async () => dansLaTablette((c) => renderLogin(c), { footerLeft: 'Connexion' }));
route('/signup', async () => dansLaTablette((c) => renderSignup(c), { footerLeft: 'Inscription' }));
route('/forgot-password', async () => dansLaTablette((c) => renderForgotPassword(c), { footerLeft: 'Mot de passe oublié' }));

// Prospect — en attente de validation de sa demande d'adhésion (comble
// l'absence antérieure de route pour ce rôle, qui provoquait une boucle de
// redirection vers l'accueil après inscription).
route('/prospect', async () => guardedRoleRender('prospect', (p) => dansLaTablette((c) => renderMembershipRequest(c, p), { avecProfil: true, footerLeft: 'Demande d\'adhésion' })));

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
route('/client/info', async () => guardedRoleRender('client', (p) => renderClientInfo(app, p)));
route('/client/support', async () => guardedRoleRender('client', (p) => renderClientSupport(app, p)));
route('/client/support/:id', async (params) => guardedRoleRender('client', (p) => renderClientSupport(app, p, params)));
route('/client/transactions', async () => guardedRoleRender('client', (p) => renderClientTransactions(app, p)));
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
route('/employee/documents', async () => guardedRoleRender('employee', (p) => renderEmployeeDocuments(app, p)));
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
route('/admin/documents', async () => guardedRoleRender('admin', (p) => renderAdminDocuments(app, p)));
route('/admin/settings', async () => guardedRoleRender('admin', (p) => renderAdminSettings(app, p)));
route('/admin/staff', async () => guardedRoleRender('admin', (p) => renderAdminStaff(app, p)));
route('/admin/permissions', async () => guardedRoleRender('admin', (p) => renderAdminPermissions(app, p)));
route('/admin/irs-accounts', async () => guardedRoleRender('admin', (p) => renderAdminIrsAccounts(app, p)));
route('/admin/visibility', async () => guardedRoleRender('admin', (p) => renderAdminVisibility(app, p)));
route('/admin/economic-settings', async () => guardedRoleRender('admin', (p) => renderAdminEconomicSettings(app, p)));
route('/admin/treasury', async () => guardedRoleRender('admin', (p) => renderAdminTreasury(app, p)));
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

// Les applications du registre ne peuvent pas être déclarées à l'avance : leurs
// routes vivent en base et l'admin peut en créer de nouvelles sans déploiement.
// On les résout donc ici, au moment où aucune route codée ne correspond — ce
// qui laisse intactes les 81 routes existantes, toujours prioritaires.
setNotFound(async () => {
  const chemin = (window.location.hash || '#/').slice(1).split('?')[0];
  try {
    const appEnregistree = await findAppByRoute(chemin);
    if (appEnregistree && appEnregistree.is_enabled) {
      await guardedAppRender(appEnregistree.slug, (p) => renderAppPlaceholder(app, p, appEnregistree));
      return;
    }
  } catch (_) { /* registre injoignable : on retombe sur l'accueil */ }
  navigate('/');
});

initRouter();

// Redirection automatique après connexion selon le rôle du profil.
supabase.auth.onAuthStateChange(async (event) => {
  if (event === 'SIGNED_IN') {
    // Après connexion, on ouvre la tablette, pas directement la banque :
    // Newpad est l'écosystème, Newman Bank n'en est qu'une application.
    //
    // Mais uniquement si l'on VIENT de s'identifier. Supabase émet aussi cet
    // événement au démarrage, quand il restaure une session depuis le stockage
    // local : rediriger sans condition écrasait alors la route demandée, et
    // ouvrir Newpad sur une application précise — un lien de notification, par
    // exemple — renvoyait systématiquement à l'écran d'accueil une fraction de
    // seconde plus tard. Constaté en test : #/files affichait l'accueil.
    const chemin = (window.location.hash || '#/').slice(1).split('?')[0];
    const ecransIdentification = ['/', '/login', '/signup', '/forgot-password'];
    if (!ecransIdentification.includes(chemin)) return;

    const profile = await getCurrentProfile().catch(swallow('getCurrentProfile', null));
    if (!profile) return;
    const cible = profile.status && profile.status !== 'active' ? '/' + profile.role : '/';
    // Déjà sur la cible (cas de l'écran verrouillé) : changer le hash ne
    // déclencherait aucun rendu, il faut redemander explicitement la route.
    if (chemin === cible) await resolve();
    else navigate(cible);
  }
  if (event === 'SIGNED_OUT') {
    // Sans cela, le canal Realtime de l'utilisateur précédent survit à sa
    // session et continue d'écouter ses notifications.
    resetNotificationsSubscription();
    clearLoadFailures();
    navigate('/login');
  }
});

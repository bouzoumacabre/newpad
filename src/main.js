import './styles/base.css';
import { route, setNotFound, initRouter, navigate } from './lib/router.js';
import { renderPublicHome } from './pages/public/home.js';
import { renderLogin } from './pages/auth/login.js';
import { renderSignup } from './pages/auth/signup.js';
import { getCurrentProfile, supabase } from './lib/supabaseClient.js';
import { renderRoleShellPlaceholder } from './pages/shell-placeholder.js';

const app = document.getElementById('app');

async function guardedRoleRender(expectedRole, renderFn) {
  const profile = await getCurrentProfile().catch(() => null);
  if (!profile) { navigate('/login'); return; }
  if (profile.role !== expectedRole) { navigate('/'); return; }
  await renderFn(profile);
}

route('/', async () => renderPublicHome(app));
route('/login', async () => renderLogin(app));
route('/signup', async () => renderSignup(app));

// Placeholders — construits en détail dans les phases 3 à 6. La structure de
// routing + garde d'accès par rôle est déjà en place et fonctionnelle.
route('/client', async () => guardedRoleRender('client', (p) => renderRoleShellPlaceholder(app, p, 'Client')));
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

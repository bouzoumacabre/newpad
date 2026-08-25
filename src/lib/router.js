// Routeur minimal basé sur le hash (#/...) — robuste sur GitHub Pages et dans
// le navigateur intégré FiveM (pas besoin de configuration serveur pour les
// rewrites d'URL profondes).

const routes = [];
let notFoundHandler = () => { document.getElementById('app').innerHTML = '<p>Page introuvable.</p>'; };

export function route(pattern, handler) {
  // pattern ex: '/client/accounts/:id'
  const paramNames = [];
  const regex = new RegExp(
    '^' + pattern.replace(/:[a-zA-Z]+/g, (m) => { paramNames.push(m.slice(1)); return '([^/]+)'; }) + '$'
  );
  routes.push({ regex, paramNames, handler });
}

export function setNotFound(handler) { notFoundHandler = handler; }

function currentPath() {
  const hash = window.location.hash || '#/';
  return hash.slice(1) || '/';
}

function showRouteError(err) {
  console.error('[router] erreur non interceptée sur une route :', err);
  const app = document.getElementById('app');
  if (!app) return;
  app.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px;">
      <div class="card" style="max-width:420px; text-align:center;">
        <h2 style="margin-bottom:12px;">Une erreur est survenue</h2>
        <p class="muted" style="margin-bottom:20px;">L'écran n'a pas pu s'afficher correctement. Réessayez, ou revenez à l'accueil.</p>
        <button class="btn btn-primary" onclick="window.location.hash = '#/'; window.location.reload();">Retour à l'accueil</button>
      </div>
    </div>
  `;
}

export async function resolve() {
  const path = currentPath().split('?')[0];
  try {
    for (const r of routes) {
      const match = path.match(r.regex);
      if (match) {
        const params = {};
        r.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(match[i + 1]); });
        await r.handler(params);
        return;
      }
    }
    await notFoundHandler();
  } catch (err) {
    showRouteError(err);
  }
}

export function navigate(path) {
  window.location.hash = '#' + path;
}

export function initRouter() {
  window.addEventListener('hashchange', resolve);
  window.addEventListener('DOMContentLoaded', resolve);
  window.addEventListener('unhandledrejection', (event) => {
    console.error('[router] promesse rejetée non interceptée :', event.reason);
  });
  if (document.readyState !== 'loading') resolve();
}

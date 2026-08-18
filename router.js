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

export async function resolve() {
  const path = currentPath().split('?')[0];
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
}

export function navigate(path) {
  window.location.hash = '#' + path;
}

export function initRouter() {
  window.addEventListener('hashchange', resolve);
  window.addEventListener('DOMContentLoaded', resolve);
  if (document.readyState !== 'loading') resolve();
}

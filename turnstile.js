// ============================================================================
// NEWPAD — Cloudflare Turnstile (CAPTCHA anti-spam / anti-DDoS)
// ============================================================================
// Seule la clé publique (Site Key) transite ici — elle est faite pour être
// visible côté client. La clé privée (Secret Key) ne touche jamais le
// frontend : elle est configurée uniquement côté tableau de bord Supabase
// (Authentication > Attack Protection), qui vérifie lui-même chaque jeton
// auprès de Cloudflare avant d'autoriser une inscription ou une connexion.
//
// Si VITE_TURNSTILE_SITE_KEY n'est pas renseignée (dev local, ou avant mise
// en place de Cloudflare), le widget ne s'affiche simplement pas et un jeton
// vide est envoyé — Supabase n'exige un jeton que si la protection est
// activée côté tableau de bord, donc ce mode dégradé ne bloque jamais rien
// tant que ce n'est pas configuré.

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;

let scriptPromise = null;

function loadScript() {
  if (window.turnstile) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Impossible de charger Cloudflare Turnstile'));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

// Affiche le widget dans l'élément #containerId et renvoie { getToken, reset }
// pour récupérer le jeton au moment de la soumission et réinitialiser le
// widget après un échec (un jeton Turnstile ne sert qu'une seule fois).
export async function renderTurnstile(containerId) {
  const noop = { getToken: () => null, reset: () => {} };
  if (!SITE_KEY) return noop;

  const el = document.getElementById(containerId);
  if (!el) return noop;

  try {
    await loadScript();
  } catch (_) {
    return noop; // Cloudflare injoignable — on n'empêche pas la connexion pour autant.
  }
  if (!window.turnstile) return noop;

  const widgetId = window.turnstile.render(el, { sitekey: SITE_KEY });
  return {
    getToken: () => window.turnstile.getResponse(widgetId),
    reset: () => window.turnstile.reset(widgetId),
  };
}

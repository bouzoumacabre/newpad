// ============================================================================
// NEWPAD — Copie de secours pour les liens externes (Discord...)
// ============================================================================
// Dans le navigateur intégré de FiveM (CEF/NUI), l'ouverture d'un nouvel
// onglet vers une URL externe (target="_blank") est silencieusement bloquée
// — le clic "ne fait rien" pour le joueur. Hors jeu (Chrome/Edge...), le lien
// s'ouvre normalement. On ne peut pas distinguer les deux environnements de
// façon fiable, donc on fait les deux à chaque clic : on laisse le
// comportement natif du lien tenter l'ouverture (fonctionne hors jeu, ignoré
// silencieusement en jeu) ET on copie systématiquement l'URL dans le
// presse-papiers avec une confirmation visible, pour que le joueur en jeu
// puisse coller le lien ailleurs (client Discord, navigateur Steam...).

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) { /* repli ci-dessous */ }
  }
  // Repli — fonctionne dans des contextes NUI qui n'exposent pas l'API
  // Clipboard moderne (execCommand reste largement supporté).
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch (_) {
    return false;
  }
}

let toastTimer = null;
function showCopyToast(text) {
  let el = document.getElementById('copy-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'copy-toast';
    el.style.cssText =
      'position:fixed; bottom:24px; left:50%; transform:translateX(-50%); ' +
      'background:#1a2332; color:#fff; border:1px solid rgba(255,255,255,0.15); ' +
      'padding:10px 16px; border-radius:8px; font-size:13px; z-index:9999; ' +
      'box-shadow:0 4px 16px rgba(0,0,0,0.3); max-width:90vw; text-align:center;';
    document.body.appendChild(el);
  }
  el.textContent = `Lien copié : ${text}`;
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3500);
}

/**
 * Attache la copie de secours à tous les éléments `[data-copy]` du
 * conteneur donné (par défaut tout le document). Idempotent — peut être
 * appelé à chaque re-rendu sans dupliquer les écouteurs (délégation).
 */
export function attachExternalLinkCopy(root = document) {
  root.querySelectorAll('[data-copy]').forEach((el) => {
    if (el.dataset.copyBound) return;
    el.dataset.copyBound = '1';
    el.addEventListener('click', async () => {
      const url = el.getAttribute('data-copy');
      if (!url) return;
      const ok = await copyText(url);
      if (ok) showCopyToast(url);
    });
  });
}

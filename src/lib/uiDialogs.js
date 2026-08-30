// ============================================================================
// NEWPAD — Repli pour alert()/confirm()/prompt() dans le navigateur intégré
// de FiveM (CEF/NUI).
// ============================================================================
// Les boîtes de dialogue JS natives (window.alert/confirm/prompt) bloquent
// l'exécution en attendant une réponse de l'OS — mais le NUI de FiveM ne
// dessine aucune fenêtre système pour ces dialogues. Résultat : l'appel reste
// bloqué indéfiniment en attendant une réponse qui n'arrivera jamais,
// gelant toute l'interface (plus aucun clic, plus aucun rendu). Ces trois
// fonctions reproduisent le même usage (await showAlert(...) au lieu de
// alert(...), etc.) mais avec une modale HTML/CSS pure, jamais bloquante
// pour le thread JS, qui fonctionne identiquement en jeu et hors jeu.

function buildOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'ui-dialog-overlay';
  overlay.style.cssText =
    'position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:10000; ' +
    'display:flex; align-items:center; justify-content:center; padding:24px;';
  return overlay;
}

// Les messages passés à ces trois fonctions viennent souvent du serveur, et
// contiennent parfois des données saisies par un autre joueur (nom affiché,
// libellé d'une demande, message d'erreur PostgreSQL qui reprend une valeur).
// Ils étaient insérés tels quels dans du HTML : un nom contenant une balise
// s'exécutait dans le navigateur de celui qui lisait le message. Aucun appelant
// ne passe volontairement du HTML — l'échappement est donc systématique.
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildCard(bodyHtml) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'max-width:420px; width:100%; padding:20px;';
  card.innerHTML = bodyHtml;
  return card;
}

export function showAlert(message) {
  return new Promise((resolve) => {
    const overlay = buildOverlay();
    overlay.appendChild(
      buildCard(`
        <p style="margin:0 0 16px; white-space:pre-wrap;">${esc(message)}</p>
        <button class="btn btn-primary ui-dialog-ok" style="width:100%;">OK</button>
      `)
    );
    document.body.appendChild(overlay);
    const done = () => { document.body.removeChild(overlay); resolve(); };
    overlay.querySelector('.ui-dialog-ok').addEventListener('click', done);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(); });
  });
}

export function showConfirm(message) {
  return new Promise((resolve) => {
    const overlay = buildOverlay();
    overlay.appendChild(
      buildCard(`
        <p style="margin:0 0 16px; white-space:pre-wrap;">${esc(message)}</p>
        <div class="flex gap-sm">
          <button class="btn btn-ghost ui-dialog-cancel" style="flex:1;">Annuler</button>
          <button class="btn btn-primary ui-dialog-ok" style="flex:1;">Confirmer</button>
        </div>
      `)
    );
    document.body.appendChild(overlay);
    const done = (value) => { document.body.removeChild(overlay); resolve(value); };
    overlay.querySelector('.ui-dialog-ok').addEventListener('click', () => done(true));
    overlay.querySelector('.ui-dialog-cancel').addEventListener('click', () => done(false));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(false); });
  });
}

export function showPrompt(message, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = buildOverlay();
    overlay.appendChild(
      buildCard(`
        <p style="margin:0 0 12px; white-space:pre-wrap;">${esc(message)}</p>
        <input type="text" class="ui-dialog-input" value="${esc(defaultValue)}" style="width:100%; margin-bottom:16px;" />
        <div class="flex gap-sm">
          <button class="btn btn-ghost ui-dialog-cancel" style="flex:1;">Annuler</button>
          <button class="btn btn-primary ui-dialog-ok" style="flex:1;">Valider</button>
        </div>
      `)
    );
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.ui-dialog-input');
    input.focus();
    input.select();
    const done = (value) => { document.body.removeChild(overlay); resolve(value); };
    overlay.querySelector('.ui-dialog-ok').addEventListener('click', () => done(input.value));
    overlay.querySelector('.ui-dialog-cancel').addEventListener('click', () => done(null));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(input.value); if (e.key === 'Escape') done(null); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
  });
}

// ============================================================================
// NEWPAD — Affichage en clair des liens externes (Discord...)
// ============================================================================
// Dans le navigateur intégré de FiveM (CEF/NUI), l'ouverture d'un nouvel
// onglet vers une URL externe (target="_blank") est silencieusement bloquée
// — le clic "ne fait rien" pour le joueur. Hors jeu (Chrome/Edge...), le lien
// s'ouvre normalement. On ne peut pas distinguer les deux environnements de
// façon fiable.
//
// Auparavant, le clic déclenchait en plus une copie automatique du lien dans
// le presse-papiers — sur demande, ce comportement est retiré : le lien brut
// est maintenant simplement affiché en toutes lettres à côté de chaque
// élément `[data-copy]`, pour que le joueur le sélectionne et le copie
// lui-même manuellement (aucune action automatique au clic).

/**
 * Affiche le texte brut de chaque lien externe `[data-copy]` du conteneur
 * donné (par défaut tout le document), juste après l'élément. Idempotent —
 * peut être appelé à chaque re-rendu sans dupliquer l'affichage.
 */
export function attachExternalLinkCopy(root = document) {
  root.querySelectorAll('[data-copy]').forEach((el) => {
    if (el.dataset.copyBound) return;
    el.dataset.copyBound = '1';
    const url = el.getAttribute('data-copy');
    if (!url) return;
    const span = document.createElement('span');
    span.className = 'external-link-plain muted';
    span.textContent = url;
    span.style.cssText = 'display:block; font-size:11px; user-select:all; word-break:break-all; margin-top:2px; cursor:text;';
    span.title = 'Sélectionnez ce lien et copiez-le manuellement (Ctrl+C)';
    el.insertAdjacentElement('afterend', span);
  });
}

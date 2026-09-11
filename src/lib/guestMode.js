// ============================================================================
// Mode invité
// ============================================================================
// Un visiteur sans compte peut consulter les applications qui ont besoin d'une
// AUDIENCE pour exister : un média sans lecteurs, une plateforme vidéo sans
// spectateurs, un réseau social sans passants ne fonctionnent pas.
//
// Il n'y a délibérément AUCUN compte créé pour cela : pas de session anonyme,
// pas de profil fantôme. Le mode invité est un simple drapeau local, et tout ce
// qu'il ouvre est autorisé côté base au rôle `anon` — lecture seule, sur les
// seules applications de niveau invité. Créer un vrai compte pour chaque
// curieux remplirait la base de profils vides et donnerait à ces visiteurs des
// droits d'écriture qu'ils n'ont pas à avoir.
//
// Le drapeau vit dans `sessionStorage` : il disparaît à la fermeture. Un
// visiteur qui rouvre sa tablette en jeu retombe sur la présentation, qui est
// l'écran qui l'invite à ouvrir un compte.

const CLE = 'newpad.invite';

export function estInvite() {
  try {
    return sessionStorage.getItem(CLE) === '1';
  } catch (_) {
    // Navigation privée ou stockage bloqué : on considère simplement qu'il n'y
    // a pas de mode invité plutôt que de casser l'écran d'accueil.
    return false;
  }
}

export function entrerEnInvite() {
  try { sessionStorage.setItem(CLE, '1'); } catch (_) { /* sans effet */ }
}

export function quitterLeModeInvite() {
  try { sessionStorage.removeItem(CLE); } catch (_) { /* sans effet */ }
}

// ============================================================================
// NEWPAD — Traduction des erreurs serveur en messages compréhensibles
// ============================================================================
// Les écrans d'entrée dans la banque (inscription, adhésion) remplaçaient
// toute erreur par un message unique — « Impossible de créer l'accès pour le
// moment. » — quelle qu'en soit la cause. Un mot de passe trop court, un
// identifiant déjà pris, une limite de tentatives ou une panne réseau
// donnaient exactement la même phrase : l'utilisateur ne pouvait pas savoir
// quoi corriger, et le support non plus.
//
// Les messages métier venant de nos propres fonctions PostgreSQL sont déjà
// rédigés en français et destinés à l'utilisateur (« Le montant minimum de
// virement est de … ») : ils sont laissés tels quels. Seuls les messages
// techniques de Supabase Auth et de PostgreSQL sont traduits.
// ============================================================================

const AUTH_PATTERNS = [
  {
    // GoTrue renvoie « User already registered » ; l'e-mail synthétique étant
    // dérivé de l'identifiant, cela signifie toujours : identifiant déjà pris.
    test: (m) => /already registered|already exists|already been registered/i.test(m),
    message: 'Cet identifiant est déjà utilisé. Choisissez-en un autre.',
  },
  {
    test: (m) => /password.*(at least|should be|too short|weak)/i.test(m),
    message: 'Mot de passe trop court : 8 caractères minimum.',
  },
  {
    // Limite anti-abus de Supabase Auth.
    test: (m) => /only request this after|rate limit|too many requests/i.test(m),
    message: 'Trop de tentatives en peu de temps. Patientez une minute avant de réessayer.',
  },
  {
    // Piège anti-robot du trigger handle_new_auth_user.
    test: (m) => /Inscription refusée/i.test(m),
    message: "Inscription refusée par la protection anti-robot. Si vous êtes une personne réelle, contactez la banque sur Discord.",
  },
  {
    test: (m) => /invalid.*email|email.*invalid/i.test(m),
    message: "Identifiant invalide : utilisez uniquement des lettres, chiffres, points, tirets ou underscores.",
  },
  {
    test: (m) => /Invalid login credentials/i.test(m),
    message: 'Identifiant ou mot de passe incorrect.',
  },
  {
    // Index unique partiel posé par la migration 0020.
    test: (m) => /idx_membership_one_open_per_applicant/i.test(m),
    message: "Vous avez déjà une demande d'adhésion en cours d'examen. Attendez la décision du personnel.",
  },
  {
    test: (m) => /duplicate key value|violates unique constraint/i.test(m),
    message: 'Cette valeur est déjà utilisée.',
  },
  {
    test: (m) => /Failed to fetch|NetworkError|network request failed/i.test(m),
    message: 'Connexion au serveur impossible. Vérifiez votre connexion et réessayez.',
  },
];

/**
 * Traduit une erreur en message affichable. Les messages métier français
 * remontés par nos fonctions PostgreSQL sont conservés intégralement.
 * @param {unknown} err
 * @param {string} fallback message si l'erreur n'est pas reconnue
 * @returns {string}
 */
export function humanError(err, fallback = "Une erreur est survenue. Réessayez dans un instant.") {
  const raw = (err && (err.message || err.error_description || err.msg)) || '';
  if (!raw) return fallback;

  for (const p of AUTH_PATTERNS) {
    if (p.test(raw)) return p.message;
  }

  // Message métier écrit par nos soins : il commence par une majuscule, est en
  // français et s'adresse déjà à l'utilisateur. On le laisse passer tel quel
  // plutôt que de le remplacer par une phrase creuse.
  if (/[àâçéèêëîïôûùüÿœ]/i.test(raw) || /^(Le |La |Les |Vous |Ce |Cette |Réservé|Compte|Montant|Dépôt|Plafond)/.test(raw)) {
    return raw;
  }

  // Toute erreur non reconnue reste consultable en console pour le diagnostic,
  // au lieu de disparaître silencieusement.
  console.error('[newpad] erreur non traduite :', raw, err);
  return fallback;
}

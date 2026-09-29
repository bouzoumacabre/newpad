// ============================================================================
// NEW AI — le moteur de réponses (sans IA, sans coût)
// ============================================================================
// Aucun appel à un modèle : la question est comparée à des mots-clés, et
// l'assistant oriente vers l'application qui convient. Les noms, descriptions
// et adresses viennent du registre (une application renommée par l'admin est
// aussitôt connue) ; les mots-clés et conseils, eux, sont ici.
//
// ponytail: correspondance par mots-clés — pas de vraie conversation. Pour
// une IA générative, l'Edge Function `new-ai` (payante) est déjà déployée.

const APPS = {
  bank: {
    mots: ['banque', 'compte', 'virement', 'solde', 'argent', 'pret', 'credit', 'epargne', 'lingot', 'or',
      'coffre fort', 'iban', 'depot', 'retrait', 'dette', 'rembourser', 'payer', 'paiement', 'dollars'],
    conseil: 'Comptes, virements, prêts, épargne, lingots et coffres se gèrent dans Newman Bank. Chaque opération est validée par la banque.',
  },
  news: {
    mots: ['journal', 'actualite', 'actu', 'info', 'article', 'media', 'presse', 'journaliste', 'nouvelles'],
    conseil: 'News24 publie l’actualité de la ville ; les journalistes y écrivent leurs articles.',
  },
  youtube: {
    mots: ['video', 'chaine', 'youtube', 'streamer', 'clip', 'regarder', 'vlog'],
    conseil: 'NewTube héberge les vidéos et les chaînes des habitants.',
  },
  page: {
    mots: ['annuaire', 'entreprise', 'societe', 'commerce', 'magasin', 'boutique', 'horaires', 'adresse'],
    conseil: 'NewPage est l’annuaire : chaque entreprise y a sa page, ses horaires et ses contacts.',
  },
  market: {
    mots: ['annonce', 'vendre', 'acheter', 'occasion', 'vente', 'achat', 'petite annonce', 'objet'],
    conseil: 'NewMarket accueille les petites annonces. Le paiement se fait ensuite par virement Newman Bank.',
  },
  pro: {
    mots: ['gerer mon entreprise', 'mon entreprise', 'employes', 'salaries', 'back office', 'direction',
      'membres', 'grade', 'patron', 'gerant'],
    conseil: 'NewPro est le back-office de votre entreprise : membres, grades et gestion.',
  },
  work: {
    mots: ['emploi', 'travail', 'travailler', 'job', 'cv', 'candidature', 'postuler', 'recrutement', 'recruter',
      'offre', 'embauche', 'metier'],
    conseil: 'NewWork réunit les offres d’emploi, les candidatures et votre CV.',
  },
  mail: {
    mots: ['mail', 'message', 'courrier', 'email', 'ecrire', 'envoyer un message', 'contacter', 'boite'],
    conseil: 'NewMail est la messagerie ; les pièces jointes viennent de NewFiles.',
  },
  life: {
    mots: ['reseau social', 'publication', 'publier', 'post', 'abonne', 'abonnes', 'followers', 'story', 'photo', 'profil'],
    conseil: 'NewLife est le réseau social de la ville : publications, abonnés, réactions.',
  },
  league: {
    mots: ['competition', 'tournoi', 'match', 'equipe', 'classement', 'championnat', 'sport', 'course', 'ligue', 'score'],
    conseil: 'NewLeague organise les compétitions : inscrivez votre équipe, suivez les matchs et le classement.',
  },
  events: {
    mots: ['evenement', 'soiree', 'concert', 'fete', 'agenda', 'sortie', 'gala', 'inauguration'],
    conseil: 'NewEvent est l’agenda de la ville : annoncez un événement ou inscrivez-vous.',
  },
  gov: {
    mots: ['mairie', 'gouvernement', 'permis', 'licence', 'papiers', 'identite', 'demarche', 'administration',
      'carte d identite', 'autorisation', 'amende'],
    conseil: 'NewGov réunit les démarches administratives : ouvrez un dossier, joignez vos pièces, suivez la réponse.',
  },
  ads: {
    mots: ['publicite', 'pub', 'campagne', 'promotion', 'annonceur', 'banniere', 'faire connaitre'],
    conseil: 'NewAds est la régie publicitaire : créez une campagne pour votre entreprise.',
  },
  dynasty: {
    mots: ['immobilier', 'maison', 'appartement', 'villa', 'logement', 'louer', 'location', 'propriete'],
    conseil: 'Dynasty présente les biens immobiliers ; demandez une visite depuis le catalogue.',
  },
  luxury: {
    mots: ['voiture', 'vehicule', 'auto', 'automobile', 'concession', 'moto', 'garage', 'essai'],
    conseil: 'Concess Luxury présente les véhicules ; demandez un rendez-vous depuis le catalogue.',
  },
  vangelico: {
    mots: ['bijou', 'bijoux', 'bijouterie', 'montre', 'collier', 'bague', 'joaillerie', 'diamant'],
    conseil: 'La bijouterie Vangelico présente ses pièces ; demandez un rendez-vous depuis le catalogue.',
  },
  doc: {
    mots: ['medecin', 'hopital', 'sante', 'soin', 'soins', 'blessure', 'blesse', 'certificat medical',
      'consultation', 'docteur', 'malade', 'urgence'],
    conseil: 'NewDoc est le portail médical : consultations, certificats et suivi.',
  },
  files: {
    mots: ['document', 'fichier', 'papier', 'stocker', 'ranger', 'pdf', 'piece jointe', 'partager un document'],
    conseil: 'NewFiles est votre coffre documentaire : vous y rangez vos papiers et décidez qui peut les voir.',
  },
  sacem: {
    mots: ['musique', 'chanson', 'artiste', 'droits d auteur', 'droits', 'label', 'oeuvre', 'album', 'morceau'],
    conseil: 'SACEM enregistre les œuvres musicales et leurs ayants droit.',
  },
  insurance: {
    mots: ['assurance', 'assurer', 'sinistre', 'accident', 'contrat', 'prime', 'indemnisation'],
    conseil: 'NewInsurance gère les souscriptions et les déclarations de sinistre.',
  },
  'create-app': {
    mots: ['creer une application', 'creer une app', 'ma propre application', 'ma propre app',
      'application pour mon entreprise', 'nouvelle application', 'developper une application'],
    conseil: 'Créer votre App permet à une entreprise de demander sa propre application dans Newpad.',
  },
};

const FAQ = [
  {
    mots: ['mot de passe', 'oublie', 'reinitialiser', 'je n arrive pas a me connecter'],
    texte: 'Sur l’écran de connexion, choisissez « Mot de passe oublié ». La réinitialisation passe par le Discord Newman Bank.',
  },
  {
    mots: ['ouvrir un compte', 'creer un compte', 'devenir client', 'inscription', 'm inscrire'],
    texte: 'Depuis l’accueil de la tablette, « Créer un compte » envoie une demande d’adhésion à Newman Bank. Un compte donne accès à toutes les applications.',
    app: 'bank',
  },
  {
    mots: ['bonjour', 'salut', 'bonsoir', 'hello', 'coucou', 'yo'],
    texte: 'Bonjour ! Dites-moi ce que vous cherchez : un emploi, un logement, un médecin, une démarche…',
  },
  {
    mots: ['merci', 'parfait', 'super', 'top'],
    texte: 'Avec plaisir. Autre chose ?',
  },
  {
    mots: ['qui es tu', 'tu es qui', 'aide', 'que sais tu faire', 'comment ca marche'],
    texte: 'Je suis le guide de Newpad : décrivez ce que vous voulez faire, je vous indique l’application qui convient.',
  },
];

// Mots trop communs dans les descriptions du registre pour désigner une
// application (« Banque privée de la ville »).
const MOTS_VIDES = new Set(['ville', 'privee', 'portail', 'reseau', 'plateforme', 'votre', 'entreprise']);

export function normaliser(s) {
  return ' ' + String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() + ' ';
}

// Un mot-clé compte s'il apparaît comme mot entier (ou au pluriel) : « or »
// ne doit pas se déclencher dans « ordinateur ». Plus il est long, plus il
// pèse : « certificat medical » est plus parlant que « soin ».
function score(texte, mots) {
  let total = 0;
  for (const m of mots) {
    const k = normaliser(m).trim();
    if (texte.includes(' ' + k + ' ') || texte.includes(' ' + k + 's ')) total += k.split(' ').length;
  }
  return total;
}

/**
 * @param {string} question
 * @param {Array} registre  applications du registre (listApps)
 * @returns {{ texte: string, apps: Array<{name: string, route: string}> }}
 */
export function repondre(question, registre) {
  const texte = normaliser(question);
  // Seules les applications ouvertes à tous les comptes sont proposées :
  // l'existence d'une application restreinte (NewDark) ne se révèle pas.
  const dispo = new Map(registre
    .filter((a) => a.is_enabled && a.access_level !== 'restricted' && a.slug !== 'ai')
    .map((a) => [a.slug, a]));
  const lien = (slug) => { const a = dispo.get(slug); return a ? [{ name: a.name, route: a.route }] : []; };

  const faq = FAQ.map((f) => ({ f, s: score(texte, f.mots) })).sort((a, b) => b.s - a.s)[0];

  const classement = [...dispo.values()].map((a) => {
    const fiche = APPS[a.slug];
    // Le nom et la description du registre comptent aussi : une application
    // ajoutée par l'admin sans mots-clés ici reste trouvable par son nom.
    const s = (fiche ? score(texte, fiche.mots) : 0)
      + score(texte, [a.name, a.short_name].filter(Boolean)) * 3
      + score(texte, normaliser(a.description).trim().split(' ')
        .filter((w) => w.length > 4 && !MOTS_VIDES.has(w)));
    return { a, fiche, s };
  }).filter((x) => x.s > 0).sort((x, y) => y.s - x.s);

  if (faq.s > 0 && (!classement.length || faq.s >= classement[0].s)) {
    return { texte: faq.f.texte, apps: faq.f.app ? lien(faq.f.app) : [] };
  }

  if (!classement.length) {
    return {
      texte: 'Je n’ai pas trouvé d’application pour ça. Essayez avec d’autres mots : « emploi », « voiture », « médecin », « virement », « permis »…',
      apps: [],
    };
  }

  const [premier, second] = classement;
  const texteReponse = premier.fiche?.conseil
    || `${premier.a.name} : ${premier.a.description}.`;
  const apps = [{ name: premier.a.name, route: premier.a.route }];
  // Deux réponses presque aussi bonnes : on propose les deux plutôt que de
  // trancher au hasard.
  if (second && second.s >= premier.s * 0.8) apps.push({ name: second.a.name, route: second.a.route });
  return { texte: texteReponse, apps };
}

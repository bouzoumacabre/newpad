# Newpad — l'écosystème : journal du chantier

Ce document prend la suite de `PROGRESS.md`, qui s'arrête au 25 août 2026 et
ne couvre que Newman Bank. À partir du 9 septembre, le projet sort du
périmètre bancaire : Newpad devient l'internet interne de Hurricane FA, 23
applications dans une seule tablette, un seul dépôt, une seule base.

Dernière mise à jour : 28 septembre 2026.

---

## Décisions d'architecture arrêtées avec l'utilisateur

1. **Pas de réécriture en React.** Le cahier des charges (§74) la demandait.
   Newman Bank compte 79 écrans en JS vanilla et cinq mois de correctifs
   audités ; les réécrire avant la première application Newpad aurait coûté
   des semaines pour un risque de régression élevé. On reste en JS vanilla +
   Vite, déjà en routage par hash et déjà optimisé pour le navigateur du jeu.
2. **Un seul Supabase**, `newpad-bnw-v2` (`vdbuvltfwulsxqjpwzhr`).
3. **§90, règle absolue** : aucune gestion de monnaie H$, nulle part, jamais.
   Les applications qui affichent des prix (NewMarket, les vitrines, NewAds,
   NewEvent) les affichent comme du **texte**. Rien n'est encaissé dans
   Newpad ; si un virement doit avoir lieu, il passe par Newman Bank.
4. **§93** : ne rien détruire de Newman Bank. Aucune migration de ce chantier
   ne touche une table bancaire.

## Doctrine technique (héritée du chantier bancaire, toujours en vigueur)

- **Toute écriture passe par une fonction `security definer`.** Aucune policy
  INSERT/UPDATE/DELETE directe (deux exceptions documentées : `mail_drafts`,
  `work_profiles`). Une policy UPDATE porte sur la LIGNE, jamais sur la
  colonne : accorder l'écriture « sur des champs sans enjeu » ouvre en réalité
  le statut, le propriétaire et le nom.
- **Une fonction citée par une policy ne doit pas porter le préfixe `_`.**
  Les fonctions préfixées sont révoquées à `authenticated` (convention 0038),
  et une policy s'évalue avec les droits de l'appelant — d'où
  `permission denied for function _file_owner` en production. Depuis 0043,
  **chaque migration contient un bloc qui refuse toute migration laissant une
  policy citer une fonction interne.**
- **Vérification** : chaque lot rejoue ses contrôles de sécurité en base dans
  une transaction annulée (`set local role authenticated`/`anon` +
  `set_config('request.jwt.claims', …)`), puis un parcours complet au
  navigateur sans interface, réseau Supabase simulé.

## Les socles partagés — le vrai fil du chantier

Plutôt que 23 applications, le chantier a produit **quatre socles** et des
écrans minces par-dessus. C'est ce qui explique le rythme.

| Socle | Migration | Ce qu'il porte |
|---|---|---|
| Organisations | 0040 | entreprise, membres, direction — utilisé par NewPage, NewPro, NewWork, News24, les vitrines, les guichets, NewAds, SACEM |
| Engagement | 0049 | vues, réactions, commentaires sur `(entity_type, entity_id)` — News24, NewTube, NewLife, NewMarket, NewEvent, vitrines, NewAds |
| Vitrines | 0053 | catalogue + demande de rendez-vous — Dynasty, Concess Luxury, Vangelico |
| Guichets | 0054 | démarches + dossiers + conversation + pièces — NewGov, NewDoc, NewInsurance |

Les deux derniers se pilotent par un drapeau du registre (`is_showcase`,
`is_service`) : **l'administration peut transformer n'importe quelle
application en vitrine ou en guichet sans redéploiement**, et composer ses
catégories ou ses formulaires depuis l'écran.

## Interconnexion (§13) — ce qui n'est jamais recopié

- Une pièce jointe NewMail, un CV NewWork, une pièce de dossier NewGov ne sont
  **pas des copies** : ce sont des autorisations `file_permissions` sur le
  document du coffre. L'usager révoque dans NewFiles, le destinataire perd
  l'accès — y compris sur un message déjà reçu.
- SACEM ne compte pas d'écoutes : une œuvre déclare être utilisée dans une
  vidéo NewTube, et l'audience se lit dans `analytics_events`, sur la vidéo.
- NewAds ne crée aucun compteur : `impression` et `click` existaient déjà dans
  le socle d'engagement.

## Niveaux d'accès

| | |
|---|---|
| `guest` | applications qui ont besoin d'une audience : Newman Bank (vitrine), News24, NewTube, NewPage, NewLife, NewEvent |
| `client` | clients Newman Bank et personnel |
| `restricted` | autorisation nominative — le régime de NewDark |

L'asymétrie est délibérée : une application « client » reste **visible,
cadenassée** (c'est ce qui donne envie d'ouvrir un compte) ; une application
« restreinte » **disparaît** — pour NewDark, l'existence même de l'accès fait
partie de ce qui est restreint. Mode invité **sans compte fantôme** : un
drapeau local, et la lecture autorisée au rôle `anon` en base.

## État au 28 septembre 2026

**Livré et vérifié** — tablette, registre d'applications, niveaux d'accès,
mode invité, console d'administration générale ; Newman Bank (intacte),
NewFiles, NewMail, NewPage, NewPro, NewWork, News24, NewTube, NewLife,
NewMarket, NewEvent, Dynasty, Concess Luxury, Bijouterie Vangelico, NewGov,
NewDoc, NewInsurance, NewAds, SACEM.

Migrations `0040` à `0056`, toutes appliquées en base.

**Reste à construire** — NewLeague, NewDark, NEW AI, Créer votre App.

**Reste à refaire** — les correctifs frontend perdus des étapes 6 à 34 (jeton
de navigation du routeur, conteneurs défilants des tableaux, cibles tactiles,
échappement du CMS sur l'accueil public).

**Arbitrages en attente, repris des lots bancaires** — migration `0016` écrite
non appliquée ; réparation des 3 004 531 $ de monnaie fantôme ; deux comptes
clôturés à −2 490 $ ; qui supporte la commission de virement et de lingot ;
plafond d'arriérés de loyer de coffre à 8 semaines.

## Pièges rencontrés, pour ne pas les repayer

- **Le navigateur du jeu garde `index.html` bien plus longtemps qu'un
  navigateur ordinaire** — un déploiement pouvait rester invisible plusieurs
  jours. `index.html` demande maintenant explicitement à ne pas être mis en
  cache. Si une modification « ne s'affiche pas », c'est la première piste.
- Supabase émet son événement de connexion **aussi au démarrage**, quand il
  restaure la session : rediriger dessus sans condition casse tout lien
  profond.
- Une variable CSS inconnue rend la déclaration invalide **en silence** : ni
  erreur, ni couleur. `--card`, `--border`, `--muted` n'existaient pas ; ils
  sont désormais déclarés comme alias dans `tokens.css`.
- Dans les tests Playwright, la route enregistrée **en dernier** gagne : un
  motif large (`rpc/service_case**`) avale les plus précis
  (`rpc/service_case_thread**`) s'il est enregistré après.

# Audit segmenté de Newpad — étapes 20 à 24

Suite de `newpad-audit-etapes14-19.md`. Ce lot porte sur cinq domaines qui
n'avaient jamais été audités : la porte d'entrée, le virement, l'or, la
messagerie, et le routage. Il se termine par une vérification qui a trouvé plus
que prévu.

**Le fil rouge de ce lot : trois fonctions n'avaient jamais fonctionné.** Aucune
n'apparaissait cassée. Toutes trois échouaient à chaque appel depuis leur
création, et toutes trois étaient masquées par le même mécanisme — un repli qui
renvoie une liste vide, donc un écran qui affiche « aucun résultat » au lieu
d'une erreur.

---

## Étape 20 — identité de profil et chaîne d'authentification

Le fond est sain, et cela méritait d'être vérifié plutôt que supposé : le rôle
passe par `app_metadata`, que seule la clé service_role peut écrire (la voie
d'élévation par l'inscription publique est bien fermée) ; le code de
réinitialisation vient d'une source cryptographique, un seul code vit à la fois,
les sessions sont révoquées après changement de mot de passe, et la réponse est
identique que l'identifiant existe ou non.

Quatre corrections (migration `0042`) :

**A. Un client pouvait se donner un titre de personnel.** Le garde-fou de
mise à jour de profil protégeait sept champs et en laissait quatre libres, dont
`employee_title` — que seul l'admin renseigne, et que le sélecteur de
destinataires affiche sous la forme « Nom (Titre) ». Un `PATCH` direct sur son
propre profil suffisait à apparaître comme cadre de la banque auprès du
personnel. `created_by`, `created_at` et `id` sont verrouillés au passage.

**B. Le nom affiché n'était validé nulle part.** Le libellé de contrepartie du
registre étant `coalesce(display_name, 'Newman Bank' si trésorerie, 'Externe')`,
un client nommé « Newman Bank » apparaissait dans l'historique de tous les autres
exactement comme la banque. Un déclencheur normalise et refuse l'usurpation de
l'institution, comparaison faite sans casse, sans accents et sans ponctuation
pour que « N e w m a n - B â n k » ne passe pas. Les noms ne sont volontairement
**pas** rendus uniques : plusieurs comptes portent légitimement le même nom de
personnage.

**C.** Les droits de table sur `password_reset_codes` restaient accordés à
`anon`. RLS sans policy refuse déjà tout, mais la première policy ajoutée par
commodité exposerait les empreintes — et un SHA-256 de six chiffres se retrouve
en moins d'une seconde.

**D.** N'importe qui pouvait fabriquer des échecs de connexion pour n'importe
quel identifiant, salissant le registre et déclenchant une alerte sur un client
innocent. Le succès, lui, était déjà correctement vérifié. Plafonné à 20
écritures par identifiant et par tranche de 5 minutes ; l'alerte est levée avant
le plafond, donc le signal est conservé.

---

## Étape 21 — le gel de compte n'était appliqué que par le navigateur

La mécanique du virement est solide : verrouillage de la ligne, revérification du
solde et du statut **au moment de la décision** et pas seulement à la demande,
escalade sous le solde minimum, écriture par le point de passage unique. La table
`transfers` n'a qu'une policy de lecture, donc l'indicateur qui décide de la
commission et de l'escalade ne peut pas être falsifié.

**Le défaut est ailleurs.** `profiles.status` — actif, suspendu, gelé — n'était
consulté que par une ligne de JavaScript, dans le navigateur du client
sanctionné. Aucune fonction serveur ne le lisait. Un client gelé voyait l'écran
de blocage mais gardait un jeton valide :

```
POST /rest/v1/rpc/submit_transfer { ... }
```

passait. **Neuf comptes sont gelés en base ; les neuf pouvaient virer,
emprunter, acheter au marché.** C'est le défaut de l'étape 13 sous une autre
forme — la règle existait, du côté où l'intéressé peut la retirer.

Le contrôle est déplacé en base, dans les dix points d'entrée qui engagent de
l'argent ou un service. Délibérément **pas** dans le support ni la messagerie :
couper le support d'un client gelé transformerait une sanction réversible en
impasse. Ni dans le retrait d'annonce ou le remboursement anticipé, qui réduisent
l'exposition.

**Deux autres corrections :** le plafond de virement était affiché par l'écran
mais jamais appliqué par le serveur (latent — le réglage n'existe pas encore) ;
et le relevé du destinataire annonçait plus que ce qu'il avait reçu.

La commission est prélevée sur le montant **reçu** :

```
émetteur     −montant
destinataire +montant − commission
trésorerie   +commission
```

La ligne de transaction sépare bien les deux, mais l'historique n'affichait que
le montant nominal : au taux de 1 %, un client recevant 200 000 $ lisait
« +200 000 » pour 198 000 $ réellement portés à son compte. La notification, elle,
annonçait déjà le bon chiffre — le système connaissait la valeur juste, seul le
relevé ne la montrait pas.

> **Question de jeu, pas de code, laissée à l'arbitrage :** faire porter la
> commission au destinataire plutôt qu'à l'émetteur est inhabituel. Les flux
> monétaires n'ont pas été touchés ; seule la vérité de l'affichage l'a été.

---

## Étape 22 — un plafond de variation relatif ne borne rien

Le marché de revente est bien tenu (achat de sa propre annonce refusé, double
demande refusée, revérification du propriétaire à la décision, rejet automatique
des demandes concurrentes).

Le défaut est dans la défense du cours de l'or. Trois protections sont empilées,
mais les deux premières — lissage et plafond de **5 % par vente** — sont
relatives : elles limitent chaque pas, pas la marche. Cinq pour cent vingt fois
de suite multiplient le cours par 2,65 ; cinquante fois, par 11,5. Deux comptes
complices qui se revendent le même lingot déplacent le cours aussi loin qu'ils
veulent, au prix de 3 % par aller-retour — un coût, pas un obstacle.

Seules les bornes absolues arrêtent cette marche. Elles valaient toutes les deux
zéro. Rien ne se produit aujourd'hui, le cours automatique étant désactivé : le
défaut s'activerait le jour où un admin coche la case **en croyant que le
plafond de 5 % le protège**. L'activation est désormais refusée tant qu'un
plancher et un plafond ne sont pas posés, avec l'explication dans le message.

La commission de marché (3 %, trois fois celle du virement) n'était elle non plus
annoncée nulle part : le montant réellement encaissé est maintenant calculé à la
saisie et rappelé sur chaque annonce.

---

## Étape 23 — la messagerie n'a jamais fonctionné

Le contrôle d'accès est sérieux et n'a rien donné : chaque fonction vérifie la
participation, et `mark_notifications_read` porte un
`and recipient_id = auth.uid()` qui empêche de marquer lue la notification
d'autrui — ce qui aurait permis de faire disparaître une alerte de fraude de
l'écran d'un employé.

Mais `list_messageable_contacts` lève une erreur **à chaque appel depuis la
migration 0010**, le 20/08 :

```
ERROR: 42702: column reference "role" is ambiguous
```

La fonction déclare une colonne de **sortie** nommée `role`, et sa première
instruction est `select role into v_caller_role from profiles`. PostgreSQL ne
peut pas trancher entre la colonne de la table et le paramètre OUT. Le conflit se
règle à l'exécution, pas à la création : la fonction s'est créée sans broncher.

Deux mécanismes l'ont rendue invisible trois semaines durant :

1. l'erreur tombait dans un repli qui renvoyait une liste vide — l'écran
   affichait « aucun contact » au lieu d'une erreur. C'est exactement le défaut
   de l'étape 14, qui aura ici masqué une fonctionnalité entière ;
2. un module qui ne marche pas ne produit pas de données : les deux tables de
   messagerie sont restées à **zéro ligne** depuis l'origine, ce qui ressemblait
   à une fonctionnalité peu utilisée.

Vérifié en rejouant la définition d'avant correction à l'identique : elle échoue
de la même façon. Le défaut est antérieur, pas introduit par l'audit.

**Deux autres corrections :** le sélecteur renvoyait l'identifiant de connexion
de tout le personnel à n'importe quel client (l'authentification se fait par
identifiant et mot de passe, sans e-mail — c'est la moitié des informations, et
la seule des deux qui n'est pas censée être devinable ; l'écran n'a jamais
utilisé ce champ). Et l'écriture de messages n'était plafonnée par rien, alors
que chaque message de client appelle une notification **par membre du
personnel** : mille messages depuis un seul ticket en produisent cinq mille avec
cinq employés. Plafond par auteur, et surtout regroupement des notifications —
le personnel a besoin de savoir qu'un ticket a bougé, pas de le réapprendre à
chaque phrase.

---

## Étape 24 — vérification finale : deux autres fonctions mortes

Après l'étape 23, la question s'imposait : combien y en a-t-il d'autres ? Elle ne
se règle pas par relecture — les requêtes en cause sont correctes, c'est leur
collision avec la signature qui ne l'est pas. **Il faut appeler.**

Vingt-trois fonctions de lecture s'appellent sans argument obligatoire — celles
qu'un écran déclenche à son ouverture, donc celles dont l'échec passe le plus
inaperçu. Multipliées par les quatre rôles : 92 appels, dans une transaction
annulée, en se plaçant dans la peau de chaque rôle.

**`my_transactions` — « column reference "id" is ambiguous ».** La mienne, écrite
à l'étape 15. L'écran « Mes opérations » livré à l'étape 16 n'a jamais rien
affiché. Il n'est pas encore en ligne, donc personne n'a rien perdu — mais il
serait parti cassé. J'ai relu cette fonction trois fois, vérifié sa signature,
ses droits, son type de retour. Je ne l'avais jamais **appelée**.

**`my_feature_flags` — « structure of query does not match function result
type ».** `feature_registry.area` est une énumération, la fonction déclarait
`area text`, et `return query` exige une correspondance exacte. Cassée depuis
l'étape 13.

La conséquence demande de la précision, parce que l'intuition se trompe de sens.
L'**application** de la règle n'était pas touchée : `has_feature` et
`require_feature` sont d'autres fonctions, elles marchent, le test le confirme.
C'est l'**affichage** qui mentait, dans le sens permissif — les coquilles de
navigation font `key in flags ? flags[key] : true`, donc avec un chargement en
échec le menu montrait *toutes* les fonctionnalités, y compris celles que l'admin
avait désactivées. L'utilisateur cliquait et se faisait refuser par le serveur.
Le réglage marchait ; l'écran prétendait le contraire.

**Et une erreur commise pendant ce lot.** La vérification a compté 3 fonctions
ouvertes aux visiteurs au lieu des 2 de l'invariant. Supabase pose des privilèges
par défaut qui accordent EXECUTE **directement** à `anon` sur toute fonction
créée — un grant direct, pas un héritage de PUBLIC, que mes « revoke from
public » ne touchaient pas. Seule `my_transactions` était concernée : c'est la
seule fonction du lot supprimée puis recréée, et un `drop`+`create` repart des
privilèges par défaut là où un `create or replace` conserve les droits.
Exposition réelle nulle, mais compter sur le garde interne d'une fonction plutôt
que sur ses droits est exactement l'erreur des étapes 13 et 19. Le contrôle de
fin de migration vérifie désormais la **liste nominative** des fonctions ouvertes
à `anon`, pas seulement son cardinal.

Le test est conservé dans `scripts/test-de-fumee.sql`, à rejouer après toute
migration créant une fonction de lecture et avant chaque livraison.

### Vérification consolidée

| Contrôle | Résultat |
|---|---|
| Test de fumée, 23 fonctions × 4 rôles | 92 appels, **aucune anomalie** |
| Points d'entrée du code présents avec leurs droits | 86 / 86 |
| Fonctions ouvertes à `authenticated` | 90 sur 131 |
| Fonctions ouvertes à `anon` | 2, nommément vérifiées |
| Points d'entrée gardés par le statut de profil | 10 / 10 |
| Tâches planifiées actives | 6 |
| Masse monétaire | 253 004 530,50 $ — invariant de l'étape 7 tenu |

---

## Ce que ce lot apprend

Les étapes 14 à 19 avaient montré qu'une banque qui répond faux sans le dire est
plus dangereuse qu'une banque en panne. Ce lot-ci va plus loin : **trois
fonctionnalités entières étaient mortes sans que rien ne le signale**, et l'une
d'elles l'était de mon fait, dans du code que j'avais relu plusieurs fois.

Le repli silencieux — corrigé à l'étape 14 pour les erreurs de chargement — n'a
pas seulement caché des pannes passagères : il a caché des modules qui n'ont
jamais tourné une seule fois. Et une relecture, même attentive, ne remplace pas
une exécution : les trois défauts sont invisibles à la lecture, puisque chaque
requête prise isolément est correcte.

---

## Reste à arbitrer par l'utilisateur

Inchangé depuis l'étape 13, plus un point nouveau :

1. **Migration `0016`** — plafonds de virement, virements programmés, stockage
   des documents. Écrite, non appliquée.
2. **`supabase/repairs/0001_repair_phantom_money.sql`** — les 3 004 531 $ de
   monnaie fantôme de l'étape 7. Détruire cette monnaie a un effet direct sur
   l'économie du serveur.
3. **Deux comptes clôturés à −2 490 $ chacun** — la dette a disparu avec la
   clôture. Refusé depuis la 0032, mais ces deux cas antérieurs restent à
   trancher.
4. **Nouveau — qui paie la commission ?** Le destinataire d'un virement et le
   vendeur d'un lingot supportent la commission, l'émetteur et l'acheteur ne la
   voient pas. C'est cohérent entre les deux modules, mais inhabituel pour une
   banque. L'affichage dit maintenant la vérité dans les deux cas ; changer le
   flux lui-même est une décision de jeu.

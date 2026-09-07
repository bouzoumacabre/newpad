# Audit segmenté de Newpad — étapes 14 à 19

Suite de `newpad-audit-etapes8-13.md`. Même méthode : une fonctionnalité à la
fois, constat vérifié contre la base réelle avant toute correction, correction
appliquée, correction re-vérifiée.

Rappel du contexte de déploiement, qui explique la moitié des précautions prises
ici : **la base se déploie instantanément, le site se déploie à la main.** Toute
migration est en ligne à la seconde où elle est appliquée ; le frontend, lui,
attend que l'utilisateur dépose un zip sur GitHub. Retirer un droit ou une
policy est donc une modification cassante pour le site actuellement en ligne,
tant que la version correspondante n'a pas été déposée.

---

## Étape 14 — 151 échecs de chargement invisibles

**Constat.** 151 appels de chargement se terminaient par `.catch(() => [])` ou
équivalent. Une erreur réseau, un droit manquant, une fonction renommée : l'écran
s'affichait normalement, avec une liste vide. Un client dont l'historique
n'arrivait pas voyait « Aucune opération », c'est-à-dire une réponse fausse
présentée comme une réponse.

**Correction.** `swallow(nom, repli)` dans `src/lib/loadState.js` : le repli est
toujours renvoyé, mais l'échec est journalisé, compté, et remonté. Un bouton
d'avertissement apparaît dans la barre supérieure dès le premier échec, avec le
détail de ce qui n'a pas chargé. Le compteur est remis à zéro à la déconnexion.

**Ce qui a été retenu.** Un repli silencieux n'est acceptable que si quelqu'un,
quelque part, apprend que le repli a été utilisé.

---

## Étape 15 — la volumétrie fausse les chiffres avant de casser quoi que ce soit

**Constat.** Chaque écran de liste s'arrêtait à une limite codée en dur — 100,
200 ou 300 — sans jamais signaler qu'il s'était arrêté. Avec 32 transactions en
base, rien ne se voyait. Le défaut n'apparaîtra qu'une fois le serveur rempli, et
il se manifestera par des **chiffres faux** plutôt que par une erreur : le membre
du personnel qui ne trouve pas une opération au registre en conclura qu'elle
n'existe pas.

**Correction (migration 0040).** `staff_list_transactions` et
`staff_list_audit_log` renvoient désormais le total correspondant au filtre en
plus de la page demandée, et acceptent un décalage. Les écrans affichent « 300
sur 4 128 » et proposent la suite. Cinq index de lecture ajoutés sur les colonnes
de tri et de filtrage.

**Point de méthode.** Ajouter une colonne au résultat impose de recréer la
fonction. Le site en ligne appelle avec des paramètres **nommés** : les valeurs
par défaut du nouveau paramètre suffisent, l'appel existant continue de
fonctionner. Vérifié avant application, pas supposé.

---

## Étape 16 — l'historique du client était construit dans l'URL

**Constat.** `getMyTransactions` listait les comptes du client puis assemblait un
filtre PostgREST à la main, deux conditions par compte, toutes passées dans la
chaîne de requête d'un GET. Chaque identifiant fait 36 caractères : au-delà d'une
poignée de comptes, l'URL dépasse la limite du serveur et la requête échoue — et
l'échec était justement l'un des 151 avalés en silence de l'étape 14.

Le personnel disposait d'un registre cherchable et filtrable depuis le 20/08. Le
client, qui a pourtant le plus de raisons de chercher une opération précise
(« quand ai-je payé ce loyer de coffre ? »), n'avait que les opérations d'un
compte à la fois, sans recherche ni filtre de date.

**Correction.** Nouvelle fonction `my_transactions()` : filtrage, recherche,
plage de dates et pagination côté base. Nouvel écran **Mes opérations**
(`/client/transactions`) avec recherche, filtre par type, plage de dates, solde
net de la sélection et export CSV (BOM UTF-8, séparateur `;`, point décimal —
un tableur français lit la colonne comme un nombre).

---

## Étape 17 — un canal temps réel par navigation

**Constat.** `subscribeToMyNotifications` ouvrait un canal Realtime à chaque
écran monté et ne le fermait jamais. Après trente navigations : trente canaux
vivants pour un seul utilisateur, et une notification déclenchait trente
rafraîchissements d'écran.

**Correction.** Un canal unique par utilisateur, partagé entre des écouteurs
nommés, fermé seulement quand le dernier se retire ou à la déconnexion.

**Erreur commise et corrigée.** Ma première correction se désabonnait avant de se
réabonner, ce qui vidait l'ensemble des écouteurs et fermait puis rouvrait le
canal à chaque navigation — le même défaut sous une autre forme. Détecté par une
simulation Node écrite pour l'occasion, qui vérifie six invariants (1 canal après
30 navigations, 1 rafraîchissement par notification, 0 écouteur résiduel, nouveau
canal au changement d'utilisateur). 6/6.

---

## Étape 18 — un élément absent ne doit pas emporter tout l'écran

**Correction appliquée.** 54 `addEventListener` passés en chaînage optionnel dans
31 fichiers. Lorsqu'un bouton n'est pas rendu — droit absent, liste vide —
l'ancien code levait une `TypeError` qui interrompait le rendu de l'écran
**entier**. Ne rien attacher est strictement moins grave que tout casser.

**Correction volontairement NON appliquée.** Les 140 lectures directes
`.value` / `.checked` ont été laissées telles quelles. Vérification faite pour
chacune : le champ lu et le bouton qui déclenche la lecture sont rendus dans le
même bloc de gabarit, donc le gestionnaire ne peut pas s'exécuter en l'absence du
champ. Y ajouter `?.` aurait produit `undefined` au lieu d'une erreur —
c'est-à-dire une valeur fausse transmise silencieusement à la base plutôt qu'un
échec visible. C'est exactement le défaut corrigé à l'étape 14, réintroduit sous
prétexte de robustesse.

93 `<label>` reliés à leur champ par `for=`, dans 22 fichiers. Restent sans
liaison les libellés de champs désactivés (qui n'ont pas d'identifiant) et ceux
qui enveloppent leur propre case à cocher, où la liaison est implicite.

---

## Étape 19 — vérification finale, et une faille de la famille de l'étape 13

La vérification consolidée devait être une formalité.

**Constat.** La migration 0038 (étape 13) avait inversé la règle des droits :
au lieu d'accorder puis de retirer au cas par cas, retirer tout puis accorder.
Mais le balayage de retrait reposait sur une **convention de nom** — le préfixe
`_`. Les fonctions internes qui n'en portaient pas sont restées ouvertes.

Il y en avait cinq, et ce sont exactement les cinq tâches planifiées qui
déplacent de l'argent :

| Fonction | Horaire | Rôle |
|---|---|---|
| `charge_account_fees()` | 03h00 | prélève les frais de tenue de compte |
| `pay_savings_interest()` | 03h10 | verse les intérêts depuis la trésorerie |
| `charge_safe_weekly_fees()` | 03h20 | prélève les loyers de coffre |
| `process_due_loan_installments()` | 04h00 | prélève les échéances de prêt |
| `generate_daily_cashier_report()` | 23h55 | clôture la caisse du jour |

Toutes `SECURITY DEFINER`, aucune n'ayant de contrôle d'appelant — elles n'en
avaient pas besoin, personne n'était censé pouvoir les appeler. N'importe quel
client connecté pouvait pourtant poster sur `/rest/v1/rpc/pay_savings_interest`
depuis son navigateur et verser cent jours d'intérêts en une minute, prélevés sur
la trésorerie de la banque. Sans laisser d'autre trace que des mouvements
parfaitement réguliers, simplement trop nombreux.

**Correction (migration 0041).** La convention de nom est remplacée par une liste
explicite de 90 points d'entrée, construite en réunissant trois sources
vérifiables :

1. les 86 `.rpc()` du code source courant ;
2. les 77 `.rpc()` de la révision effectivement déployée (`9567de1`) — toutes
   incluses dans les 86, vérifié et non supposé ;
3. les 4 fonctions citées dans une expression de policy RLS.

Le point 3 est celui qui aurait pu tout casser : une policy s'évalue avec les
droits de l'appelant, donc `is_staff()`, `is_admin()`, `is_irs()` et
`visible_for_current_role()` doivent rester exécutables, sans quoi **plus aucune
lecture** ne fonctionne pour personne. Les autres prédicats ne sont appelés que
depuis le corps de fonctions `SECURITY DEFINER`, qui s'exécute avec les droits du
propriétaire : leur retirer le droit d'appel direct ne les empêche pas de
fonctionner. Vérifié également qu'aucune n'apparaît dans une contrainte, une
valeur par défaut, un index ni une vue, où le droit de l'appelant redeviendrait
nécessaire.

La migration contient son propre contrôle : elle lève une exception — et annule
donc ses propres retraits — si une fonction hors liste reste ouverte.

**Conséquence à retenir.** Une fonction nouvellement créée n'a désormais aucun
droit tant qu'elle n'est pas ajoutée à cette liste. C'est le comportement voulu :
une omission rend une fonctionnalité inaccessible, ce qui se voit tout de suite,
au lieu d'ouvrir un accès, ce qui ne se voit jamais.

### Le reste du contrôle final

| Vérification | Résultat |
|---|---|
| 86 appels du code ↔ base | tous présents, droits corrects |
| 24 chemins d'écriture ↔ policies | tous couverts |
| Révision en ligne `9567de1` ↔ base après 0027–0041 | 13 tables, 77 fonctions, **zéro rupture** |
| Tâches planifiées | 6 jobs, toujours exécutables sous `postgres` |
| Fonctions ouvertes à `authenticated` | 90 sur 128 |
| Fonctions ouvertes à `anon` | 2 (`record_login_attempt`, `gold_price_snapshot`) |
| Masse monétaire | 253 004 530,50 $ — conforme à l'invariant de l'étape 7 |
| Avis de sécurité Supabase | aucune alerte de niveau ERROR |

---

## Ce que ces six étapes ont en commun

Trois des six défauts corrigés ici ne se manifestaient par **aucune erreur** :
l'écran s'affichait, la liste était vide ou tronquée, le chiffre était faux. Un
seul (l'étape 19) était une faille exploitable, et elle n'aurait jamais produit
la moindre alerte non plus — juste des prélèvements réguliers, en trop grand
nombre.

Une banque qui répond faux sans le dire est plus dangereuse qu'une banque qui
tombe en panne.

---

## Reste à arbitrer par l'utilisateur (inchangé depuis l'étape 13)

Rien n'a été appliqué sur ces trois points, qui relèvent d'une décision de jeu et
non d'une correction technique :

1. **Migration `0016`** — plafonds de virement, virements programmés, stockage
   des documents. Écrite, non appliquée.
2. **`supabase/repairs/0001_repair_phantom_money.sql`** — les 3 004 531 $ de
   monnaie fantôme identifiés à l'étape 7. Détruire cette monnaie a un effet
   direct sur l'économie du serveur.
3. **Deux comptes clôturés avec un solde de −2 490 $ chacun** — la dette a
   disparu avec la clôture. La clôture d'un compte non soldé est refusée depuis
   le 30/08 (migration 0032), mais ces deux cas antérieurs restent à trancher.

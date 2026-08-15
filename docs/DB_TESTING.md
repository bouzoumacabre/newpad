# Tests du schéma de base de données

Le schéma complet (`supabase/migrations/`) a été validé par rejeu contre une
instance PostgreSQL 16 locale, avec un harnais reproduisant les éléments
Supabase dont dépendent les migrations (schéma `auth.users` minimal,
fonction `auth.uid()` pilotable par variable de session, stub `cron.schedule`).
Un rôle Postgres `authenticated` (sans `BYPASSRLS`, comme le rôle réel utilisé
par l'API Supabase) a été créé pour que les tests RLS soient probants — les
tester en tant que superutilisateur `postgres` les aurait rendus muets
(le superutilisateur contourne RLS par défaut).

## Scénarios vérifiés

1. **Trigger d'inscription** (`handle_new_auth_user`) : une ligne `auth.users`
   crée automatiquement le `profiles` correspondant (rôle `prospect`).
2. **Adhésion** : prospect → demande → employé traite → employé valide →
   compte + IBAN créés automatiquement, rôle passe à `client`, dépôt initial
   enregistré comme transaction.
3. **Virement** : soumission client → traitement employé → validation →
   débit émetteur, crédit destinataire (moins commission), crédit trésorerie
   banque — soldes vérifiés au centime près.
4. **Montant minimum de virement** (100 000 $ par défaut) : rejeté avant
   même la création de la ligne `transfers` si le montant est inférieur.
5. **Achat de lingot auprès de la banque** : prix calculé depuis
   `economic_settings.gold_price_per_gram`, propriété du lingot transférée
   automatiquement à la validation.
6. **Séparation des pouvoirs sur les prêts** : un employé peut réceptionner
   (`employee_review_loan`) mais **ne peut pas** valider
   (`admin_decide_loan` échoue avec "Seul l'admin peut valider un prêt") ;
   un admin peut. L'échéancier est généré automatiquement à la validation.
7. **Garde-fou solde minimum → admin** (bug détecté et corrigé, voir
   `0002e_fix_admin_override.sql`) : un employé qui tente de valider un
   virement/achat/location faisant passer le client sous le solde minimum
   voit la demande automatiquement repassée en attente d'autorisation admin
   (`requires_admin_override = true`), **sans lever d'exception** (c'est un
   état métier normal, pas une erreur) ; un admin peut ensuite l'autoriser,
   et `admin_authorized_by` est correctement renseigné pour la traçabilité.
8. **RLS — isolation entre clients** : un client ne voit, via une requête
   directe, ni les comptes ni les transactions d'un autre client.
9. **RLS — écriture interdite hors fonctions** : une tentative d'`INSERT`
   direct dans `transactions` (contournant les fonctions métier) est
   rejetée par RLS, y compris pour un client authentifié sur son propre
   compte — seules les fonctions `SECURITY DEFINER` peuvent créer des
   mouvements de fonds.

## Bug corrigé pendant les tests

La première version de `decide_transfer`/`decide_membership_request`
enchaînait `UPDATE ... SET requires_admin_override = true` puis
`RAISE EXCEPTION` **dans le même appel de fonction** — or une exception
PL/pgSQL annule (rollback) tous les effets de l'appel en cours, y compris
cet `UPDATE`. Le drapeau ne persistait donc jamais et `admin_authorized_by`
restait vide. Corrigé dans `0002e_fix_admin_override.sql` : ces cas ne
lèvent plus d'exception (ce sont des états métier normaux, pas des erreurs),
et le même garde-fou a été étendu à l'achat de lingot (banque + marché) et à
la confirmation de location de coffre, qui en avaient besoin d'après le
cahier des charges mais ne l'avaient pas dans la version initiale.

## Comment rejouer les tests

Les scripts de test (`smoke_test*.sql`) ne sont pas versionnés dans ce
dépôt (générés dans l'environnement de build). Pour revalider le schéma
après modification, le plus simple est d'appliquer les migrations dans
l'ordre sur un projet Supabase de test (ou une instance Postgres locale
avec le harnais décrit ci-dessus) et de rejouer manuellement les parcours
listés ci-dessus depuis l'éditeur SQL, en utilisant
`select set_config('request.jwt.claim.sub', '<uuid>', true);` ou
l'équivalent pour simuler `auth.uid()`.

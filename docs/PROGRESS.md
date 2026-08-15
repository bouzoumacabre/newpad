# Newpad — Inventaire, phases, état d'avancement

Dernière mise à jour : 15 août 2026.

## 1. Inventaire (résumé de cadrage)

- **4 rôles + accueil public** : Client, Employé, Admin (= employé + pouvoirs élargis), IRS (staff Hurricane FA, lecture seule garantie en base). Une seule base de données, un seul déploiement.
- **Authentification** : identifiant + mot de passe, e-mail synthétique `identifiant@newpad.local` en interne (jamais montré). Prospect → inscription libre → demande d'adhésion → activation automatique du compte client à la validation employé/admin. Employé/admin/IRS créés manuellement.
- **Client** : dashboard, infos ville, comptes multiples (IBAN, solde), virements (≥ 100 000 $ sauf entre ses propres comptes), transactions, bénéficiaires, lingots d'or (achat banque + marché de revente), coffres-forts, prêts professionnels, consulting premium, documents, support (tickets = conversation), paramètres.
- **Employé** : dashboard, recherche/registre clients (catégories dynamiques), ouverture de compte guichet, demandes d'adhésion, file clients, traitement virements/prêts (réception seulement)/coffres/lingots, rapports de caisse (lecture), alertes fraude, support, journal d'activité.
- **Admin** : tout ce que fait l'employé (+ correction manuelle du rapport de caisse) + validation finale des prêts + frappe/édition directe du registre de lingots + autorisation des opérations sous le solde minimum + gestion des employés/comptes clients/permissions génériques par compte/comptes IRS/masquage compte-ou-transaction par interface + pilotage économique complet (tous les seuils, avec exceptions par client) + contenu de tout le site (CMS) + audit & sécurité + rapports & statistiques + configuration système (maintenance, bannière, activation des fonctionnalités).
- **IRS** : interface dédiée à part entière (comme les 3 autres), lecture seule sur les transactions/comptes/stats agrégées, restriction garantie par RLS (aucun grant d'écriture, aucun accès direct aux tables de base — uniquement via des fonctions `irs_*` dédiées), soumise au masquage par interface.
- **Processus métier communs** : demande → notification → "en cours de traitement" → décision. Aucune saisie manuelle de solde nulle part : chaque mouvement de fonds découle exclusivement de la validation d'une action prévue par le système, via des fonctions Postgres atomiques.
- **Pilotage économique 100% dynamique** : solde minimum (global + exception par client), montant minimum de virement, fourchette de prix marketplace lingots, taux prêt/épargne/pénalité de retard, cours de l'or, frais et commissions — tout en base, rien codé en dur.
- **Contraintes techniques** : Supabase (Postgres + Auth + Realtime + Storage + pg_cron), compatibilité navigateur intégré FiveM, déploiement GitHub Pages, RLS pour toutes les restrictions d'accès (y compris IRS et masquage).

## 2. Découpage en phases

| Phase | Contenu | Statut |
|---|---|---|
| 0 | Cadrage, inventaire, décisions infra (Supabase connecté, format multi-fichiers) | ✅ Fait |
| 1 | Fondations : schéma DB complet, RLS, fonctions métier, socle frontend (design system, routing, auth) | ✅ Déployé sur le vrai projet Supabase (`newpad-bnw`, réf. `hvtonptowwriprbmmzmw`, région Paris). Socle frontend fonctionnel et relié (voir §4 et §5) |
| 2 | Page d'accueil publique | ✅ Écran construit, relié au vrai projet Supabase (`site_content`, piloté depuis l'admin une fois Phase 5 construite ; fallback conservé si hors-ligne) |
| 3 | Interface Client (tous les écrans) | ⬜ À construire |
| 4 | Interface Employé | ⬜ À construire |
| 5 | Interface Admin | ⬜ À construire |
| 6 | Interface IRS | ⬜ À construire |
| 7 | Automatisations & temps réel (notifications, Realtime, tâches planifiées) | 🟡 Fonctions et jobs `pg_cron` écrits côté DB (0002/0005) ; notifications realtime pas encore branchées côté frontend |
| 8 | Données de démo, tests, déploiement GitHub Pages | ⬜ À faire |

## 3. Base de données — ce qui est fait

Tous les fichiers sont dans `supabase/migrations/`, à exécuter dans l'ordre alphabétique de leur nom (0001 → 0006b) :

- **0001 / 0001b / 0001c** — schéma complet : profils, registre de fonctionnalités générique, permissions par compte, paramètres économiques (globaux + exceptions par client), catégories de clientèle dynamiques (M:N), comptes + trésorerie banque, transactions (ledger unique), bénéficiaires, virements, lingots (registre + achats banque/marché), coffres-forts, prêts + échéancier, support (ticket + messages), consulting, adhésion + ouverture guichet, file clients, fraude (règles + alertes), rapports de caisse, masquage générique par interface, notifications, audit + journal de connexion, comptes IRS, CMS (`site_content`), documents.
- **0002 / 0002b / 0002c / 0002e** — toute la logique métier en fonctions `SECURITY DEFINER` : virements, lingots (banque + marché), coffres, prêts (demande → revue employé → décision admin exclusive → échéancier automatique → remboursement anticipé), adhésion, ouverture guichet, frais de gestion périodiques, intérêts d'épargne (désactivés par défaut), échéances de prêts automatiques, rapport de caisse quotidien + correction admin, support (fil de discussion), masquage, note de confiance, journal de connexion + détection fraude sur échecs répétés.
- **0003 / 0003b** — RLS activé sur **toutes** les tables + fonctions de lecture dédiées à l'IRS (`irs_stats`, `irs_list_clients`, `irs_list_accounts`, `irs_list_transactions`, `irs_list_gold_bars`) qui sont le **seul** chemin de lecture pour ce rôle (aucun grant direct sur les tables de base) + garde-fou anti-modification frauduleuse de son propre profil (rôle/statut/note de confiance).
- **0004** — données de référence (types de comptes, paramètres économiques par défaut, règles de fraude, registre de fonctionnalités, coffres et lingots de démonstration, catégories clientèle de départ, contenu CMS de la page d'accueil).
- **0005** — tâches planifiées `pg_cron` (frais de gestion, intérêts d'épargne, échéances de prêts, rapport de caisse quotidien).

**Testé** en local contre PostgreSQL 16 (voir `docs/DB_TESTING.md`) : inscription, adhésion, virement, achat de lingot, séparation employé/admin sur les prêts, garde-fou solde minimum → admin, isolation RLS entre clients, interdiction d'écriture directe hors fonctions. Un bug réel a été trouvé et corrigé pendant ces tests (voir le fichier ci-dessus).

**Déployé sur le vrai projet Supabase** (`newpad-bnw`, réf. `hvtonptowwriprbmmzmw`, région `eu-west-3` Paris, plan gratuit) : les 11 migrations (0001 → 0005) appliquées dans l'ordre, plus une migration de durcissement supplémentaire (**0006 / 0006b**) ajoutée après revue des avis de sécurité Supabase :
- `search_path` fixé explicitement sur toutes les fonctions `SECURITY DEFINER` (évite tout risque de détournement par manipulation du chemin de recherche).
- Droit d'exécution des fonctions retiré au rôle `anon` (visiteur non connecté) : aucune fonction métier n'a besoin d'être appelable sans session — seul `authenticated` (et `service_role`) peut les exécuter ; le contenu public passe uniquement par la lecture directe de `site_content`, protégée par sa propre policy RLS.
- Vérifié après coup : 35/35 tables avec RLS actif, 4/4 tâches `pg_cron` enregistrées et actives, extensions `pgcrypto`/`pg_cron`/`uuid-ossp` installées, aucune erreur de sécurité restante (seuls des avis informatifs attendus par construction — ex. "les utilisateurs connectés peuvent exécuter telle fonction", ce qui est le principe même de l'architecture).
- Données de référence en place : 23 fonctionnalités au registre, 19 paramètres économiques, 4 types de comptes, 1 compte trésorerie (250 M$), 6 lingots, 5 coffres, 4 catégories clientèle, 15 blocs de contenu public.

**Pas encore fait** : script de génération des comptes de démonstration (nécessite l'API Admin Supabase, prévu Phase 8), Edge Function pour la création de comptes employé/admin/IRS/guichet (nécessite `service_role`, ne peut pas se faire depuis le client), désactivation de "Confirm email" dans Auth (aucun outil API pour ça — reste une étape manuelle unique dans le tableau de bord Supabase, voir `README.md`).

## 4. Frontend — ce qui est fait

- Scaffold Vite + JS vanilla (pas de framework lourd), cible `es2017` + polyfills legacy (`@vitejs/plugin-legacy`) pour le navigateur intégré FiveM, build statique testé avec succès.
- Design system complet dans `src/styles/tokens.css` (couleurs, typographies, rayons, ombres — toute la charte y est centralisée).
- Logo recréé en SVG vectoriel propre (`src/assets/logo.svg`), fidèle au triangle "A" doré existant.
- Routeur hash minimal (`src/lib/router.js`) — robuste sur GitHub Pages sans configuration serveur.
- Client Supabase + conversion identifiant → e-mail synthétique (`src/lib/supabaseClient.js`).
- Écrans fonctionnels : connexion, inscription prospect, page d'accueil publique (contenu piloté par `site_content` avec repli si hors-ligne).
- Coquille commune (sidebar + topbar) pour les 4 interfaces internes, avec garde d'accès par rôle déjà opérationnelle (redirection automatique après connexion selon le rôle) — le contenu détaillé de chaque interface reste à construire (phases 3 à 6).
- Captures d'écran validées visuellement (accueil public, connexion) — rendu conforme à l'identité demandée.

## 5. Ce qui bloque une mise en ligne réelle

1. ~~Connexion Supabase~~ ✅ Fait : projet créé, migrations déployées, `.env.local` local renseigné avec l'URL et la clé anon réelles (fichier non versionné, voir `.env.example` pour le modèle).
2. **Désactiver "Confirm email"** : Authentication > Providers > Email dans le tableau de bord Supabase — aucun outil ne permet de le faire à ma place, c'est la seule étape manuelle restante côté Supabase (voir `README.md`).
3. **Dépôt GitHub** : aucun connecteur GitHub n'est disponible dans cet environnement. Le dépôt est prêt-à-pousser (déjà initialisé en Git localement, migrations + frontend inclus). En attente du dépôt vide + jeton d'accès personnel (accès choisi par toi) pour que je pousse directement.
4. **Edge Functions** (création de comptes employé/admin/IRS/guichet) : nécessitent la clé `service_role`, qui ne doit jamais être exposée côté client — à déployer via `mcp__Supabase__deploy_edge_function` une fois écrites (prévu avec la construction des interfaces Employé/Admin).

## 6. Prochaines étapes

1. ~~Connecter Supabase → créer le projet et exécuter les migrations.~~ ✅ Fait.
2. Construire l'interface Client écran par écran (phase 3) — en cours, prochaine étape immédiate.
3. Construire l'interface Employé (phase 4), puis Admin (phase 5), puis IRS (phase 6).
4. Brancher les notifications temps réel + Supabase Realtime côté frontend (phase 7 — la base est déjà prête côté DB).
5. Données de démo réalistes, tests de bout en bout, dépôt GitHub + déploiement GitHub Pages (phase 8, dès réception de l'accès).

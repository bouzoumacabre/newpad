# Newpad — Newman Bank (BNW-VLT-1924)

Plateforme bancaire privée pour le personnage Salomon Newman, serveur FiveM RP francophone **Hurricane FA**.

## État du projet

Voir `docs/PROGRESS.md` pour l'inventaire complet, le découpage en phases et l'état d'avancement détaillé.

**Résumé** : le schéma de base de données complet (tables, RLS, fonctions métier) est écrit, testé localement (voir `docs/DB_TESTING.md`) **et déployé sur le vrai projet Supabase** (`newpad-bnw-v2`, réf. `vdbuvltfwulsxqjpwzhr`, région Paris — voir §"Mise en place" ci-dessous pour l'état actuel). Le socle frontend (design system, routing, authentification, page d'accueil publique) est fonctionnel et relié à ce projet. Les 4 interfaces internes (Client/Employé/Admin/IRS) restent à construire écran par écran (phases 3 à 6).

> ⚠️ **Note** : le projet précédent (`newpad-bnw`, réf. `hvtonptowwriprbmmzmw`) a été supprimé accidentellement le 15/08/2026. L'intégralité du schéma a été redéployée à l'identique sur ce nouveau projet à partir des fichiers de migration versionnés (aucune perte de structure — la base était encore vide de données réelles de jeu au moment de l'incident).

## Stack technique

- **Backend** : Supabase (PostgreSQL + Auth + Realtime + Storage + tâches planifiées via `pg_cron`)
- **Frontend** : JavaScript vanilla (pas de framework lourd), build via Vite, ciblage `es2017` + polyfills legacy pour compatibilité navigateur intégré FiveM (CEF)
- **Déploiement** : GitHub Pages (site statique, routing par hash `#/...`)

## Démarrage local

```bash
npm install
cp .env.example .env.local   # renseigner VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY
npm run dev
```

## Mise en place du projet Supabase

**État actuel : projet créé et toutes les migrations déployées** (`newpad-bnw-v2`, réf. `vdbuvltfwulsxqjpwzhr`, région `eu-west-3` Paris, plan gratuit). `.env.local` local est déjà renseigné avec l'URL et la clé `anon` réelles. Il reste une seule étape manuelle (§2 ci-dessous, aucun outil ne permet de le faire par API) avant que l'inscription des prospects fonctionne réellement.

Étapes (pour référence, ou pour redéployer sur un nouveau projet) :

1. Créer un nouveau projet Supabase (nouveau projet dédié, pas de réutilisation). ✅ Fait.
2. **Authentication > Providers > Email** : désactiver **"Confirm email"** (sinon l'inscription des prospects échoue silencieusement, car Newpad utilise un e-mail synthétique `identifiant@newpad.local`). ⬜ **À faire manuellement dans le tableau de bord Supabase — étape bloquante restante.**
3. **Database > Extensions** : activer `pgcrypto` et `pg_cron`. ✅ Fait (les deux sont installées).
4. **SQL Editor** : exécuter les fichiers de `supabase/migrations/` **dans l'ordre alphabétique des noms de fichiers** (0001, 0001b, 0001c, 0002, 0002b, 0002c, 0002e, 0003, 0003b, 0004, 0005, 0006, 0006b, 0007). ✅ Fait — les 14 migrations sont appliquées (0006/0006b durcissent la sécurité : `search_path` explicite sur toutes les fonctions + retrait du droit d'exécution des fonctions aux rôles `public`/`anon` ; 0007 ajoute `resolve_account_by_iban`, nécessaire à l'écran de virement côté Client).
5. Depuis le SQL Editor (contexte `service_role`, donc autorisé malgré le garde-fou anti-self-update), promouvoir le tout premier compte admin :
   ```sql
   -- après avoir créé le compte via l'inscription normale du site (rôle 'prospect' par défaut)
   update profiles set role = 'admin' where username = 'votre_identifiant_admin';
   ```
   ⬜ À faire dès qu'un premier compte existe (nécessite l'étape 2 réalisée au préalable).
6. Copier **Project Settings > API > Project URL** et **anon public key** dans `.env.local`. ✅ Fait — et repris directement dans `.env.production` (versionné : la clé `anon` est conçue pour être publique, la vraie protection est assurée par les policies RLS, jamais par le secret de cette clé), donc aucun secret GitHub Actions n'est nécessaire pour le build.

## Déploiement GitHub Pages

Le dépôt pousse automatiquement le site sur GitHub Pages via `.github/workflows/deploy.yml` (build Vite + `actions/deploy-pages`) à chaque push sur `main`.

**Étape unique à faire une fois, manuellement** (aucune API ne permet de le faire à ma place) : dans le dépôt GitHub, **Settings > Pages > Build and deployment > Source**, sélectionner **"GitHub Actions"**. Une fois fait, chaque push sur `main` republie automatiquement le site à l'adresse `https://<utilisateur>.github.io/<dépôt>/`.

## Structure du dépôt

```
supabase/migrations/   Schéma DB complet, RLS, fonctions métier, tâches planifiées (SQL, source de vérité)
supabase/seed/          Script de génération des comptes de démonstration (à venir, Phase 8)
src/                    Frontend (pages, composants, styles, lib)
docs/                   Documentation d'avancement et de test
```

## Identité visuelle

Voir `src/styles/tokens.css` — toutes les couleurs/typos de la charte y sont centralisées. Ne jamais coder une couleur en dur ailleurs : toujours référencer les variables CSS (`var(--gold)`, etc.).

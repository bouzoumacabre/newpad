-- ============================================================================
-- NEWPAD — Migration 0004 : données de référence (pas de comptes de démo —
-- voir supabase/seed/seed-demo-users.mjs pour les profils de démonstration,
-- qui nécessitent l'API Admin Supabase pour créer les comptes auth).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- TYPES DE COMPTES
-- ----------------------------------------------------------------------------

insert into account_types (code, label, description, is_client_facing, sort_order) values
  ('courant', 'Compte courant', 'Compte à vue pour les opérations quotidiennes', true, 1),
  ('epargne', 'Compte épargne', 'Compte rémunéré (si activé par l''admin)', true, 2),
  ('entreprise', 'Compte entreprise', 'Compte dédié aux activités professionnelles', true, 3),
  ('treasury', 'Trésorerie Newman Bank', 'Compte interne de la banque', false, 99);

-- ----------------------------------------------------------------------------
-- COMPTE TRÉSORERIE DE LA BANQUE (singleton)
-- ----------------------------------------------------------------------------

insert into accounts (account_type, label, balance, is_bank_treasury, iban)
values ('treasury', 'Trésorerie BNW-VLT-1924', 250000000, true, 'BNW-TREASURY-1924');

-- ----------------------------------------------------------------------------
-- PARAMÈTRES ÉCONOMIQUES (valeurs par défaut demandées)
-- ----------------------------------------------------------------------------

insert into economic_settings (key, label, value, value_type, category) values
  ('min_client_balance', 'Solde minimum client', '{"amount": 1000000}', 'money', 'seuils'),
  ('min_transfer_amount', 'Montant minimum de virement entre clients', '{"amount": 100000}', 'money', 'seuils'),
  ('gold_listing_min_price', 'Prix minimum de mise en vente d''un lingot', '{"amount": 10000}', 'money', 'marketplace'),
  ('gold_listing_max_price', 'Prix maximum de mise en vente d''un lingot', '{"amount": 500000000}', 'money', 'marketplace'),
  ('gold_price_per_gram', 'Cours de l''or ($/gramme)', '{"amount": 60}', 'money', 'marché'),
  ('loan_rate', 'Taux prêt professionnel (%/an)', '{"amount": 6.5}', 'percent', 'prêts'),
  ('loan_cap', 'Plafond de prêt', '{"amount": 50000000}', 'money', 'prêts'),
  ('loan_late_penalty_rate', 'Pénalité de retard sur échéance impayée (%)', '{"amount": 5}', 'percent', 'prêts'),
  ('savings_rate', 'Taux d''épargne (%/versement)', '{"amount": 1.5}', 'percent', 'épargne'),
  ('savings_interest_enabled', 'Intérêts d''épargne actifs', '{"enabled": false}', 'boolean', 'épargne'),
  ('savings_payout_frequency_days', 'Fréquence de versement des intérêts (jours)', '{"amount": 30}', 'number', 'épargne'),
  ('account_fee_amount', 'Frais de gestion de compte', '{"amount": 2500}', 'money', 'frais'),
  ('account_fee_frequency_days', 'Fréquence des frais de gestion (jours)', '{"amount": 30}', 'number', 'frais'),
  ('transfer_commission_rate', 'Commission sur les virements (%)', '{"amount": 1}', 'percent', 'frais'),
  ('marketplace_commission_rate', 'Commission marketplace lingots (%)', '{"amount": 3}', 'percent', 'frais'),
  ('fraud_failed_login_threshold', 'Seuil de tentatives de connexion échouées', '{"amount": 5}', 'number', 'sécurité'),
  ('fraud_unusual_transfer_amount', 'Montant de virement jugé inhabituel', '{"amount": 20000000}', 'money', 'sécurité'),
  ('maintenance_mode', 'Mode maintenance', '{"enabled": false}', 'boolean', 'système'),
  ('announcement_banner', 'Bannière d''annonce système', '{"enabled": false, "message": ""}', 'json', 'système');

-- ----------------------------------------------------------------------------
-- RÈGLES DE FRAUDE
-- ----------------------------------------------------------------------------

insert into fraud_rules (key, label, enabled, threshold_config) values
  ('failed_login_attempts', 'Tentatives de connexion échouées répétées', true, '{"window_minutes": 15}'),
  ('unusual_transfer_amount', 'Virement d''un montant inhabituel', true, '{}'),
  ('balance_below_minimum', 'Solde client sous le minimum requis', true, '{}');

-- ----------------------------------------------------------------------------
-- FONCTIONNALITÉS (registre générique — extensible depuis l'admin)
-- ----------------------------------------------------------------------------

insert into feature_registry (key, label, area, category, default_roles, enabled, is_core) values
  ('client.transfers.create', 'Créer un virement', 'client', 'Comptes & Virements', '{client}', true, false),
  ('client.gold.buy_bank', 'Acheter un lingot à la banque', 'client', 'Patrimoine', '{client}', true, false),
  ('client.gold.market', 'Marché de revente de lingots', 'client', 'Patrimoine', '{client}', true, false),
  ('client.safes.request', 'Demander un coffre-fort', 'client', 'Patrimoine', '{client}', true, false),
  ('client.loans.request', 'Demander un prêt professionnel', 'client', 'Financement', '{client}', true, false),
  ('client.consulting', 'Consulting Premium', 'client', 'Services', '{client}', true, false),
  ('client.support', 'Support client', 'client', 'Services', '{client}', true, true),
  ('employee.clients.search', 'Recherche client', 'employee', 'Clients', '{employee,admin}', true, true),
  ('employee.membership.review', 'Traiter les demandes d''adhésion', 'employee', 'Clients', '{employee,admin}', true, false),
  ('employee.accounts.open', 'Ouvrir un compte au guichet', 'employee', 'Clients', '{employee,admin}', true, false),
  ('employee.transfers.process', 'Traiter les virements', 'employee', 'Opérations', '{employee,admin}', true, false),
  ('employee.gold.process', 'Traiter les demandes lingots', 'employee', 'Opérations', '{employee,admin}', true, false),
  ('employee.safes.process', 'Traiter les demandes de coffres', 'employee', 'Opérations', '{employee,admin}', true, false),
  ('employee.loans.review', 'Réceptionner les demandes de prêt', 'employee', 'Opérations', '{employee,admin}', true, false),
  ('employee.fraud.flag', 'Signaler une alerte fraude', 'employee', 'Caisse & sécurité', '{employee,admin}', true, false),
  ('admin.loans.decide', 'Valider/refuser un prêt (décision finale)', 'admin', 'Guichet', '{admin}', true, true),
  ('admin.gold.mint', 'Frapper de nouveaux lingots', 'admin', 'Pilotage économique', '{admin}', true, true),
  ('admin.gold.edit_registry', 'Modifier directement le registre des lingots', 'admin', 'Pilotage économique', '{admin}', true, true),
  ('admin.overrides.min_balance', 'Autoriser une opération sous le solde minimum', 'admin', 'Guichet', '{admin}', true, true),
  ('admin.permissions.manage', 'Gérer les permissions par compte', 'admin', 'Personnel & accès', '{admin}', true, true),
  ('admin.masking.manage', 'Masquer des comptes/transactions', 'admin', 'Personnel & accès', '{admin}', true, true),
  ('admin.content.manage', 'Éditer le contenu du site', 'admin', 'Contenu du site', '{admin}', true, true),
  ('admin.system.config', 'Configuration système (maintenance, bannière, feature flags)', 'admin', 'Système', '{admin}', true, true);

-- ----------------------------------------------------------------------------
-- COFFRES-FORTS (inventaire de démonstration)
-- ----------------------------------------------------------------------------

insert into safe_deposit_boxes (code, branch, annual_fee, status) values
  ('CF-001', 'Agence centrale — Los Santos', 150000, 'available'),
  ('CF-002', 'Agence centrale — Los Santos', 150000, 'available'),
  ('CF-003', 'Agence centrale — Los Santos', 250000, 'available'),
  ('CF-004', 'Succursale — Vinewood', 150000, 'available'),
  ('CF-005', 'Succursale — Vinewood', 300000, 'available');

-- ----------------------------------------------------------------------------
-- LINGOTS D'OR (stock initial propriété de la banque)
-- ----------------------------------------------------------------------------

insert into gold_bars (serial_number, weight_grams, status, location) values
  ('A001250', 1000, 'in_vault', 'Coffre central BNW-VLT-1924'),
  ('A001251', 1000, 'in_vault', 'Coffre central BNW-VLT-1924'),
  ('A001252', 500, 'in_vault', 'Coffre central BNW-VLT-1924'),
  ('A001253', 500, 'in_vault', 'Coffre central BNW-VLT-1924'),
  ('A001254', 250, 'in_vault', 'Coffre central BNW-VLT-1924'),
  ('A001255', 100, 'in_vault', 'Coffre central BNW-VLT-1924');

-- ----------------------------------------------------------------------------
-- CATÉGORIES DE CLIENTÈLE (exemples de départ)
-- ----------------------------------------------------------------------------

insert into client_categories (name, color, description) values
  ('VIP', '#c9a227', 'Clientèle à très haut patrimoine'),
  ('Sous surveillance', '#f0605a', 'Comportement nécessitant un suivi renforcé'),
  ('Entreprise', '#8a6f2e', 'Comptes professionnels et entreprises'),
  ('Nouveau client', '#4ade80', 'Client récemment adhéré');

-- ----------------------------------------------------------------------------
-- CONTENU DU SITE — accueil public (structure de départ, tout modifiable)
-- ----------------------------------------------------------------------------

insert into site_content (area, section_key, content, sort_order) values
  ('public', 'hero', '{"title_line1": "L''excellence bancaire", "title_line2": "au service de votre patrimoine.", "subtitle": "Newman Bank, votre banque privée à Los Santos depuis 1924.", "cta_primary": "Demander à devenir client", "cta_secondary": "Déjà client ? Se connecter"}', 1),
  ('public', 'key_stats', '{"stats": [{"label": "Actifs sous gestion", "value": "482 M$"}, {"label": "Clients privés", "value": "428"}, {"label": "Succursales", "value": "3"}, {"label": "Satisfaction", "value": "98%"}]}', 2),
  ('public', 'service_catalog', '{"title": "Gestion de patrimoine", "description": "Solutions sur-mesure pour protéger et faire fructifier votre richesse."}', 3),
  ('public', 'service_catalog', '{"title": "Financement professionnel", "description": "Des prêts adaptés à vos ambitions et à vos projets entrepreneuriaux."}', 4),
  ('public', 'service_catalog', '{"title": "Réserve de valeur", "description": "Achat de lingots d''or, coffres-forts sécurisés et dépôts en toute confiance."}', 5),
  ('public', 'service_catalog', '{"title": "Service discret & privilégié", "description": "Un accompagnement personnalisé, dans la plus grande confidentialité."}', 6)
;

-- Fil d'actualité — partagé entre l'accueil public et "Infos de la ville" côté client (area='public', section_key='city_news')
insert into site_content (area, section_key, content, sort_order) values
  ('public', 'city_news', '{"category": "Économie", "title": "Le marché immobilier en pleine expansion à Los Santos", "excerpt": "Les prix continuent leur progression dans les quartiers d''affaires.", "date": "2026-08-10"}', 1),
  ('public', 'city_news', '{"category": "Événement", "title": "Sommet économique annuel : les acteurs majeurs réunis à Los Santos", "excerpt": "Un rendez-vous incontournable pour les grandes fortunes de la ville.", "date": "2026-08-05"}', 2),
  ('public', 'city_news', '{"category": "Finance", "title": "Taux directeur : la banque centrale maintient sa position", "excerpt": "Aucun changement attendu avant la fin de l''année.", "date": "2026-07-28"}', 3);

-- Top 10 fortunes façon Forbes
insert into site_content (area, section_key, content, sort_order) values
  ('public', 'top10', '{"rank": 1, "name": "Abraham Newman", "net_worth": "128 M$", "sector": "Banque & finance"}', 1),
  ('public', 'top10', '{"rank": 2, "name": "Dov Lévy", "net_worth": "94 M$", "sector": "Immobilier"}', 2),
  ('public', 'top10', '{"rank": 3, "name": "Meïer Taïeb", "net_worth": "81 M$", "sector": "Négoce"}', 3);

-- Citations
insert into site_content (area, section_key, content, sort_order) values
  ('public', 'quote', '{"author": "Abraham Newman", "text": "La discrétion est la première forme de richesse."}', 1),
  ('public', 'quote', '{"author": "Dov Lévy", "text": "On ne bâtit pas un patrimoine, on le protège de génération en génération."}', 2);

-- Témoignages
insert into site_content (area, section_key, content, sort_order) values
  ('public', 'testimonial', '{"author": "Meïer Taïeb", "role": "Client depuis 2019", "text": "Un service d''une discrétion et d''un professionnalisme rares."}', 1);

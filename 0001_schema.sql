-- ============================================================================
-- NEWPAD / Newman Bank (BNW-VLT-1924) — Migration 0001: Schéma de base
-- ============================================================================
-- Convention: tout ce qui peut varier dans le temps (seuils, contenu, listes
-- de catégories, permissions, fonctionnalités actives) est stocké en données,
-- jamais codé en dur dans le schéma ou l'application.
-- ============================================================================

create extension if not exists "pgcrypto";
create extension if not exists "pg_cron";

-- ----------------------------------------------------------------------------
-- ENUMS
-- ----------------------------------------------------------------------------

create type user_role as enum ('prospect', 'client', 'employee', 'admin', 'irs');
create type account_status as enum ('active', 'frozen', 'closed');
create type request_status as enum ('pending', 'processing', 'validated', 'rejected', 'cancelled');
create type gold_bar_status as enum ('in_vault', 'listed', 'reserved', 'sold');
create type safe_status as enum ('available', 'reserved', 'rented', 'maintenance');
create type loan_status as enum ('pending', 'processing', 'approved', 'rejected', 'active', 'closed');
create type installment_status as enum ('pending', 'paid', 'late');
create type ticket_status as enum ('open', 'in_progress', 'resolved');
create type visibility_target as enum ('account', 'transaction');
create type app_interface as enum ('client', 'employee', 'admin', 'irs', 'public');

-- ----------------------------------------------------------------------------
-- PROFILS (1 profil = 1 utilisateur auth.users, quel que soit le rôle)
-- ----------------------------------------------------------------------------
-- Supabase Auth exige un e-mail interne : on utilise username@newpad.local
-- côté auth.users.email, mais seul `username` est jamais montré à l'écran.

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  role user_role not null default 'prospect',
  display_name text not null,
  status text not null default 'active' check (status in ('active', 'suspended', 'frozen')),
  employee_title text,
  trust_score numeric(5,2) not null default 70.00 check (trust_score between 0 and 100),
  client_since date,
  min_balance_override numeric(14,2),
  min_transfer_override numeric(14,2),
  pin_hash text,
  two_factor_enabled boolean not null default false,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table profiles is 'Un profil par compte utilisateur, tous rôles confondus (prospect/client/employee/admin/irs).';
comment on column profiles.min_balance_override is 'Exception individuelle au solde minimum global (Pilotage économique).';
comment on column profiles.min_transfer_override is 'Exception individuelle au montant minimum de virement.';

create index idx_profiles_role on profiles(role);

-- ----------------------------------------------------------------------------
-- REGISTRE DE FONCTIONNALITÉS (générique — pas d'enum figé)
-- ----------------------------------------------------------------------------
-- Chaque fonctionnalité du site (client/employé/admin) est une ligne ici.
-- `enabled` = interrupteur global (Principe 1 Admin). `default_roles` = qui y
-- a accès par défaut. Les exceptions individuelles vivent dans permission_grants.

create table feature_registry (
  key text primary key,
  label text not null,
  description text,
  area app_interface not null,
  category text,
  default_roles user_role[] not null default '{}',
  enabled boolean not null default true,
  is_core boolean not null default false, -- si true, ne peut pas être désactivée (sécurité/lecture seule IRS etc.)
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table feature_registry is 'Catalogue générique de toutes les fonctionnalités/services activables et permissibles du site.';

create table permission_grants (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references profiles(id) on delete cascade,
  feature_key text not null references feature_registry(key) on delete cascade,
  granted boolean not null, -- true = accès accordé explicitement, false = accès retiré explicitement
  note text,
  granted_by uuid references profiles(id),
  granted_at timestamptz not null default now(),
  unique (account_id, feature_key)
);

comment on table permission_grants is 'Exceptions individuelles (accorder ou retirer) par compte, au-dessus des droits par défaut du rôle.';

-- ----------------------------------------------------------------------------
-- PARAMÈTRES ÉCONOMIQUES (génériques, réglables depuis Pilotage économique)
-- ----------------------------------------------------------------------------

create table economic_settings (
  key text primary key,
  label text not null,
  value jsonb not null,
  value_type text not null default 'number', -- number | percent | money | boolean | json
  category text,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);

comment on table economic_settings is 'Tous les seuils/taux pilotables globalement (solde minimum, taux prêt, cours de l''or, etc.). Aucun n''est codé en dur côté application.';

create table client_setting_overrides (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references profiles(id) on delete cascade,
  setting_key text not null references economic_settings(key) on delete cascade,
  value jsonb not null,
  note text,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  unique (client_id, setting_key)
);

comment on table client_setting_overrides is 'Exception individuelle à un paramètre économique global, pour un client précis.';

-- ----------------------------------------------------------------------------
-- CATÉGORIES DE CLIENTÈLE (liste dynamique, plusieurs-à-plusieurs)
-- ----------------------------------------------------------------------------

create table client_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  color text default '#c9a227',
  description text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create table client_category_links (
  client_id uuid not null references profiles(id) on delete cascade,
  category_id uuid not null references client_categories(id) on delete cascade,
  linked_by uuid references profiles(id),
  linked_at timestamptz not null default now(),
  primary key (client_id, category_id)
);

-- ----------------------------------------------------------------------------
-- COMPTES (client + le compte "trésorerie" de la banque elle-même)
-- ----------------------------------------------------------------------------

create table account_types (
  code text primary key,
  label text not null,
  description text,
  is_client_facing boolean not null default true,
  sort_order int not null default 0
);

create table accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references profiles(id) on delete cascade, -- null pour le compte banque
  account_type text not null references account_types(code),
  iban text unique,
  label text,
  balance numeric(14,2) not null default 0,
  status account_status not null default 'active',
  is_bank_treasury boolean not null default false,
  opened_by uuid references profiles(id),
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);

comment on table accounts is 'Comptes clients (courant/épargne/entreprise...) + le compte trésorerie unique de la banque (is_bank_treasury = true, client_id null).';

create unique index idx_accounts_single_treasury on accounts ((is_bank_treasury)) where is_bank_treasury = true;
create index idx_accounts_client on accounts(client_id);

-- ----------------------------------------------------------------------------
-- LEDGER — TRANSACTIONS (source unique d'historique + support de l'IRS)
-- ----------------------------------------------------------------------------

create table transactions (
  id uuid primary key default gen_random_uuid(),
  tx_type text not null, -- transfer | gold_purchase_bank | gold_purchase_market | safe_rental | loan_disbursement |
                          -- loan_repayment | fee_management | fee_transfer_commission | fee_marketplace_commission |
                          -- savings_interest | cash_deposit | admin_adjustment
  status request_status not null default 'validated',
  from_account_id uuid references accounts(id),
  to_account_id uuid references accounts(id),
  amount numeric(14,2) not null,
  fee_amount numeric(14,2) not null default 0,
  description text,
  related_request_type text, -- table d'origine ('transfers','loans',...) pour retrouver le détail
  related_request_id uuid,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index idx_tx_from on transactions(from_account_id);
create index idx_tx_to on transactions(to_account_id);
create index idx_tx_created on transactions(created_at desc);
create index idx_tx_related on transactions(related_request_type, related_request_id);

-- ----------------------------------------------------------------------------
-- BÉNÉFICIAIRES
-- ----------------------------------------------------------------------------

create table beneficiaries (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references profiles(id) on delete cascade,
  label text not null,
  beneficiary_account_id uuid references accounts(id),
  beneficiary_iban text,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- VIREMENTS
-- ----------------------------------------------------------------------------

create table transfers (
  id uuid primary key default gen_random_uuid(),
  sender_account_id uuid not null references accounts(id),
  recipient_account_id uuid not null references accounts(id),
  amount numeric(14,2) not null,
  motif text,
  is_internal boolean not null default false, -- entre comptes du même client : pas de montant minimum
  status request_status not null default 'pending',
  requires_admin_override boolean not null default false, -- ferait passer l'émetteur sous le solde minimum
  admin_authorized_by uuid references profiles(id),
  requested_at timestamptz not null default now(),
  processing_by uuid references profiles(id),
  processing_at timestamptz,
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  decision_note text,
  resulting_transaction_id uuid references transactions(id)
);

create index idx_transfers_status on transfers(status);
create index idx_transfers_sender on transfers(sender_account_id);
create index idx_transfers_recipient on transfers(recipient_account_id);

-- ----------------------------------------------------------------------------
-- LINGOTS D'OR
-- ----------------------------------------------------------------------------

create table gold_bars (
  id uuid primary key default gen_random_uuid(),
  serial_number text not null unique,
  weight_grams numeric(10,2) not null,
  status gold_bar_status not null default 'in_vault',
  location text not null default 'Coffre central BNW-VLT-1924',
  owner_client_id uuid references profiles(id), -- null = propriété de la banque
  minted_by uuid references profiles(id),
  minted_at timestamptz not null default now(),
  notes text
);

create index idx_gold_owner on gold_bars(owner_client_id);
create index idx_gold_status on gold_bars(status);

create table gold_bank_purchase_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references profiles(id),
  gold_bar_id uuid not null references gold_bars(id),
  price numeric(14,2) not null,
  status request_status not null default 'pending',
  requested_at timestamptz not null default now(),
  processing_by uuid references profiles(id),
  processing_at timestamptz,
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  resulting_transaction_id uuid references transactions(id)
);

create table gold_market_listings (
  id uuid primary key default gen_random_uuid(),
  seller_client_id uuid not null references profiles(id),
  gold_bar_id uuid not null references gold_bars(id),
  listed_price numeric(14,2) not null,
  status text not null default 'active' check (status in ('active','sold','cancelled')),
  created_at timestamptz not null default now(),
  cancelled_at timestamptz
);

create table gold_market_purchase_requests (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references gold_market_listings(id),
  buyer_client_id uuid not null references profiles(id),
  status request_status not null default 'pending',
  requested_at timestamptz not null default now(),
  processing_by uuid references profiles(id),
  processing_at timestamptz,
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  resulting_transaction_id uuid references transactions(id)
);

-- ----------------------------------------------------------------------------
-- COFFRES-FORTS
-- ----------------------------------------------------------------------------

create table safe_deposit_boxes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  branch text not null default 'Agence centrale',
  annual_fee numeric(14,2) not null,
  status safe_status not null default 'available',
  client_id uuid references profiles(id),
  rented_since date
);

create table safe_rental_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references profiles(id),
  safe_box_id uuid references safe_deposit_boxes(id), -- attribué au traitement
  status request_status not null default 'pending',
  appointment_at timestamptz,
  appointment_location text,
  requested_at timestamptz not null default now(),
  processing_by uuid references profiles(id),
  processing_at timestamptz,
  confirmed_by uuid references profiles(id),
  confirmed_at timestamptz,
  resulting_transaction_id uuid references transactions(id)
);

-- ----------------------------------------------------------------------------
-- PRÊTS PROFESSIONNELS
-- ----------------------------------------------------------------------------

create table loans (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references profiles(id),
  requested_amount numeric(14,2) not null,
  purpose text,
  term_months int not null,
  interest_rate numeric(6,4), -- taux figé à l'approbation (snapshot de economic_settings.loan_rate)
  status loan_status not null default 'pending',
  requires_admin_override boolean not null default false,
  outstanding_balance numeric(14,2) not null default 0,
  requested_at timestamptz not null default now(),
  employee_reviewed_by uuid references profiles(id),
  employee_reviewed_at timestamptz,
  admin_decided_by uuid references profiles(id),
  admin_decided_at timestamptz,
  decision_note text,
  disbursed_at timestamptz,
  disbursement_account_id uuid references accounts(id),
  disbursement_transaction_id uuid references transactions(id),
  closed_at timestamptz
);

create table loan_schedules (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references loans(id) on delete cascade,
  installment_number int not null,
  due_date date not null,
  amount_due numeric(14,2) not null,
  principal numeric(14,2) not null,
  interest numeric(14,2) not null,
  penalty_applied numeric(14,2) not null default 0,
  status installment_status not null default 'pending',
  paid_at timestamptz,
  resulting_transaction_id uuid references transactions(id),
  unique (loan_id, installment_number)
);

create index idx_loan_schedules_due on loan_schedules(due_date) where status = 'pending';

-- ----------------------------------------------------------------------------
-- SUPPORT (ticket parent + messages)
-- ----------------------------------------------------------------------------

create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references profiles(id),
  subject text not null,
  category text,
  status ticket_status not null default 'open',
  assigned_to uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references support_tickets(id) on delete cascade,
  author_id uuid not null references profiles(id),
  author_role user_role not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index idx_support_messages_ticket on support_messages(ticket_id, created_at);

-- ----------------------------------------------------------------------------
-- CONSULTING PREMIUM
-- ----------------------------------------------------------------------------

create table consulting_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references profiles(id),
  message text,
  status text not null default 'pending' check (status in ('pending','assigned','closed')),
  assigned_advisor_id uuid references profiles(id),
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- DEMANDES D'ADHÉSION (prospect → client) & OUVERTURES GUICHET
-- ----------------------------------------------------------------------------

create table membership_requests (
  id uuid primary key default gen_random_uuid(),
  applicant_id uuid not null references profiles(id), -- profil role='prospect'
  requested_account_type text references account_types(code),
  initial_deposit numeric(14,2) not null default 0,
  motivation text,
  status request_status not null default 'pending',
  requires_admin_override boolean not null default false,
  processing_by uuid references profiles(id),
  processing_at timestamptz,
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  created_account_id uuid references accounts(id),
  created_at timestamptz not null default now()
);

create table manual_account_openings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references profiles(id), -- rempli une fois le compte/profil créés
  requested_by uuid not null references profiles(id), -- l'employé/admin au guichet
  display_name text not null,
  account_type text not null references account_types(code),
  initial_deposit numeric(14,2) not null default 0,
  status request_status not null default 'pending',
  requires_admin_override boolean not null default false,
  admin_authorized_by uuid references profiles(id),
  created_account_id uuid references accounts(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

-- ----------------------------------------------------------------------------
-- FILE CLIENTS (guichet)
-- ----------------------------------------------------------------------------

create table branch_queue (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references profiles(id),
  visitor_name text,
  reason text,
  status text not null default 'waiting' check (status in ('waiting','in_service','done','cancelled')),
  joined_at timestamptz not null default now(),
  called_by uuid references profiles(id),
  called_at timestamptz,
  closed_at timestamptz
);

-- ----------------------------------------------------------------------------
-- ALERTES FRAUDE
-- ----------------------------------------------------------------------------

create table fraud_rules (
  key text primary key,
  label text not null,
  enabled boolean not null default true,
  threshold_config jsonb not null default '{}',
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now()
);

create table fraud_alerts (
  id uuid primary key default gen_random_uuid(),
  origin text not null default 'auto' check (origin in ('auto','manual')),
  rule_key text references fraud_rules(key),
  severity text not null default 'medium' check (severity in ('low','medium','high')),
  related_client_id uuid references profiles(id),
  related_account_id uuid references accounts(id),
  related_transaction_id uuid references transactions(id),
  description text not null,
  status text not null default 'open' check (status in ('open','reviewed','dismissed')),
  created_by uuid references profiles(id), -- null si automatique
  created_at timestamptz not null default now(),
  reviewed_by uuid references profiles(id),
  reviewed_at timestamptz
);

-- ----------------------------------------------------------------------------
-- RAPPORTS DE CAISSE
-- ----------------------------------------------------------------------------

create table cashier_reports (
  id uuid primary key default gen_random_uuid(),
  report_date date not null unique,
  opening_balance numeric(14,2) not null,
  total_in numeric(14,2) not null default 0,
  total_out numeric(14,2) not null default 0,
  closing_balance numeric(14,2) not null,
  generated_at timestamptz not null default now(),
  adjusted_by uuid references profiles(id),
  adjusted_at timestamptz,
  adjustment_amount numeric(14,2) not null default 0,
  adjustment_note text
);

-- ----------------------------------------------------------------------------
-- MASQUAGE GÉNÉRIQUE PAR INTERFACE
-- ----------------------------------------------------------------------------

create table visibility_masks (
  id uuid primary key default gen_random_uuid(),
  target_type visibility_target not null,
  target_id uuid not null,
  hidden_from_interfaces app_interface[] not null default '{}',
  reason text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  unique (target_type, target_id)
);

comment on table visibility_masks is 'Table de correspondance générique : pour un compte ou une transaction donné(e), sur quelle(s) interface(s) il/elle doit rester invisible.';

-- ----------------------------------------------------------------------------
-- NOTIFICATIONS
-- ----------------------------------------------------------------------------

create table notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references profiles(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  link text,
  is_read boolean not null default false,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index idx_notifications_recipient on notifications(recipient_id, is_read, created_at desc);

-- ----------------------------------------------------------------------------
-- AUDIT & CONNEXIONS
-- ----------------------------------------------------------------------------

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references profiles(id),
  actor_role user_role,
  action text not null,
  target_type text,
  target_id uuid,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index idx_audit_actor on audit_log(actor_id, created_at desc);

create table login_log (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references profiles(id),
  username_attempted text,
  success boolean not null,
  user_agent text,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- IRS — comptes staff Hurricane FA (accès binaire, hors permissions modulables)
-- ----------------------------------------------------------------------------

create table irs_accounts (
  profile_id uuid primary key references profiles(id) on delete cascade,
  granted_by uuid references profiles(id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- ----------------------------------------------------------------------------
-- CONTENU DU SITE (CMS générique — accueil public + interfaces internes)
-- ----------------------------------------------------------------------------

create table site_content (
  id uuid primary key default gen_random_uuid(),
  area app_interface not null,
  section_key text not null, -- 'hero','key_stats','city_news','top10','quote','project_showcase','testimonial','service_catalog',...
  content jsonb not null default '{}',
  sort_order int not null default 0,
  is_active boolean not null default true,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index idx_site_content_lookup on site_content(area, section_key, sort_order);

-- ----------------------------------------------------------------------------
-- SYSTÈME (maintenance, bannière — via economic_settings pour rester générique)
-- ----------------------------------------------------------------------------
-- maintenance_mode et announcement_banner sont des lignes de economic_settings
-- (category='system') plutôt que des colonnes dédiées : cohérent avec le
-- principe "rien de figé en dur".

-- ----------------------------------------------------------------------------
-- updated_at automatique
-- ----------------------------------------------------------------------------

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_profiles_updated before update on profiles for each row execute function set_updated_at();
create trigger trg_support_tickets_updated before update on support_tickets for each row execute function set_updated_at();

-- ============================================================================
-- NEWPAD — Migration 0001c : colonnes manquantes pour tracer l'autorisation
-- admin explicite (solde minimum) sur les lingots et l'adhésion.
-- ============================================================================

alter table membership_requests add column if not exists admin_authorized_by uuid references profiles(id);
alter table gold_bank_purchase_requests add column if not exists admin_authorized_by uuid references profiles(id);
alter table gold_market_purchase_requests add column if not exists admin_authorized_by uuid references profiles(id);

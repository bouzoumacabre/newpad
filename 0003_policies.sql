-- ============================================================================
-- NEWPAD — Migration 0003 : accès IRS (lecture seule dédiée) + RLS
-- ============================================================================
-- Principe retenu : toutes les tables ont RLS activé. Les mutations d'argent
-- passent exclusivement par les fonctions SECURITY DEFINER de 0002/0002b
-- (aucune policy INSERT/UPDATE n'est créée pour ces opérations : sans policy,
-- RLS refuse par défaut, y compris pour l'admin — l'admin utilise donc lui
-- aussi ces fonctions, ce qui garantit la journalisation systématique).
-- Le rôle IRS n'a AUCUNE policy sur les tables de base (deny by default) :
-- il lit exclusivement via les fonctions irs_* ci-dessous, qui appliquent le
-- masquage par interface et ne contiennent aucune capacité d'écriture.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- FONCTIONS DE LECTURE DÉDIÉES IRS
-- ----------------------------------------------------------------------------

create or replace function irs_stats() returns jsonb
language plpgsql stable security definer as $$
begin
  if not is_irs() then raise exception 'Réservé au rôle IRS'; end if;
  return jsonb_build_object(
    'clients_total', (select count(*) from profiles where role = 'client'),
    'accounts_total', (select count(*) from accounts a where not is_masked_for('account', a.id, 'irs')),
    'transactions_total', (select count(*) from transactions t where not is_masked_for('transaction', t.id, 'irs')),
    'gold_weight_kg', (select coalesce(round(sum(weight_grams)/1000, 2), 0) from gold_bars)
  );
end;
$$;

create or replace function irs_list_clients(p_search text default null, p_limit int default 100) returns table(id uuid, display_name text, username text, client_since date, trust_score numeric)
language plpgsql stable security definer as $$
begin
  if not is_irs() then raise exception 'Réservé au rôle IRS'; end if;
  return query
  select p.id, p.display_name, p.username, p.client_since, p.trust_score
  from profiles p
  where p.role = 'client'
    and (p_search is null or p.display_name ilike '%'||p_search||'%' or p.username ilike '%'||p_search||'%')
  order by p.display_name
  limit p_limit;
end;
$$;

create or replace function irs_list_accounts(p_search text default null, p_limit int default 100) returns table(id uuid, owner_name text, account_type text, iban text, balance numeric, status account_status)
language plpgsql stable security definer as $$
begin
  if not is_irs() then raise exception 'Réservé au rôle IRS'; end if;
  return query
  select a.id, p.display_name, a.account_type, a.iban, a.balance, a.status
  from accounts a
  join profiles p on p.id = a.client_id
  where not is_masked_for('account', a.id, 'irs') and a.is_bank_treasury = false
    and (p_search is null or p.display_name ilike '%'||p_search||'%' or a.iban ilike '%'||p_search||'%')
  order by a.opened_at desc
  limit p_limit;
end;
$$;

create or replace function irs_list_transactions(p_search text default null, p_limit int default 200) returns table(
  id uuid, tx_type text, status request_status, amount numeric, fee_amount numeric,
  from_label text, to_label text, description text, created_at timestamptz
)
language plpgsql stable security definer as $$
begin
  if not is_irs() then raise exception 'Réservé au rôle IRS'; end if;
  return query
  select t.id, t.tx_type, t.status, t.amount, t.fee_amount,
    coalesce(pf.display_name, case when af.is_bank_treasury then 'Newman Bank (trésorerie)' else null end, 'Externe'),
    coalesce(pt.display_name, case when at_.is_bank_treasury then 'Newman Bank (trésorerie)' else null end, 'Externe'),
    t.description, t.created_at
  from transactions t
  left join accounts af on af.id = t.from_account_id
  left join accounts at_ on at_.id = t.to_account_id
  left join profiles pf on pf.id = af.client_id
  left join profiles pt on pt.id = at_.client_id
  where not is_masked_for('transaction', t.id, 'irs')
    and (p_search is null or t.description ilike '%'||p_search||'%' or pf.display_name ilike '%'||p_search||'%' or pt.display_name ilike '%'||p_search||'%')
  order by t.created_at desc
  limit p_limit;
end;
$$;

create or replace function irs_list_gold_bars(p_limit int default 200) returns table(id uuid, serial_number text, weight_grams numeric, status gold_bar_status, owner_name text)
language plpgsql stable security definer as $$
begin
  if not is_irs() then raise exception 'Réservé au rôle IRS'; end if;
  return query
  select g.id, g.serial_number, g.weight_grams, g.status, p.display_name
  from gold_bars g left join profiles p on p.id = g.owner_client_id
  order by g.minted_at desc limit p_limit;
end;
$$;

-- ----------------------------------------------------------------------------
-- ACTIVATION RLS — toutes les tables
-- ----------------------------------------------------------------------------

alter table profiles enable row level security;
alter table feature_registry enable row level security;
alter table permission_grants enable row level security;
alter table economic_settings enable row level security;
alter table client_setting_overrides enable row level security;
alter table client_categories enable row level security;
alter table client_category_links enable row level security;
alter table account_types enable row level security;
alter table accounts enable row level security;
alter table transactions enable row level security;
alter table beneficiaries enable row level security;
alter table transfers enable row level security;
alter table gold_bars enable row level security;
alter table gold_bank_purchase_requests enable row level security;
alter table gold_market_listings enable row level security;
alter table gold_market_purchase_requests enable row level security;
alter table safe_deposit_boxes enable row level security;
alter table safe_rental_requests enable row level security;
alter table loans enable row level security;
alter table loan_schedules enable row level security;
alter table support_tickets enable row level security;
alter table support_messages enable row level security;
alter table consulting_requests enable row level security;
alter table membership_requests enable row level security;
alter table manual_account_openings enable row level security;
alter table branch_queue enable row level security;
alter table fraud_rules enable row level security;
alter table fraud_alerts enable row level security;
alter table cashier_reports enable row level security;
alter table visibility_masks enable row level security;
alter table notifications enable row level security;
alter table audit_log enable row level security;
alter table login_log enable row level security;
alter table irs_accounts enable row level security;
alter table site_content enable row level security;
alter table documents enable row level security;

-- ----------------------------------------------------------------------------
-- PROFILES
-- ----------------------------------------------------------------------------

create policy profiles_select on profiles for select
  using (id = auth.uid() or is_staff());

create policy profiles_self_update on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());
-- NB: un déclencheur (0004) empêche un self-update de modifier role/status/trust_score.

create policy profiles_admin_all on profiles for all
  using (is_admin()) with check (is_admin());

-- ----------------------------------------------------------------------------
-- REGISTRE DE FONCTIONNALITÉS & PERMISSIONS
-- ----------------------------------------------------------------------------

create policy feature_registry_select on feature_registry for select using (auth.uid() is not null);
create policy feature_registry_admin_write on feature_registry for insert with check (is_admin());
create policy feature_registry_admin_update on feature_registry for update using (is_admin()) with check (is_admin());
create policy feature_registry_admin_delete on feature_registry for delete using (is_admin());

create policy permission_grants_select on permission_grants for select using (account_id = auth.uid() or is_staff());
create policy permission_grants_admin_write on permission_grants for insert with check (is_admin());
create policy permission_grants_admin_update on permission_grants for update using (is_admin()) with check (is_admin());
create policy permission_grants_admin_delete on permission_grants for delete using (is_admin());

-- ----------------------------------------------------------------------------
-- PARAMÈTRES ÉCONOMIQUES
-- ----------------------------------------------------------------------------

create policy economic_settings_select on economic_settings for select using (auth.uid() is not null);
create policy economic_settings_admin_write on economic_settings for insert with check (is_admin());
create policy economic_settings_admin_update on economic_settings for update using (is_admin()) with check (is_admin());

create policy client_overrides_select on client_setting_overrides for select using (client_id = auth.uid() or is_staff());
create policy client_overrides_admin_write on client_setting_overrides for insert with check (is_admin());
create policy client_overrides_admin_update on client_setting_overrides for update using (is_admin()) with check (is_admin());
create policy client_overrides_admin_delete on client_setting_overrides for delete using (is_admin());

-- ----------------------------------------------------------------------------
-- CATÉGORIES DE CLIENTÈLE
-- ----------------------------------------------------------------------------

create policy client_categories_select on client_categories for select using (is_staff());
create policy client_categories_staff_write on client_categories for insert with check (is_staff());
create policy client_categories_staff_update on client_categories for update using (is_staff()) with check (is_staff());
create policy client_categories_admin_delete on client_categories for delete using (is_admin());

create policy category_links_select on client_category_links for select using (is_staff());
create policy category_links_staff_write on client_category_links for insert with check (is_staff());
create policy category_links_staff_delete on client_category_links for delete using (is_staff());

-- ----------------------------------------------------------------------------
-- TYPES DE COMPTES
-- ----------------------------------------------------------------------------

create policy account_types_select on account_types for select using (auth.uid() is not null);
create policy account_types_admin_write on account_types for insert with check (is_admin());
create policy account_types_admin_update on account_types for update using (is_admin()) with check (is_admin());

-- ----------------------------------------------------------------------------
-- COMPTES (accounts) — lecture seule via RLS ; toute écriture passe par les
-- fonctions SECURITY DEFINER (accounts n'a donc aucune policy insert/update
-- directe pour les rôles non-admin ; l'admin lui-même n'a pas de policy
-- update générale afin qu'aucun solde ne puisse être modifié à la main).
-- ----------------------------------------------------------------------------

create policy accounts_select on accounts for select
  using ((client_id = auth.uid() or is_staff()) and visible_for_current_role('account', id));

-- ----------------------------------------------------------------------------
-- TRANSACTIONS — lecture seule via RLS, écriture uniquement via fonctions
-- ----------------------------------------------------------------------------

create policy transactions_select on transactions for select
  using (
    visible_for_current_role('transaction', id)
    and (
      is_staff()
      or exists (select 1 from accounts a where a.id in (from_account_id, to_account_id) and a.client_id = auth.uid())
    )
  );

-- ----------------------------------------------------------------------------
-- BÉNÉFICIAIRES (carnet d'adresses — pas d'argent, CRUD direct client)
-- ----------------------------------------------------------------------------

create policy beneficiaries_select on beneficiaries for select using (client_id = auth.uid() or is_staff());
create policy beneficiaries_insert on beneficiaries for insert with check (client_id = auth.uid());
create policy beneficiaries_update on beneficiaries for update using (client_id = auth.uid()) with check (client_id = auth.uid());
create policy beneficiaries_delete on beneficiaries for delete using (client_id = auth.uid());

-- ----------------------------------------------------------------------------
-- VIREMENTS — lecture seule ; écriture via submit_transfer/claim_transfer/decide_transfer
-- ----------------------------------------------------------------------------

create policy transfers_select on transfers for select
  using (
    is_staff()
    or exists (select 1 from accounts a where a.id in (sender_account_id, recipient_account_id) and a.client_id = auth.uid())
  );

-- ----------------------------------------------------------------------------
-- LINGOTS D'OR
-- ----------------------------------------------------------------------------

create policy gold_bars_select on gold_bars for select using (auth.uid() is not null);
create policy gold_bars_admin_update on gold_bars for update using (is_admin()) with check (is_admin());
create policy gold_bars_admin_insert on gold_bars for insert with check (is_admin());

create policy gold_bank_requests_select on gold_bank_purchase_requests for select using (client_id = auth.uid() or is_staff());
create policy gold_market_listings_select on gold_market_listings for select using (auth.uid() is not null);
create policy gold_market_requests_select on gold_market_purchase_requests for select using (buyer_client_id = auth.uid() or is_staff() or exists (select 1 from gold_market_listings l where l.id = listing_id and l.seller_client_id = auth.uid()));

-- ----------------------------------------------------------------------------
-- COFFRES-FORTS
-- ----------------------------------------------------------------------------

create policy safe_boxes_select on safe_deposit_boxes for select using (auth.uid() is not null);
create policy safe_boxes_staff_write on safe_deposit_boxes for insert with check (is_staff());
create policy safe_boxes_staff_update on safe_deposit_boxes for update using (is_staff()) with check (is_staff());

create policy safe_requests_select on safe_rental_requests for select using (client_id = auth.uid() or is_staff());

-- ----------------------------------------------------------------------------
-- PRÊTS
-- ----------------------------------------------------------------------------

create policy loans_select on loans for select using (client_id = auth.uid() or is_staff());
create policy loan_schedules_select on loan_schedules for select
  using (is_staff() or exists (select 1 from loans l where l.id = loan_id and l.client_id = auth.uid()));

-- ----------------------------------------------------------------------------
-- SUPPORT
-- ----------------------------------------------------------------------------

create policy support_tickets_select on support_tickets for select using (client_id = auth.uid() or is_staff());
create policy support_messages_select on support_messages for select
  using (is_staff() or exists (select 1 from support_tickets t where t.id = ticket_id and t.client_id = auth.uid()));

-- ----------------------------------------------------------------------------
-- CONSULTING PREMIUM
-- ----------------------------------------------------------------------------

create policy consulting_select on consulting_requests for select using (client_id = auth.uid() or is_staff());
create policy consulting_insert on consulting_requests for insert with check (client_id = auth.uid());

-- ----------------------------------------------------------------------------
-- ADHÉSION / OUVERTURE GUICHET
-- ----------------------------------------------------------------------------

create policy membership_select on membership_requests for select using (applicant_id = auth.uid() or is_staff());
create policy membership_insert on membership_requests for insert with check (applicant_id = auth.uid());

create policy manual_opening_select on manual_account_openings for select using (is_staff() or client_id = auth.uid());
create policy manual_opening_insert on manual_account_openings for insert with check (is_staff());

-- ----------------------------------------------------------------------------
-- FILE CLIENTS
-- ----------------------------------------------------------------------------

create policy branch_queue_select on branch_queue for select using (is_staff() or client_id = auth.uid());
create policy branch_queue_insert on branch_queue for insert with check (is_staff() or client_id = auth.uid());
create policy branch_queue_update on branch_queue for update using (is_staff()) with check (is_staff());

-- ----------------------------------------------------------------------------
-- FRAUDE
-- ----------------------------------------------------------------------------

create policy fraud_rules_select on fraud_rules for select using (is_staff());
create policy fraud_rules_admin_write on fraud_rules for insert with check (is_admin());
create policy fraud_rules_admin_update on fraud_rules for update using (is_admin()) with check (is_admin());

create policy fraud_alerts_select on fraud_alerts for select using (is_staff());
create policy fraud_alerts_staff_update on fraud_alerts for update using (is_staff()) with check (is_staff());

-- ----------------------------------------------------------------------------
-- CAISSE
-- ----------------------------------------------------------------------------

create policy cashier_reports_select on cashier_reports for select using (is_staff());

-- ----------------------------------------------------------------------------
-- MASQUAGE
-- ----------------------------------------------------------------------------

create policy visibility_masks_select on visibility_masks for select using (is_admin());
create policy visibility_masks_admin_write on visibility_masks for insert with check (is_admin());
create policy visibility_masks_admin_update on visibility_masks for update using (is_admin()) with check (is_admin());
create policy visibility_masks_admin_delete on visibility_masks for delete using (is_admin());

-- ----------------------------------------------------------------------------
-- NOTIFICATIONS
-- ----------------------------------------------------------------------------

create policy notifications_select on notifications for select using (recipient_id = auth.uid());

-- ----------------------------------------------------------------------------
-- AUDIT & CONNEXIONS
-- ----------------------------------------------------------------------------

create policy audit_log_select on audit_log for select using (is_staff());
create policy login_log_select on login_log for select using (is_admin());

-- ----------------------------------------------------------------------------
-- IRS ACCOUNTS (gestion des accès staff Hurricane FA)
-- ----------------------------------------------------------------------------

create policy irs_accounts_admin_all on irs_accounts for all using (is_admin()) with check (is_admin());

-- ----------------------------------------------------------------------------
-- CONTENU DU SITE (CMS)
-- ----------------------------------------------------------------------------

create policy site_content_select_public on site_content for select using (true); -- lu aussi par les visiteurs non connectés (accueil public)
create policy site_content_admin_write on site_content for insert with check (is_admin());
create policy site_content_admin_update on site_content for update using (is_admin()) with check (is_admin());
create policy site_content_admin_delete on site_content for delete using (is_admin());

-- ----------------------------------------------------------------------------
-- DOCUMENTS
-- ----------------------------------------------------------------------------

create policy documents_select on documents for select using (client_id = auth.uid() or is_staff());
create policy documents_staff_insert on documents for insert with check (is_staff());

-- ============================================================================
-- NEWPAD — Migration 0012
-- ============================================================================
-- Trois correctifs/évolutions demandés :
--
-- 1. Nettoyage des liens de notification déjà en base créés avant la
--    migration 0010 (qui avait corrigé les fonctions d'émission, mais pas les
--    lignes déjà existantes) — ex: '/admin/operations/loans' au lieu de
--    '/admin/loans'. Un clic sur une notification avec un lien pré-0010
--    tombait sur une route inexistante → renvoi silencieux vers l'accueil par
--    le routeur.
--
-- 2. Frais de gestion de compte en pourcentage du solde plutôt qu'un montant
--    fixe (la fréquence était déjà pilotable depuis /admin/economic-settings
--    via `account_fee_frequency_days`, ça n'a pas changé).
--
-- 3. Mise en vente de lingots (marché de revente) depuis le côté admin, pour
--    le stock appartenant à la banque — jusqu'ici `create_market_listing`
--    n'acceptait que le propriétaire client lui-même comme vendeur.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Nettoyage des liens de notification hérités du routing pré-0010
-- ----------------------------------------------------------------------------
update notifications
set link = regexp_replace(link, '^/(admin|employee)/operations/', '/\1/')
where link ~ '^/(admin|employee)/operations/';

-- ----------------------------------------------------------------------------
-- 2. Frais de gestion en pourcentage du solde
-- ----------------------------------------------------------------------------
update economic_settings
set key = 'account_fee_percent',
    label = 'Frais de gestion (% du solde du compte, prélevé selon la fréquence ci-dessous)',
    value_type = 'percent',
    value = jsonb_build_object('amount', 1)
where key = 'account_fee_amount';

create or replace function charge_account_fees() returns void
language plpgsql security definer as $$
declare
  acc record;
  v_fee_pct numeric;
  v_fee numeric;
  v_frequency_days int;
  v_bank_account uuid;
  v_tx_id uuid;
  v_last_charged timestamptz;
begin
  v_fee_pct := coalesce(get_setting_numeric('account_fee_percent'), 0);
  v_frequency_days := coalesce((get_setting('account_fee_frequency_days')->>'amount')::int, 30);
  if v_fee_pct <= 0 then return; end if;
  v_bank_account := bank_treasury_account_id();

  for acc in select * from accounts where status = 'active' and is_bank_treasury = false loop
    select max(created_at) into v_last_charged from transactions
    where tx_type = 'fee_management' and from_account_id = acc.id;

    if v_last_charged is not null and v_last_charged > now() - (v_frequency_days || ' days')::interval then
      continue;
    end if;

    -- Pas de frais sur un compte à zéro ou déjà négatif (un pourcentage d'un
    -- solde négatif rembourserait le client au lieu de le facturer).
    if acc.balance <= 0 then continue; end if;
    v_fee := round(acc.balance * v_fee_pct / 100, 2);
    if v_fee <= 0 then continue; end if;

    perform _adjust_balance(acc.id, -v_fee);
    perform _adjust_balance(v_bank_account, v_fee);

    insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
    values ('fee_management', 'validated', acc.id, v_bank_account, v_fee, 'Frais de gestion de compte (' || v_fee_pct || '%)', null)
    returning id into v_tx_id;

    perform notify(acc.client_id, 'fee_charged', 'Frais de gestion de compte prélevés', v_fee || ' $ (' || v_fee_pct || '% du solde)', '/client/accounts');

    if (select balance from accounts where id = acc.id) < 0 then
      perform notify(acc.client_id, 'account_negative', 'Votre compte est passé en négatif', null, '/client/accounts');
      perform notify_all_staff('account_negative', 'Compte client passé en négatif suite à des frais', acc.client_id::text, '/employee/clients');
    end if;

    if client_total_balance(acc.client_id) < coalesce(get_setting_numeric('min_client_balance', acc.client_id), 1000000) then
      perform notify_all_staff('below_minimum', 'Client sous le solde minimum après frais', acc.client_id::text, '/admin/clients', true);
    end if;
  end loop;
end;
$$;

-- ----------------------------------------------------------------------------
-- 3. Mise en vente de lingots côté admin (stock banque) sur le marché
-- ----------------------------------------------------------------------------

-- Un lingot mis en vente par la banque elle-même (pas par un client) n'a pas
-- de vendeur-client : owner_client_id est déjà nullable sur gold_bars pour ce
-- cas (stock banque), il faut donc que gold_market_listings l'accepte aussi.
alter table gold_market_listings alter column seller_client_id drop not null;

create or replace function admin_create_market_listing(p_gold_bar_id uuid, p_price numeric) returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_bar gold_bars%rowtype;
  v_min numeric; v_max numeric;
  v_id uuid;
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;

  select * into v_bar from gold_bars where id = p_gold_bar_id and status = 'in_vault';
  if v_bar is null then raise exception 'Lingot indisponible pour la mise en vente (doit être "in_vault")'; end if;

  v_min := coalesce(get_setting_numeric('gold_listing_min_price'), 0);
  v_max := coalesce(get_setting_numeric('gold_listing_max_price'), 999999999);
  if p_price < v_min or p_price > v_max then
    raise exception 'Le prix doit être compris entre % $ et % $', v_min, v_max;
  end if;

  insert into gold_market_listings (seller_client_id, gold_bar_id, listed_price)
  values (v_bar.owner_client_id, p_gold_bar_id, p_price)
  returning id into v_id;

  update gold_bars set status = 'listed' where id = p_gold_bar_id;
  perform log_audit('admin_create_market_listing', 'gold_market_listings', v_id, jsonb_build_object('gold_bar_id', p_gold_bar_id, 'price', p_price));
  return v_id;
end;
$function$;

create or replace function admin_cancel_market_listing(p_listing_id uuid) returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_listing gold_market_listings%rowtype;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into v_listing from gold_market_listings where id = p_listing_id and status = 'active';
  if v_listing is null then raise exception 'Annonce introuvable ou déjà close'; end if;

  update gold_market_listings set status = 'cancelled', cancelled_at = now() where id = p_listing_id;
  update gold_bars set status = 'in_vault' where id = v_listing.gold_bar_id and status = 'listed';
  perform log_audit('admin_cancel_market_listing', 'gold_market_listings', p_listing_id, '{}'::jsonb);
end;
$function$;

-- decide_market_purchase : gère désormais le cas d'un vendeur nul (lingot mis
-- en vente par la banque) — le prix intégral revient alors à la trésorerie,
-- sans commission (la banque ne se facture pas à elle-même), et on n'essaie
-- plus de notifier un "vendeur" qui n'existe pas (recipient_id est NOT NULL
-- sur notifications, un appel avec null aurait fait échouer toute la
-- transaction d'approbation).
CREATE OR REPLACE FUNCTION public.decide_market_purchase(p_request_id uuid, p_approve boolean, p_note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  r gold_market_purchase_requests%rowtype;
  l gold_market_listings%rowtype;
  v_buyer_account uuid;
  v_seller_account uuid;
  v_bank_account uuid;
  v_fee_rate numeric;
  v_fee numeric;
  v_tx_id uuid;
  v_min_balance numeric;
  v_new_total numeric;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into r from gold_market_purchase_requests where id = p_request_id and status in ('pending','processing') for update;
  if r is null then raise exception 'Demande introuvable'; end if;
  select * into l from gold_market_listings where id = r.listing_id;

  if not p_approve then
    update gold_market_purchase_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now() where id = p_request_id;
    perform notify(r.buyer_client_id, 'gold_market_rejected', 'Achat marché refusé', p_note, '/client/gold/market');
    perform log_audit('reject_gold_market_purchase', 'gold_market_purchase_requests', p_request_id, jsonb_build_object(
      'buyer', (select display_name from profiles where id = r.buyer_client_id), 'price', l.listed_price));
    return;
  end if;

  v_min_balance := coalesce(get_setting_numeric('min_client_balance', r.buyer_client_id), 1000000);
  v_new_total := client_total_balance(r.buyer_client_id) - l.listed_price;
  if v_new_total < v_min_balance and not is_admin() then
    update gold_market_purchase_requests set status = 'pending', processing_by = auth.uid(), processing_at = now() where id = p_request_id;
    perform notify_all_staff('gold_market_needs_admin', 'Achat marché sous le solde minimum — autorisation admin requise', l.listed_price || ' $', '/admin/gold', true);
    return;
  end if;

  select id into v_buyer_account from accounts where client_id = r.buyer_client_id and status='active' order by is_bank_treasury, opened_at limit 1;
  v_bank_account := bank_treasury_account_id();

  perform _adjust_balance(v_buyer_account, -l.listed_price);

  if l.seller_client_id is null then
    -- Lingot mis en vente directement par la banque (admin_create_market_listing).
    v_fee := 0;
    perform _adjust_balance(v_bank_account, l.listed_price);
  else
    select id into v_seller_account from accounts where client_id = l.seller_client_id and status='active' order by is_bank_treasury, opened_at limit 1;
    v_fee_rate := coalesce((get_setting('marketplace_commission_rate')->>'amount')::numeric, 0);
    v_fee := round(l.listed_price * v_fee_rate / 100, 2);
    perform _adjust_balance(v_seller_account, l.listed_price - v_fee);
    perform _adjust_balance(v_bank_account, v_fee);
  end if;

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, fee_amount, description, related_request_type, related_request_id, created_by)
  values ('gold_purchase_market', 'validated', v_buyer_account, v_seller_account, l.listed_price, v_fee, 'Achat marché lingot ' || l.gold_bar_id, 'gold_market_purchase_requests', r.id, auth.uid())
  returning id into v_tx_id;

  update gold_bars set status = 'sold', owner_client_id = r.buyer_client_id where id = l.gold_bar_id;
  update gold_market_listings set status = 'sold' where id = l.id;
  update gold_market_purchase_requests set status = 'validated', decided_by = auth.uid(), decided_at = now(), resulting_transaction_id = v_tx_id,
    admin_authorized_by = case when is_admin() and v_new_total < v_min_balance then auth.uid() else null end
  where id = p_request_id;

  perform notify(r.buyer_client_id, 'gold_market_validated', 'Achat marché validé', l.listed_price || ' $', '/client/gold/market');
  if l.seller_client_id is not null then
    perform notify(l.seller_client_id, 'gold_market_sold', 'Votre lingot a été vendu', (l.listed_price - v_fee) || ' $', '/client/gold/market');
  end if;
  perform log_audit('approve_gold_market_purchase', 'gold_market_purchase_requests', p_request_id, jsonb_build_object(
    'buyer', (select display_name from profiles where id = r.buyer_client_id),
    'seller', (select display_name from profiles where id = l.seller_client_id),
    'price', l.listed_price, 'fee', v_fee));
end;
$function$;

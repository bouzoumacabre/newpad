-- ============================================================================
-- NEWPAD — Migration 0025 : double vente sur le marché de l'or, découvert
--                           à l'achat, achat de son propre lingot
-- ============================================================================
-- Audit fonctionnalité par fonctionnalité — étape 4 : lingots d'or et marché
-- de revente.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. DOUBLE VENTE : un même lingot pouvait être vendu plusieurs fois
-- ----------------------------------------------------------------------------
-- `submit_market_purchase` ne vérifie que l'existence d'une annonce active :
-- rien n'empêche dix clients de déposer une demande sur la MÊME annonce, et
-- rien ne les marque comme concurrentes.
--
-- `decide_market_purchase` passe bien l'annonce à 'sold' en fin de course,
-- mais ne vérifie JAMAIS qu'elle ne l'est pas déjà. Enchaînement complet :
--
--   1. Le client A met son lingot en vente à 500 000 $.
--   2. B, C et D déposent chacun une demande d'achat — toutes acceptées.
--   3. Le personnel valide celle de B : B paie 500 000, A reçoit 495 000,
--      le lingot passe à B, l'annonce passe à 'sold'.
--   4. Les demandes de C et D restent « en attente » dans la file du
--      personnel, et rien ne les bloque.
--   5. Le personnel valide celle de C : C paie 500 000 $, A encaisse
--      495 000 $ une SECONDE fois, et le lingot change de propriétaire —
--      B a payé et n'a plus rien.
--
-- La monnaie reste conservée transaction par transaction, mais la MARCHANDISE
-- non : un seul lingot, deux acheteurs débités. Le vendeur est payé deux fois
-- pour un bien qu'il ne possédait qu'une fois.
--
-- Trois verrous posés :
--   - l'annonce doit toujours être active au moment de décider ;
--   - le lingot doit toujours être en vente et appartenir au vendeur annoncé ;
--   - une fois la vente conclue, les demandes concurrentes sont refusées
--     automatiquement et leurs auteurs prévenus, plutôt que de rester
--     approuvables dans la file.
--
--
-- 2. DÉCOUVERT À L'ACHAT (même famille que le correctif 0023 sur les virements)
--
-- Ni l'achat à la banque ni l'achat sur le marché ne vérifiaient que le COMPTE
-- qui paie dispose de la somme. Le seul garde-fou est le solde minimum, qui
-- porte sur le TOTAL des comptes du client et que l'admin contourne. Un client
-- disposant de 2 000 000 répartis sur deux comptes pouvait donc acheter un
-- lingot à 1 000 000 payé depuis un compte n'en contenant que 100, ce compte
-- tombant à -999 900.
--
--
-- 3. ACHETER SON PROPRE LINGOT
--
-- Rien n'empêchait un client d'acheter sa propre annonce. L'opération n'a
-- aucun sens et ne fait que lui prélever la commission de marché. Même famille
-- que le virement d'un compte vers lui-même (correctif 0018).


create or replace function submit_market_purchase(p_listing_id uuid)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  l gold_market_listings%rowtype;
  v_id uuid;
begin
  select * into l from gold_market_listings where id = p_listing_id and status = 'active';
  if l is null then raise exception 'Annonce indisponible'; end if;

  -- CORRECTIF 0025 §3
  if l.seller_client_id is not null and l.seller_client_id = auth.uid() then
    raise exception 'Vous ne pouvez pas acheter votre propre lingot. Utilisez « Retirer » pour annuler la mise en vente.';
  end if;

  -- Une seule demande ouverte par acheteur et par annonce.
  if exists (
    select 1 from gold_market_purchase_requests
    where listing_id = p_listing_id
      and buyer_client_id = auth.uid()
      and status in ('pending', 'processing')
  ) then
    raise exception 'Vous avez déjà une demande en cours sur ce lingot.';
  end if;

  insert into gold_market_purchase_requests (listing_id, buyer_client_id)
  values (p_listing_id, auth.uid())
  returning id into v_id;

  perform notify_all_staff('gold_market_request', 'Nouvelle transaction marché de revente', null, '/employee/gold');
  return v_id;
end;
$function$;


create or replace function decide_market_purchase(p_request_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r gold_market_purchase_requests%rowtype;
  l gold_market_listings%rowtype;
  v_bar gold_bars%rowtype;
  v_buyer_account uuid;
  v_buyer_balance numeric;
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

  -- Verrou sur l'annonce : deux validations simultanées ne peuvent pas
  -- s'entrelacer et vendre le lingot deux fois.
  select * into l from gold_market_listings where id = r.listing_id for update;

  if not p_approve then
    update gold_market_purchase_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now() where id = p_request_id;
    perform notify(r.buyer_client_id, 'gold_market_rejected', 'Achat marché refusé', p_note, '/client/gold/market');
    perform log_audit('reject_gold_market_purchase', 'gold_market_purchase_requests', p_request_id, jsonb_build_object(
      'buyer', (select display_name from profiles where id = r.buyer_client_id), 'price', l.listed_price));
    return;
  end if;

  -- CORRECTIF 0025 §1 : l'annonce doit encore être ouverte.
  if l is null then raise exception 'Annonce introuvable'; end if;
  if l.status <> 'active' then
    raise exception 'Ce lingot a déjà été vendu (annonce %). Refusez cette demande.', l.status;
  end if;

  -- Le lingot doit toujours être en vente et appartenir au vendeur annoncé :
  -- l'admin peut avoir modifié le registre entre-temps.
  select * into v_bar from gold_bars where id = l.gold_bar_id;
  if v_bar is null or v_bar.status <> 'listed'
     or coalesce(v_bar.owner_client_id::text, '') <> coalesce(l.seller_client_id::text, '') then
    raise exception 'Le lingot de cette annonce n''est plus disponible à la vente. Refusez cette demande.';
  end if;

  v_min_balance := coalesce(get_setting_numeric('min_client_balance', r.buyer_client_id), 1000000);
  v_new_total := client_total_balance(r.buyer_client_id) - l.listed_price;
  if v_new_total < v_min_balance and not is_admin() then
    update gold_market_purchase_requests set status = 'pending', processing_by = auth.uid(), processing_at = now() where id = p_request_id;
    perform notify_all_staff('gold_market_needs_admin', 'Achat marché sous le solde minimum — autorisation admin requise', l.listed_price || ' $', '/admin/gold', true);
    return;
  end if;

  select id, balance into v_buyer_account, v_buyer_balance
  from accounts where client_id = r.buyer_client_id and status = 'active'
  order by is_bank_treasury, opened_at limit 1;

  if v_buyer_account is null then
    raise exception 'L''acheteur n''a aucun compte actif pour régler cet achat.';
  end if;

  -- CORRECTIF 0025 §2 : pas de découvert créé par un achat.
  if l.listed_price > v_buyer_balance then
    raise exception 'Solde insuffisant sur le compte de l''acheteur : % $ disponibles pour un achat de % $.',
      v_buyer_balance, l.listed_price;
  end if;

  v_bank_account := bank_treasury_account_id();

  perform _adjust_balance(v_buyer_account, -l.listed_price);

  if l.seller_client_id is null then
    -- Lingot vendu directement par la banque : le prix entier lui revient,
    -- sans commission (elle ne se facture pas à elle-même).
    v_fee := 0;
    perform _adjust_balance(v_bank_account, l.listed_price);
  else
    select id into v_seller_account from accounts where client_id = l.seller_client_id and status='active' order by is_bank_treasury, opened_at limit 1;
    if v_seller_account is null then
      raise exception 'Le vendeur n''a plus de compte actif pour encaisser cette vente.';
    end if;
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

  -- CORRECTIF 0025 §1 : les demandes concurrentes sur ce lingot sont refusées
  -- automatiquement. Sans cela elles restaient « en attente » et approuvables,
  -- ce qui est précisément ce qui permettait la double vente.
  update gold_market_purchase_requests
  set status = 'rejected', decided_by = auth.uid(), decided_at = now()
  where listing_id = l.id and id <> p_request_id and status in ('pending', 'processing');

  perform notify(r.buyer_client_id, 'gold_market_validated', 'Achat marché validé', l.listed_price || ' $', '/client/gold/market');
  if l.seller_client_id is not null then
    perform notify(l.seller_client_id, 'gold_market_sold', 'Votre lingot a été vendu', (l.listed_price - v_fee) || ' $', '/client/gold/market');
  end if;
  perform log_audit('approve_gold_market_purchase', 'gold_market_purchase_requests', p_request_id, jsonb_build_object(
    'buyer', (select display_name from profiles where id = r.buyer_client_id),
    'price', l.listed_price, 'fee', v_fee, 'gold_bar_id', l.gold_bar_id));
end;
$function$;


-- Achat à la banque : mêmes garanties sur le compte payeur.
create or replace function decide_gold_bank_purchase(p_request_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r gold_bank_purchase_requests%rowtype;
  v_client_account uuid;
  v_client_balance numeric;
  v_bank_account uuid;
  v_tx_id uuid;
  v_min_balance numeric;
  v_new_total numeric;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into r from gold_bank_purchase_requests where id = p_request_id and status in ('pending','processing') for update;
  if r is null then raise exception 'Demande introuvable'; end if;

  if not p_approve then
    update gold_bank_purchase_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now() where id = p_request_id;
    update gold_bars set status = 'in_vault' where id = r.gold_bar_id;
    perform notify(r.client_id, 'gold_purchase_rejected', 'Achat de lingot refusé', p_note, '/client/gold');
    perform log_audit('reject_gold_bank_purchase', 'gold_bank_purchase_requests', p_request_id, jsonb_build_object(
      'client', (select display_name from profiles where id = r.client_id), 'price', r.price));
    return;
  end if;

  -- Le lingot doit toujours être réservé pour cette demande.
  if not exists (select 1 from gold_bars where id = r.gold_bar_id and status = 'reserved') then
    raise exception 'Ce lingot n''est plus réservé pour cette demande. Refusez-la.';
  end if;

  v_min_balance := coalesce(get_setting_numeric('min_client_balance', r.client_id), 1000000);
  v_new_total := client_total_balance(r.client_id) - r.price;
  if v_new_total < v_min_balance and not is_admin() then
    update gold_bank_purchase_requests set status = 'pending', processing_by = auth.uid(), processing_at = now() where id = p_request_id;
    perform notify_all_staff('gold_purchase_needs_admin', 'Achat de lingot sous le solde minimum — autorisation admin requise', r.price || ' $', '/admin/gold', true);
    return;
  end if;

  select id, balance into v_client_account, v_client_balance
  from accounts where client_id = r.client_id and status = 'active'
  order by is_bank_treasury, opened_at limit 1;

  if v_client_account is null then
    raise exception 'Ce client n''a aucun compte actif pour régler cet achat.';
  end if;

  -- CORRECTIF 0025 §2 : pas de découvert créé par un achat.
  if r.price > v_client_balance then
    raise exception 'Solde insuffisant sur le compte du client : % $ disponibles pour un achat de % $.',
      v_client_balance, r.price;
  end if;

  v_bank_account := bank_treasury_account_id();

  perform _adjust_balance(v_client_account, -r.price);
  perform _adjust_balance(v_bank_account, r.price);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, related_request_type, related_request_id, created_by)
  values ('gold_purchase_bank', 'validated', v_client_account, v_bank_account, r.price, 'Achat lingot ' || r.gold_bar_id, 'gold_bank_purchase_requests', r.id, auth.uid())
  returning id into v_tx_id;

  update gold_bars set status = 'sold', owner_client_id = r.client_id where id = r.gold_bar_id;
  update gold_bank_purchase_requests set status = 'validated', decided_by = auth.uid(), decided_at = now(), resulting_transaction_id = v_tx_id,
    admin_authorized_by = case when is_admin() and v_new_total < v_min_balance then auth.uid() else null end
  where id = p_request_id;

  perform notify(r.client_id, 'gold_purchase_validated', 'Achat de lingot validé', r.price || ' $', '/client/gold');
  perform log_audit('approve_gold_bank_purchase', 'gold_bank_purchase_requests', p_request_id, jsonb_build_object(
    'client', (select display_name from profiles where id = r.client_id), 'price', r.price, 'gold_bar_id', r.gold_bar_id));
end;
$function$;


-- ----------------------------------------------------------------------------
-- Permissions d'exécution (voir 0015 ; exceptions rappelées en 0022).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

grant execute on function record_login_attempt(text, boolean) to anon;
revoke execute on function revoke_user_sessions(uuid) from authenticated;

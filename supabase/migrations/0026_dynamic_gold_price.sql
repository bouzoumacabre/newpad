-- ============================================================================
-- NEWPAD — Migration 0026 : cours de l'or piloté par le marché
-- ============================================================================
-- Demande : afficher l'indice de l'once sur les interfaces, et faire évoluer
-- le cours automatiquement selon les prix auxquels les lingots se vendent
-- réellement sur le marché de revente.
-- ============================================================================
--
-- LE RISQUE À NEUTRALISER D'ABORD
--
-- Le prix d'une annonce est fixé librement par le vendeur. Si le cours suivait
-- bêtement chaque vente, deux joueurs complices pourraient s'échanger un même
-- lingot à un prix absurde pour déplacer le cours à volonté — or c'est ce
-- cours qui fixe le prix auquel LA BANQUE vend son propre stock. Gonfler le
-- cours, puis revendre à la banque ; ou l'effondrer, puis lui racheter son
-- stock pour rien. La commission de marché rend l'aller-retour coûteux, mais
-- pas assez pour dissuader sur de gros montants.
--
-- Le cours dynamique est donc encadré par quatre garde-fous cumulatifs :
--
--   1. DÉSACTIVÉ PAR DÉFAUT (`gold_price_auto`). Tant que tu ne l'actives pas,
--      rien ne change : le cours reste ce que tu as saisi à la main.
--   2. LISSAGE (`gold_price_smoothing`, 25 % par défaut) : une vente ne
--      remplace pas le cours, elle le tire vers elle d'un quart. Il faut donc
--      plusieurs ventes concordantes pour le déplacer vraiment.
--   3. PLAFOND DE VARIATION (`gold_price_max_move_percent`, 5 % par défaut) :
--      aucune vente ne peut faire bouger le cours de plus de 5 % d'un coup,
--      quel que soit son prix. Une vente à 100× le cours le monte de 5 %.
--   4. BORNES ABSOLUES (`gold_price_floor` / `gold_price_ceiling`) : le cours
--      ne sort jamais de l'intervalle que tu fixes. À 0, la borne est ignorée.
--
-- Seules les ventes entre deux clients DIFFÉRENTS comptent — les ventes du
-- stock de la banque sont exclues, puisque leur prix découle déjà du cours et
-- l'alimenter avec lui-même n'apprendrait rien (boucle de rétroaction).


-- ----------------------------------------------------------------------------
-- 1. Réglages
-- ----------------------------------------------------------------------------
insert into economic_settings (key, label, value, value_type, category) values
  ('gold_price_auto', 'Cours de l''or piloté par le marché', '{"enabled": false}', 'boolean', 'marché'),
  ('gold_price_smoothing', 'Poids d''une vente dans le nouveau cours (%)', '{"amount": 25}', 'percent', 'marché'),
  ('gold_price_max_move_percent', 'Variation maximale du cours par vente (%)', '{"amount": 5}', 'percent', 'marché'),
  ('gold_price_floor', 'Cours plancher ($/gramme, 0 = aucun)', '{"amount": 0}', 'money', 'marché'),
  ('gold_price_ceiling', 'Cours plafond ($/gramme, 0 = aucun)', '{"amount": 0}', 'money', 'marché')
on conflict (key) do nothing;


-- ----------------------------------------------------------------------------
-- 2. Historique du cours
-- ----------------------------------------------------------------------------
-- Sans historique, un cours dynamique est illisible : on voit un nombre sans
-- savoir s'il monte ou descend. Cette table alimente l'indicateur de tendance
-- affiché sur les interfaces.
create table if not exists gold_price_history (
  id uuid primary key default gen_random_uuid(),
  price_per_gram numeric(14,2) not null,
  previous_price numeric(14,2),
  source text not null check (source in ('market', 'admin', 'seed')),
  observed_price_per_gram numeric(14,2),
  related_transaction_id uuid references transactions(id),
  changed_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_gold_price_history_date on gold_price_history(created_at desc);

alter table gold_price_history enable row level security;

-- Le cours est une information publique : un client doit pouvoir juger si une
-- annonce est chère. Lecture ouverte, écriture réservée aux fonctions.
drop policy if exists gold_price_history_select on gold_price_history;
create policy gold_price_history_select on gold_price_history for select using (true);

-- Point de départ : le cours actuel, pour que le premier affichage ait une
-- référence même avant la première vente.
insert into gold_price_history (price_per_gram, source)
select coalesce(get_setting_numeric('gold_price_per_gram'), 60), 'seed'
where not exists (select 1 from gold_price_history);


-- ----------------------------------------------------------------------------
-- 3. Le cours devient lisible sans être connecté
-- ----------------------------------------------------------------------------
-- La migration 0015 avait refermé `economic_settings` aux seules clés
-- maintenance/bannière pour les visiteurs. Le cours de l'or est une
-- information que toute banque affiche en vitrine : on l'ajoute à la liste
-- blanche, ainsi que les réglages nécessaires à son affichage.
drop policy if exists economic_settings_select on economic_settings;
create policy economic_settings_select on economic_settings
  for select using (
    key in ('maintenance_mode', 'announcement_banner', 'gold_price_per_gram', 'gold_price_auto')
    or auth.uid() is not null
  );


-- ----------------------------------------------------------------------------
-- 4. Recalcul du cours après une vente sur le marché
-- ----------------------------------------------------------------------------
create or replace function _update_gold_price_from_sale(
  p_price numeric,
  p_weight_grams numeric,
  p_transaction_id uuid
) returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_enabled boolean;
  v_current numeric;
  v_observed numeric;
  v_alpha numeric;
  v_max_move numeric;
  v_floor numeric;
  v_ceiling numeric;
  v_target numeric;
  v_min_allowed numeric;
  v_max_allowed numeric;
begin
  v_enabled := coalesce((get_setting('gold_price_auto')->>'enabled')::boolean, false);
  if not v_enabled then return; end if;

  if p_weight_grams is null or p_weight_grams <= 0 then return; end if;
  if p_price is null or p_price <= 0 then return; end if;

  v_current := coalesce(get_setting_numeric('gold_price_per_gram'), 60);
  if v_current <= 0 then return; end if;

  v_observed := p_price / p_weight_grams;

  -- Lissage : la vente tire le cours vers elle, elle ne le remplace pas.
  v_alpha := coalesce(get_setting_numeric('gold_price_smoothing'), 25) / 100;
  if v_alpha <= 0 then return; end if;
  if v_alpha > 1 then v_alpha := 1; end if;

  v_target := v_current * (1 - v_alpha) + v_observed * v_alpha;

  -- Plafond de variation : borne dure contre la manipulation par une vente
  -- unique à prix aberrant.
  v_max_move := coalesce(get_setting_numeric('gold_price_max_move_percent'), 5);
  if v_max_move > 0 then
    v_min_allowed := v_current * (1 - v_max_move / 100);
    v_max_allowed := v_current * (1 + v_max_move / 100);
    v_target := greatest(v_min_allowed, least(v_max_allowed, v_target));
  end if;

  -- Bornes absolues fixées par l'admin.
  v_floor := coalesce(get_setting_numeric('gold_price_floor'), 0);
  v_ceiling := coalesce(get_setting_numeric('gold_price_ceiling'), 0);
  if v_floor > 0 then v_target := greatest(v_floor, v_target); end if;
  if v_ceiling > 0 then v_target := least(v_ceiling, v_target); end if;

  v_target := round(v_target, 2);
  if v_target = v_current or v_target <= 0 then return; end if;

  update economic_settings
  set value = jsonb_build_object('amount', v_target), updated_at = now()
  where key = 'gold_price_per_gram';

  insert into gold_price_history (price_per_gram, previous_price, source, observed_price_per_gram, related_transaction_id)
  values (v_target, v_current, 'market', round(v_observed, 2), p_transaction_id);
end;
$function$;


-- ----------------------------------------------------------------------------
-- 5. Branchement sur la vente de marché
-- ----------------------------------------------------------------------------
-- Reprend intégralement la version durcie de la migration 0025 (double vente,
-- découvert, achat de sa propre annonce) et ajoute l'appel au recalcul, placé
-- APRÈS l'écriture de la transaction pour pouvoir la référencer dans
-- l'historique du cours.

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

  select * into l from gold_market_listings where id = r.listing_id for update;

  if not p_approve then
    update gold_market_purchase_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now() where id = p_request_id;
    perform notify(r.buyer_client_id, 'gold_market_rejected', 'Achat marché refusé', p_note, '/client/gold/market');
    perform log_audit('reject_gold_market_purchase', 'gold_market_purchase_requests', p_request_id, jsonb_build_object(
      'buyer', (select display_name from profiles where id = r.buyer_client_id), 'price', l.listed_price));
    return;
  end if;

  if l is null then raise exception 'Annonce introuvable'; end if;
  if l.status <> 'active' then
    raise exception 'Ce lingot a déjà été vendu (annonce %). Refusez cette demande.', l.status;
  end if;

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

  if l.listed_price > v_buyer_balance then
    raise exception 'Solde insuffisant sur le compte de l''acheteur : % $ disponibles pour un achat de % $.',
      v_buyer_balance, l.listed_price;
  end if;

  v_bank_account := bank_treasury_account_id();

  perform _adjust_balance(v_buyer_account, -l.listed_price);

  if l.seller_client_id is null then
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

  update gold_market_purchase_requests
  set status = 'rejected', decided_by = auth.uid(), decided_at = now()
  where listing_id = l.id and id <> p_request_id and status in ('pending', 'processing');

  -- CORRECTIF 0026 : le cours suit le marché. Uniquement pour une vente entre
  -- clients — une vente du stock de la banque est faite AU cours, l'utiliser
  -- pour recalculer le cours serait une boucle de rétroaction sans information.
  if l.seller_client_id is not null then
    perform _update_gold_price_from_sale(l.listed_price, v_bar.weight_grams, v_tx_id);
  end if;

  perform notify(r.buyer_client_id, 'gold_market_validated', 'Achat marché validé', l.listed_price || ' $', '/client/gold/market');
  if l.seller_client_id is not null then
    perform notify(l.seller_client_id, 'gold_market_sold', 'Votre lingot a été vendu', (l.listed_price - v_fee) || ' $', '/client/gold/market');
  end if;
  perform log_audit('approve_gold_market_purchase', 'gold_market_purchase_requests', p_request_id, jsonb_build_object(
    'buyer', (select display_name from profiles where id = r.buyer_client_id),
    'price', l.listed_price, 'fee', v_fee, 'gold_bar_id', l.gold_bar_id));
end;
$function$;


-- ----------------------------------------------------------------------------
-- 6. Les changements manuels du cours sont aussi historisés
-- ----------------------------------------------------------------------------
-- Sinon la courbe présenterait des sauts inexpliqués à chaque fois que l'admin
-- ajuste le cours depuis le pilotage économique.
create or replace function _log_gold_price_change()
returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_old numeric;
  v_new numeric;
begin
  if new.key <> 'gold_price_per_gram' then return new; end if;

  v_old := (old.value->>'amount')::numeric;
  v_new := (new.value->>'amount')::numeric;
  if v_new is null or v_old is not distinct from v_new then return new; end if;

  -- Le recalcul automatique écrit déjà sa propre ligne : on ne double pas.
  if exists (
    select 1 from gold_price_history
    where source = 'market' and price_per_gram = v_new and created_at > now() - interval '5 seconds'
  ) then
    return new;
  end if;

  insert into gold_price_history (price_per_gram, previous_price, source, changed_by)
  values (v_new, v_old, 'admin', auth.uid());

  return new;
end;
$function$;

drop trigger if exists trg_log_gold_price_change on economic_settings;
create trigger trg_log_gold_price_change
  after update on economic_settings
  for each row execute function _log_gold_price_change();


-- ----------------------------------------------------------------------------
-- 7. Lecture du cours et de sa tendance, en un appel
-- ----------------------------------------------------------------------------
create or replace function gold_price_snapshot()
returns table (
  price_per_gram numeric,
  price_per_ounce numeric,
  previous_price numeric,
  change_percent numeric,
  is_auto boolean,
  last_change timestamptz,
  last_source text
)
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  with courant as (
    select coalesce(get_setting_numeric('gold_price_per_gram'), 60) as prix
  ),
  dernier as (
    select h.previous_price, h.created_at, h.source
    from gold_price_history h
    order by h.created_at desc
    limit 1
  )
  select
    c.prix,
    round(c.prix * 31.1034768, 2),
    d.previous_price,
    case when coalesce(d.previous_price, 0) > 0
         then round((c.prix - d.previous_price) / d.previous_price * 100, 2)
         else 0 end,
    coalesce((get_setting('gold_price_auto')->>'enabled')::boolean, false),
    d.created_at,
    d.source
  from courant c left join dernier d on true;
$function$;


-- ----------------------------------------------------------------------------
-- 8. Permissions (voir 0015 ; exceptions rappelées en 0022).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

grant execute on function record_login_attempt(text, boolean) to anon;
-- Le cours est affiché sur l'accueil public, donc lisible sans session.
grant execute on function gold_price_snapshot() to anon;
revoke execute on function revoke_user_sessions(uuid) from authenticated;

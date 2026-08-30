-- ============================================================================
-- NEWPAD — Migration 0023 : découvert par virement et collisions d'IBAN
-- ============================================================================
-- Audit fonctionnalité par fonctionnalité — étape 3 : comptes et virements.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Un virement pouvait vider un compte bien au-delà de son solde
-- ----------------------------------------------------------------------------
-- `decide_transfer` ne vérifiait à aucun moment que le COMPTE ÉMETTEUR
-- dispose de la somme. Le seul garde-fou était le solde minimum du CLIENT,
-- avec trois trous :
--
--   a) il porte sur le total de TOUS les comptes du client, pas sur le compte
--      qui paie : avec un compte A à 0 et un compte B à 1 000 000, un virement
--      de 500 000 depuis A passait, mettant A à -500 000 ;
--   b) il est entièrement sauté pour les virements INTERNES
--      (`if not t.is_internal`) : un client pouvait donc, entre ses propres
--      comptes, créer un compte à -1 000 000 et un autre à +1 000 000, ce
--      second paraissant parfaitement approvisionné ;
--   c) il est contourné par l'admin (`and not is_admin()`), sans aucun
--      plancher de remplacement.
--
-- Un client pouvait ainsi se constituer un solde crédible adossé à une dette
-- sur un compte qu'il lui suffisait d'abandonner.
--
-- Règle posée : un virement ne peut pas rendre le compte émetteur négatif.
-- Elle vaut aussi pour l'admin — comme le contrôle de solvabilité de la banque
-- (migration 0020), la conservation de la monnaie n'est pas une question de
-- permission. Le découvert reste possible, mais uniquement là où il est un
-- produit assumé : les frais et les échéances de prêt, qui sont des créances
-- que la banque recouvre, jamais un virement volontaire.
--
-- Vérifié avant application : les 7 comptes actuellement négatifs le sont
-- tous par des frais de gestion (`fee_management`), aucun par un virement.
-- Le trou n'a jamais été exploité — la correction est préventive.
--
-- 2. L'état des comptes n'était pas revérifié au moment de la décision
--
-- `submit_transfer` contrôle les comptes au dépôt, mais un virement peut
-- rester en attente longtemps. Entre-temps, le compte émetteur ou le compte
-- destinataire peut avoir été gelé ou clôturé — la validation les débitait ou
-- créditait quand même. Les deux sont désormais revérifiés au moment de
-- décider, seul instant qui engage réellement l'argent.

create or replace function decide_transfer(p_transfer_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  t transfers%rowtype;
  v_sender_client uuid;
  v_recipient_client uuid;
  v_sender_balance numeric;
  v_sender_status text;
  v_recipient_status text;
  v_new_total numeric;
  v_min_balance numeric;
  v_fee_rate numeric;
  v_fee numeric;
  v_tx_id uuid;
  v_bank_account uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;

  select * into t from transfers where id = p_transfer_id for update;
  if t is null or t.status not in ('pending','processing') then
    raise exception 'Virement introuvable ou déjà décidé';
  end if;

  select client_id, balance, status into v_sender_client, v_sender_balance, v_sender_status
  from accounts where id = t.sender_account_id;
  select client_id, status into v_recipient_client, v_recipient_status
  from accounts where id = t.recipient_account_id;

  if not p_approve then
    update transfers set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = p_note
    where id = p_transfer_id;
    perform notify(v_sender_client, 'transfer_rejected', 'Virement refusé', p_note, '/client/transfers');
    perform log_audit('reject_transfer', 'transfers', p_transfer_id, jsonb_build_object(
      'client', (select display_name from profiles where id = v_sender_client), 'amount', t.amount, 'note', p_note));
    return;
  end if;

  -- CORRECTIF 0023 §2 : l'état des comptes est revérifié à la décision.
  if v_sender_status is null or v_sender_status <> 'active' then
    raise exception 'Le compte émetteur n''est plus actif (%). Refusez ce virement.', coalesce(v_sender_status, 'introuvable');
  end if;
  if v_recipient_status is null or v_recipient_status <> 'active' then
    raise exception 'Le compte destinataire n''est plus actif (%). Refusez ce virement.', coalesce(v_recipient_status, 'introuvable');
  end if;

  -- CORRECTIF 0023 §1 : jamais de découvert créé par un virement.
  if t.amount > v_sender_balance then
    raise exception 'Solde insuffisant sur le compte émetteur : % $ disponibles pour un virement de % $.',
      v_sender_balance, t.amount;
  end if;

  if not t.is_internal then
    v_min_balance := coalesce(get_setting_numeric('min_client_balance', v_sender_client), 1000000);
    v_new_total := client_total_balance(v_sender_client) - t.amount;

    if v_new_total < v_min_balance and not is_admin() then
      update transfers set status = 'pending', requires_admin_override = true, processing_by = auth.uid(), processing_at = now()
      where id = p_transfer_id;
      perform notify_all_staff('transfer_needs_admin', 'Virement sous le solde minimum — autorisation admin requise', t.amount || ' $', '/admin/transfers', true);
      return;
    end if;
  end if;

  v_bank_account := bank_treasury_account_id();

  -- Commission nulle sur un virement interne (correctif 0018 : elle était
  -- retirée au destinataire sans être créditée à personne, donc détruite).
  if t.is_internal then
    v_fee := 0;
  else
    v_fee_rate := coalesce((get_setting('transfer_commission_rate')->>'amount')::numeric, 0);
    v_fee := round(t.amount * v_fee_rate / 100, 2);
  end if;

  perform _adjust_balance(t.sender_account_id, -t.amount);
  perform _adjust_balance(t.recipient_account_id, t.amount - v_fee);
  if v_fee > 0 then
    perform _adjust_balance(v_bank_account, v_fee);
  end if;

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, fee_amount, description, related_request_type, related_request_id, created_by)
  values ('transfer', 'validated', t.sender_account_id, t.recipient_account_id, t.amount, v_fee, t.motif, 'transfers', t.id, auth.uid())
  returning id into v_tx_id;

  update transfers set status = 'validated', decided_by = auth.uid(), decided_at = now(), decision_note = p_note, resulting_transaction_id = v_tx_id
  where id = p_transfer_id;

  perform notify(v_sender_client, 'transfer_validated', 'Virement validé', t.amount || ' $', '/client/transfers');
  if v_recipient_client is not null and v_recipient_client != v_sender_client then
    perform notify(v_recipient_client, 'transfer_received', 'Virement reçu', (t.amount - v_fee) || ' $', '/client/transfers');
  end if;
  perform log_audit('approve_transfer', 'transfers', p_transfer_id, jsonb_build_object(
    'client', (select display_name from profiles where id = v_sender_client), 'amount', t.amount, 'fee', v_fee));
end;
$function$;


-- Contrôle également au DÉPÔT, pour que le client sache tout de suite plutôt
-- que d'attendre un refus. Le solde pouvant bouger d'ici la décision, c'est
-- bien le contrôle de `decide_transfer` qui fait autorité.
create or replace function submit_transfer(p_sender_account_id uuid, p_recipient_account_id uuid, p_amount numeric, p_motif text)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_client_id uuid;
  v_balance numeric;
  v_recipient_client_id uuid;
  v_is_internal boolean;
  v_min_amount numeric;
  v_id uuid;
begin
  if p_sender_account_id = p_recipient_account_id then
    raise exception 'Le compte émetteur et le compte destinataire doivent être différents';
  end if;

  select client_id, balance into v_client_id, v_balance
  from accounts where id = p_sender_account_id and status = 'active';
  if v_client_id is null or v_client_id != auth.uid() then
    raise exception 'Compte émetteur invalide ou inactif';
  end if;

  select client_id into v_recipient_client_id
  from accounts where id = p_recipient_account_id and status = 'active';
  if v_recipient_client_id is null then
    raise exception 'Compte destinataire invalide ou inactif';
  end if;

  if p_amount <= 0 then
    raise exception 'Montant invalide';
  end if;

  if p_amount > v_balance then
    raise exception 'Solde insuffisant : % $ disponibles sur ce compte.', v_balance;
  end if;

  v_is_internal := (v_recipient_client_id = v_client_id);

  if not v_is_internal then
    v_min_amount := coalesce(get_setting_numeric('min_transfer_amount', v_client_id), 100000);
    if p_amount < v_min_amount then
      raise exception 'Le montant minimum de virement est de % $', v_min_amount;
    end if;
  end if;

  insert into transfers (sender_account_id, recipient_account_id, amount, motif, is_internal)
  values (p_sender_account_id, p_recipient_account_id, p_amount, p_motif, v_is_internal)
  returning id into v_id;

  perform notify_all_staff('transfer_request', 'Nouveau virement à traiter', p_amount || ' $', '/employee/transfers');

  return v_id;
end;
$function$;


-- ----------------------------------------------------------------------------
-- 3. Les IBAN pouvaient entrer en collision, faisant échouer une ouverture
-- ----------------------------------------------------------------------------
-- `generate_iban()` tirait 8 chiffres au hasard sans jamais vérifier que
-- l'IBAN n'existe pas déjà, alors que `accounts.iban` est UNIQUE. Une
-- collision faisait donc échouer l'INSERT — et avec lui toute la transaction
-- d'approbation d'adhésion, sur une erreur de contrainte incompréhensible
-- pour le guichetier.
--
-- Probabilité par paradoxe des anniversaires : négligeable à 100 comptes,
-- ~0,5 % à 1 000, ~39 % à 10 000. Sur un serveur RP actif, ce n'est pas une
-- question de « si » mais de « quand ».
--
-- La fonction réessaie désormais jusqu'à trouver un IBAN libre. La boucle est
-- bornée : au-delà de 50 essais infructueux, mieux vaut une erreur explicite
-- qu'une boucle infinie tenant un verrou.
create or replace function generate_iban()
returns text
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_iban text;
  v_try int := 0;
begin
  loop
    v_iban := 'BNW' || to_char(now(), 'YY') || lpad(floor(random() * 100000000)::text, 8, '0');
    exit when not exists (select 1 from accounts where iban = v_iban);

    v_try := v_try + 1;
    if v_try >= 50 then
      raise exception 'Impossible de générer un IBAN libre après % tentatives — espace de numérotation saturé.', v_try;
    end if;
  end loop;
  return v_iban;
end;
$function$;


-- ----------------------------------------------------------------------------
-- 4. Permissions d'exécution (voir 0015 ; exceptions rappelées en 0022).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

grant execute on function record_login_attempt(text, boolean) to anon;
revoke execute on function revoke_user_sessions(uuid) from authenticated;

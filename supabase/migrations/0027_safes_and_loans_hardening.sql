-- ============================================================================
-- NEWPAD — Migration 0027 : coffres-forts et prêts
-- ============================================================================
-- Audit fonctionnalité par fonctionnalité — étape 5.
-- État constaté avant correction : 5 coffres tous disponibles, aucune location
-- en cours, aucun prélèvement effectué, 1 prêt en attente sans échéancier.
-- Toutes les corrections sont donc préventives.
-- ============================================================================


-- ############################################################################
-- PARTIE A — COFFRES-FORTS
-- ############################################################################

-- ----------------------------------------------------------------------------
-- A1. La date du dernier prélèvement était déduite du LIBELLÉ de la transaction
-- ----------------------------------------------------------------------------
-- `charge_safe_weekly_fees` cherchait la dernière facturation ainsi :
--
--     where tx_type = 'safe_rental'
--       and description like 'Location coffre ' || box.code || '%'
--
-- Comparer des libellés pour piloter une facturation récurrente casse de deux
-- façons distinctes :
--
--   1. COLLISION DE PRÉFIXE. `like 'Location coffre CF-1%'` correspond aussi
--      bien à « CF-1 » qu'à « CF-10 », « CF-11 »… Le coffre CF-1 serait
--      considéré comme déjà facturé parce que CF-10 l'a été — et ne serait
--      donc JAMAIS prélevé. Les codes actuels (CF-001…CF-005) n'entrent pas
--      encore en collision, mais rien n'empêche d'en créer un demain.
--
--   2. LIBELLÉ MODIFIABLE. L'admin peut désormais corriger la description
--      d'une transaction (migrations 0013 et 0024). Un libellé réécrit ne
--      correspond plus au motif : la fonction croit le coffre jamais facturé
--      et le prélève À NOUVEAU, puis chaque jour suivant.
--
-- La date de facturation est désormais une donnée à part entière, portée par
-- le coffre lui-même. Insensible aux libellés comme aux codes.

alter table safe_deposit_boxes add column if not exists last_charged_at timestamptz;

comment on column safe_deposit_boxes.last_charged_at is
  'Date du dernier prélèvement hebdomadaire. Remplace la déduction par comparaison de libellé de transaction, fragile aux collisions de préfixe de code et aux corrections de libellé par l''admin.';

-- Reprise de l'existant : aucun prélèvement n'a encore eu lieu, mais la
-- requête reste correcte si cette migration est appliquée plus tard.
update safe_deposit_boxes b
set last_charged_at = (
  select max(t.created_at) from transactions t
  where t.tx_type = 'safe_rental'
    and t.description like 'Location coffre ' || b.code || ' %'
)
where b.status = 'rented' and b.last_charged_at is null;


create or replace function charge_safe_weekly_fees()
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  box record;
  v_account uuid;
  v_bank_account uuid;
  v_tx_id uuid;
begin
  v_bank_account := bank_treasury_account_id();

  for box in
    select * from safe_deposit_boxes
    where status = 'rented'
      and client_id is not null
      and weekly_fee > 0
      and (last_charged_at is null or last_charged_at <= now() - interval '7 days')
  loop
    select id into v_account from accounts
    where client_id = box.client_id and status = 'active'
    order by is_bank_treasury, opened_at limit 1;

    -- Client sans compte actif : on ne peut pas prélever. Le personnel est
    -- prévenu plutôt que de laisser la location filer en silence.
    if v_account is null then
      perform notify_all_staff('safe_fee_failed', 'Loyer de coffre non prélevé — client sans compte actif',
        'Coffre ' || box.code, '/employee/safes');
      continue;
    end if;

    perform _adjust_balance(v_account, -box.weekly_fee);
    perform _adjust_balance(v_bank_account, box.weekly_fee);

    insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
    values ('safe_rental', 'validated', v_account, v_bank_account, box.weekly_fee,
            'Location coffre ' || box.code || ' (renouvellement hebdomadaire)', null)
    returning id into v_tx_id;

    update safe_deposit_boxes set last_charged_at = now() where id = box.id;

    perform notify(box.client_id, 'safe_fee_charged', 'Loyer hebdomadaire du coffre prélevé',
      box.weekly_fee || ' $ — coffre ' || box.code, '/client/safes');

    if (select balance from accounts where id = v_account) < 0 then
      perform notify_all_staff('account_negative', 'Compte client passé en négatif suite au loyer d''un coffre',
        box.client_id::text, '/employee/clients');
    end if;
  end loop;
end;
$function$;


-- ----------------------------------------------------------------------------
-- A2. Une location de coffre ne pouvait JAMAIS être résiliée
-- ----------------------------------------------------------------------------
-- Il n'existait aucune fonction pour mettre fin à une location : ni le client,
-- ni l'employé, ni l'admin ne pouvaient libérer un coffre. Une fois loué, il
-- était prélevé chaque semaine indéfiniment. Le seul contournement était
-- `admin_update_safe_box` pour forcer le statut — mais il ne vidait pas
-- `client_id`, laissant un coffre « disponible » toujours rattaché à un client.
--
-- Un abonnement sans bouton de résiliation n'est pas un oubli d'interface :
-- c'est une dette perpétuelle imposée au client.

create or replace function end_safe_rental(p_box_id uuid, p_note text default null)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  b safe_deposit_boxes%rowtype;
  v_is_owner boolean;
begin
  select * into b from safe_deposit_boxes where id = p_box_id for update;
  if b is null then raise exception 'Coffre introuvable'; end if;
  if b.status <> 'rented' then raise exception 'Ce coffre n''est pas loué'; end if;

  v_is_owner := (b.client_id = auth.uid());
  if not v_is_owner and not is_staff() then
    raise exception 'Ce coffre ne vous appartient pas';
  end if;

  update safe_deposit_boxes
  set status = 'available', client_id = null, rented_since = null, last_charged_at = null
  where id = p_box_id;

  -- Le locataire est prévenu quand la résiliation vient de la banque.
  if not v_is_owner and b.client_id is not null then
    perform notify(b.client_id, 'safe_ended', 'Location de coffre terminée',
      coalesce(p_note, 'Le coffre ' || b.code || ' a été libéré par la banque.'), '/client/safes');
  end if;

  perform log_audit('end_safe_rental', 'safe_deposit_boxes', p_box_id, jsonb_build_object(
    'code', b.code,
    'client', (select display_name from profiles where id = b.client_id),
    'par_le_client', v_is_owner,
    'note', p_note));
end;
$function$;


-- ----------------------------------------------------------------------------
-- A3. Demandes de coffre en série, et prélèvement sans contrôle de solde
-- ----------------------------------------------------------------------------
create or replace function submit_safe_request()
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
begin
  if exists (
    select 1 from safe_rental_requests
    where client_id = auth.uid() and status in ('pending', 'processing')
  ) then
    raise exception 'Vous avez déjà une demande de coffre-fort en cours.';
  end if;

  if exists (select 1 from safe_deposit_boxes where client_id = auth.uid() and status = 'rented') then
    raise exception 'Vous louez déjà un coffre-fort.';
  end if;

  if not exists (select 1 from safe_deposit_boxes where status = 'available') then
    raise exception 'Aucun coffre-fort n''est disponible actuellement.';
  end if;

  insert into safe_rental_requests (client_id) values (auth.uid()) returning id into v_id;
  perform notify_all_staff('safe_request', 'Nouvelle demande de coffre-fort', null, '/employee/safes');
  return v_id;
end;
$function$;


create or replace function staff_decide_safe_request(p_request_id uuid, p_approve boolean, p_safe_box_id uuid default null, p_note text default null)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r safe_rental_requests%rowtype;
  b safe_deposit_boxes%rowtype;
  v_account uuid;
  v_balance numeric;
  v_bank_account uuid;
  v_tx_id uuid;
  v_min_balance numeric;
  v_new_total numeric;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into r from safe_rental_requests where id = p_request_id and status in ('pending', 'processing') for update;
  if r is null then raise exception 'Demande introuvable ou déjà décidée'; end if;

  if not p_approve then
    if r.safe_box_id is not null then
      update safe_deposit_boxes set status = 'available' where id = r.safe_box_id and status = 'reserved';
    end if;
    update safe_rental_requests set status = 'rejected', decision_note = p_note, decided_by = auth.uid(), decided_at = now()
    where id = p_request_id;
    perform notify(r.client_id, 'safe_rejected', 'Demande de coffre-fort refusée', p_note, '/client/safes');
    perform notify_all_staff('safe_decided', 'Demande de coffre-fort refusée', (select display_name from profiles where id = r.client_id), '/employee/safes');
    perform log_audit('staff_decide_safe_request', 'safe_rental_requests', p_request_id, jsonb_build_object('approved', false, 'note', p_note));
    return;
  end if;

  if p_safe_box_id is null then
    select id into p_safe_box_id from safe_deposit_boxes where status = 'available' order by branch, code limit 1;
    if p_safe_box_id is null then raise exception 'Aucun coffre disponible actuellement'; end if;
  end if;
  select * into b from safe_deposit_boxes where id = p_safe_box_id and status = 'available' for update;
  if b is null then raise exception 'Ce coffre n''est plus disponible'; end if;

  v_min_balance := coalesce(get_setting_numeric('min_client_balance', r.client_id), 1000000);
  v_new_total := client_total_balance(r.client_id) - b.weekly_fee;
  if v_new_total < v_min_balance and not is_admin() then
    update safe_rental_requests set status = 'processing', safe_box_id = b.id, processing_by = auth.uid(), processing_at = now() where id = p_request_id;
    update safe_deposit_boxes set status = 'reserved' where id = b.id;
    perform notify_all_staff('safe_needs_admin', 'Location de coffre sous le solde minimum — autorisation admin requise', b.code, '/admin/safes', true);
    return;
  end if;

  select id, balance into v_account, v_balance from accounts
  where client_id = r.client_id and status = 'active'
  order by is_bank_treasury, opened_at limit 1;

  -- CORRECTIF 0027 : compte payeur existant et suffisamment approvisionné.
  if v_account is null then
    raise exception 'Ce client n''a aucun compte actif pour régler le loyer du coffre.';
  end if;
  if b.weekly_fee > v_balance then
    raise exception 'Solde insuffisant : % $ disponibles pour un loyer de % $.', v_balance, b.weekly_fee;
  end if;

  v_bank_account := bank_treasury_account_id();

  perform _adjust_balance(v_account, -b.weekly_fee);
  perform _adjust_balance(v_bank_account, b.weekly_fee);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, related_request_type, related_request_id, created_by)
  values ('safe_rental', 'validated', v_account, v_bank_account, b.weekly_fee, 'Location coffre ' || b.code || ' (1 semaine)', 'safe_rental_requests', r.id, auth.uid())
  returning id into v_tx_id;

  update safe_deposit_boxes
  set status = 'rented', client_id = r.client_id, rented_since = current_date, last_charged_at = now()
  where id = b.id;

  update safe_rental_requests set status = 'validated', safe_box_id = b.id, decision_note = p_note, decided_by = auth.uid(), decided_at = now(),
    confirmed_by = auth.uid(), confirmed_at = now(), resulting_transaction_id = v_tx_id
  where id = p_request_id;

  perform notify(r.client_id, 'safe_validated', 'Location de coffre autorisée — coffre ' || b.code, now()::text, '/client/safes');
  perform notify_all_staff('safe_decided', 'Location de coffre autorisée — ' || b.code, (select display_name from profiles where id = r.client_id), '/employee/safes');
  perform log_audit('staff_decide_safe_request', 'safe_rental_requests', p_request_id, jsonb_build_object(
    'approved', true, 'client', (select display_name from profiles where id = r.client_id), 'safe_code', b.code));
end;
$function$;


-- A4. Rendre un coffre « disponible » sans détacher son locataire laissait un
--     état incohérent : coffre libre en apparence, toujours rattaché à un client.
create or replace function admin_update_safe_box(p_box_id uuid, p_weekly_fee numeric default null, p_branch text default null, p_status safe_status default null)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  if p_weekly_fee is not null and p_weekly_fee < 0 then raise exception 'Le tarif hebdomadaire ne peut pas être négatif'; end if;

  update safe_deposit_boxes set
    weekly_fee = coalesce(p_weekly_fee, weekly_fee),
    branch = coalesce(p_branch, branch),
    status = coalesce(p_status, status),
    client_id = case when p_status = 'available' then null else client_id end,
    rented_since = case when p_status = 'available' then null else rented_since end,
    last_charged_at = case when p_status = 'available' then null else last_charged_at end
  where id = p_box_id;

  if not found then raise exception 'Coffre introuvable'; end if;
  perform log_audit('admin_update_safe_box', 'safe_deposit_boxes', p_box_id, jsonb_build_object(
    'weekly_fee', p_weekly_fee, 'branch', p_branch, 'status', p_status));
end;
$function$;


-- ############################################################################
-- PARTIE B — PRÊTS
-- ############################################################################

-- ----------------------------------------------------------------------------
-- B1. Demande de prêt : ni montant, ni durée, ni cumul n'étaient contrôlés
-- ----------------------------------------------------------------------------
-- `submit_loan_request` ne vérifiait que le plafond. Conséquences :
--
--   - un montant NÉGATIF ou nul passait (il est bien inférieur au plafond) ;
--   - une durée de 0 ou négative produisait un prêt actif SANS échéancier :
--     jamais remboursé, jamais clôturé, impossible à solder ;
--   - une durée démesurée (1 000 000 mois) générait autant de lignes
--     d'échéancier — un déni de service sur la base ;
--   - le plafond s'applique PAR PRÊT, pas par client : rien n'empêchait
--     d'empiler dix prêts au plafond.

create or replace function submit_loan_request(p_amount numeric, p_purpose text, p_term_months integer)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_cap numeric;
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Le montant demandé doit être supérieur à zéro';
  end if;
  if p_term_months is null or p_term_months < 1 or p_term_months > 120 then
    raise exception 'La durée doit être comprise entre 1 et 120 mois';
  end if;

  v_cap := coalesce(get_setting_numeric('loan_cap', auth.uid()), 50000000);
  if p_amount > v_cap then
    raise exception 'Le montant dépasse le plafond de prêt autorisé (% $)', v_cap;
  end if;

  -- Un seul dossier ouvert à la fois : le plafond n'aurait aucun sens si l'on
  -- pouvait empiler les prêts.
  if exists (select 1 from loans where client_id = auth.uid() and status in ('pending', 'processing')) then
    raise exception 'Vous avez déjà une demande de prêt en cours d''examen.';
  end if;
  if exists (select 1 from loans where client_id = auth.uid() and status = 'active') then
    raise exception 'Vous avez déjà un prêt en cours. Soldez-le avant d''en demander un autre.';
  end if;

  insert into loans (client_id, requested_amount, purpose, term_months)
  values (auth.uid(), p_amount, p_purpose, p_term_months)
  returning id into v_id;

  perform notify_all_staff('loan_request', 'Nouvelle demande de prêt', p_amount || ' $', '/admin/loans', true);
  return v_id;
end;
$function$;


-- ----------------------------------------------------------------------------
-- B2. Décaissement : solvabilité de la banque et dérive d'arrondi
-- ----------------------------------------------------------------------------
-- Deux défauts :
--
--   1. Aucun contrôle que la trésorerie peut couvrir le prêt — comme pour le
--      dépôt d'ouverture avant la migration 0020. Un prêt de 500 M$ approuvé
--      mettait simplement les fonds propres à -250 M$.
--
--   2. DÉRIVE D'ARRONDI. Le capital de chaque échéance valait
--      `round(montant / durée, 2)`, identique pour toutes. Sur 1 000 $ en
--      3 mois : 333,33 × 3 = 999,99. Le client remboursait 0,01 $ de moins que
--      son emprunt, et la banque perdait la différence sur chaque prêt.
--      La dernière échéance absorbe désormais le reliquat.

create or replace function admin_decide_loan(p_loan_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  l loans%rowtype;
  v_rate numeric;
  v_bank_account uuid;
  v_client_account uuid;
  v_treasury numeric;
  v_tx_id uuid;
  v_fee_tx_id uuid;
  v_processing_fee numeric;
  i int;
  v_balance numeric;
  v_interest numeric;
  v_principal numeric;
  v_principal_base numeric;
  v_principal_cumul numeric := 0;
begin
  if not is_admin() then raise exception 'Seul l''admin peut valider un prêt'; end if;
  select * into l from loans where id = p_loan_id and status in ('pending','processing') for update;
  if l is null then raise exception 'Prêt introuvable'; end if;

  if not p_approve then
    update loans set status = 'rejected', admin_decided_by = auth.uid(), admin_decided_at = now(), decision_note = p_note where id = p_loan_id;
    perform notify(l.client_id, 'loan_rejected', 'Demande de prêt refusée', p_note, '/client/loans');
    perform log_audit('reject_loan', 'loans', p_loan_id, jsonb_build_object(
      'client', (select display_name from profiles where id = l.client_id), 'amount', l.requested_amount, 'note', p_note));
    return;
  end if;

  -- Garde-fous sur des valeurs qui ont pu être écrites avant la migration B1.
  if l.requested_amount is null or l.requested_amount <= 0 then
    raise exception 'Montant de prêt invalide (% $) — refusez cette demande.', l.requested_amount;
  end if;
  if l.term_months is null or l.term_months < 1 or l.term_months > 120 then
    raise exception 'Durée de prêt invalide (% mois) — refusez cette demande.', l.term_months;
  end if;

  v_rate := coalesce(get_setting_numeric('loan_rate', l.client_id), 5) / 100;
  v_bank_account := bank_treasury_account_id();

  select id into v_client_account from accounts where client_id = l.client_id and status='active' order by is_bank_treasury, opened_at limit 1;
  if v_client_account is null then
    raise exception 'Ce client n''a aucun compte actif pour recevoir le décaissement.';
  end if;

  -- CORRECTIF 0027 : la banque ne prête pas ce qu'elle n'a pas.
  select balance into v_treasury from accounts where id = v_bank_account;
  if l.requested_amount > v_treasury then
    raise exception 'Décaissement de % $ impossible : la trésorerie de la banque ne dispose que de % $.',
      l.requested_amount, v_treasury;
  end if;

  perform _adjust_balance(v_client_account, l.requested_amount);
  perform _adjust_balance(v_bank_account, -l.requested_amount);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, related_request_type, related_request_id, created_by)
  values ('loan_disbursement', 'validated', v_bank_account, v_client_account, l.requested_amount, 'Décaissement prêt', 'loans', l.id, auth.uid())
  returning id into v_tx_id;

  v_processing_fee := coalesce(get_setting_numeric('loan_processing_fee'), 0);
  if v_processing_fee > 0 then
    perform _adjust_balance(v_client_account, -v_processing_fee);
    perform _adjust_balance(v_bank_account, v_processing_fee);
    insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, related_request_type, related_request_id, created_by)
    values ('loan_processing_fee', 'validated', v_client_account, v_bank_account, v_processing_fee, 'Frais de dossier — prêt', 'loans', l.id, auth.uid())
    returning id into v_fee_tx_id;
  end if;

  update loans set status = 'active', interest_rate = v_rate, outstanding_balance = l.requested_amount,
    admin_decided_by = auth.uid(), admin_decided_at = now(), decision_note = p_note,
    disbursed_at = now(), disbursement_account_id = v_client_account, disbursement_transaction_id = v_tx_id
  where id = p_loan_id;

  v_balance := l.requested_amount;
  v_principal_base := round(l.requested_amount / l.term_months, 2);

  for i in 1..l.term_months loop
    v_interest := round(v_balance * v_rate / 12, 2);

    -- La dernière échéance solde exactement le capital restant : sans cela,
    -- la somme des arrondis laisse un reliquat jamais remboursé.
    if i = l.term_months then
      v_principal := round(l.requested_amount - v_principal_cumul, 2);
    else
      v_principal := v_principal_base;
    end if;
    v_principal_cumul := v_principal_cumul + v_principal;

    insert into loan_schedules (loan_id, installment_number, due_date, amount_due, principal, interest)
    values (l.id, i, (current_date + (i || ' months')::interval)::date, v_principal + v_interest, v_principal, v_interest);

    v_balance := v_balance - v_principal;
  end loop;

  perform notify(l.client_id, 'loan_approved', 'Prêt validé et décaissé', l.requested_amount || ' $', '/client/loans');
  if v_processing_fee > 0 then
    perform notify(l.client_id, 'loan_fee_charged', 'Frais de dossier prélevés', v_processing_fee || ' $', '/client/loans');
  end if;
  perform log_audit('approve_loan', 'loans', p_loan_id, jsonb_build_object(
    'client', (select display_name from profiles where id = l.client_id), 'amount', l.requested_amount, 'rate', v_rate,
    'term_months', l.term_months, 'processing_fee', v_processing_fee));
end;
$function$;


-- ----------------------------------------------------------------------------
-- B3. Remboursement anticipé sans contrôle de solde
-- ----------------------------------------------------------------------------
-- Solder un prêt prélevait le capital restant sans vérifier que le compte le
-- contient : le client échangeait une dette encadrée par un échéancier contre
-- un découvert non encadré, échappant aux pénalités de retard.

create or replace function repay_loan_early(p_loan_id uuid)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  l loans%rowtype;
  v_client_account uuid;
  v_balance numeric;
  v_bank_account uuid;
  v_remaining numeric;
  v_tx_id uuid;
begin
  select * into l from loans where id = p_loan_id and client_id = auth.uid() and status = 'active' for update;
  if l is null then raise exception 'Prêt introuvable'; end if;

  select coalesce(sum(amount_due),0) into v_remaining from loan_schedules where loan_id = p_loan_id and status = 'pending';
  if v_remaining <= 0 then raise exception 'Aucune échéance restante'; end if;

  select id, balance into v_client_account, v_balance from accounts
  where client_id = l.client_id and status='active'
  order by is_bank_treasury, opened_at limit 1;

  if v_client_account is null then
    raise exception 'Vous n''avez aucun compte actif pour effectuer ce remboursement.';
  end if;
  if v_remaining > v_balance then
    raise exception 'Solde insuffisant : % $ disponibles pour un remboursement de % $.', v_balance, v_remaining;
  end if;

  v_bank_account := bank_treasury_account_id();

  perform _adjust_balance(v_client_account, -v_remaining);
  perform _adjust_balance(v_bank_account, v_remaining);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, related_request_type, related_request_id, created_by)
  values ('loan_repayment', 'validated', v_client_account, v_bank_account, v_remaining, 'Remboursement anticipé', 'loans', l.id, auth.uid())
  returning id into v_tx_id;

  update loan_schedules set status = 'paid', paid_at = now(), resulting_transaction_id = v_tx_id where loan_id = p_loan_id and status = 'pending';
  update loans set status = 'closed', outstanding_balance = 0, closed_at = now() where id = p_loan_id;

  perform adjust_trust_score(l.client_id, 3);
  perform notify(l.client_id, 'loan_closed', 'Prêt remboursé par anticipation', v_remaining || ' $', '/client/loans');
  perform log_audit('repay_loan_early', 'loans', p_loan_id, jsonb_build_object('amount', v_remaining));
end;
$function$;


-- ----------------------------------------------------------------------------
-- Permissions (voir 0015 ; exceptions rappelées en 0022 et 0026).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

grant execute on function record_login_attempt(text, boolean) to anon;
grant execute on function gold_price_snapshot() to anon;
revoke execute on function revoke_user_sessions(uuid) from authenticated;

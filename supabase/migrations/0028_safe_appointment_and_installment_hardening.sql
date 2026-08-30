-- ============================================================================
-- NEWPAD — Migration 0028 : parcours « rendez-vous » des coffres et échéances
-- ============================================================================
-- Suite de l'étape 5. La migration 0027 a corrigé le parcours direct
-- (`staff_decide_safe_request`) ; la relecture a montré que le parcours
-- alternatif — programmer un rendez-vous puis confirmer — souffrait des mêmes
-- défauts, plus deux qui lui sont propres. Idem pour le prélèvement des
-- échéances de prêt, exposé au RPC sans aucun contrôle de propriétaire.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- A5. `claim_safe_request` réservait n'importe quel coffre, même déjà loué
-- ----------------------------------------------------------------------------
--     update safe_deposit_boxes set status = 'reserved' where id = p_safe_box_id;
--
-- Aucune condition sur le statut. Trois conséquences :
--
--   1. VOL DE COFFRE. Passer l'identifiant d'un coffre déjà loué le faisait
--      basculer en « réservé » sans détacher son locataire ; à la confirmation,
--      `client_id` était écrasé et le premier client perdait son coffre — tout
--      en continuant à en payer le loyer.
--   2. DOUBLE RÉSERVATION. Deux employés pouvaient programmer deux rendez-vous
--      sur le même coffre ; la seconde confirmation écrasait la première.
--   3. Un identifiant inexistant ne provoquait aucune erreur : le rendez-vous
--      était programmé et le client notifié pour un coffre fantôme.

create or replace function claim_safe_request(p_request_id uuid, p_safe_box_id uuid, p_appointment_at timestamptz, p_appointment_location text)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_client uuid;
  b safe_deposit_boxes%rowtype;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;

  -- Le coffre est verrouillé AVANT toute écriture : deux employés traitant
  -- deux demandes en parallèle ne peuvent plus retenir le même coffre.
  select * into b from safe_deposit_boxes where id = p_safe_box_id for update;
  if b is null then raise exception 'Coffre introuvable'; end if;
  if b.status <> 'available' then
    raise exception 'Le coffre % n''est pas disponible (statut : %)', b.code, b.status;
  end if;

  update safe_rental_requests set status='processing', safe_box_id = p_safe_box_id, appointment_at = p_appointment_at,
    appointment_location = p_appointment_location, processing_by = auth.uid(), processing_at = now()
  where id = p_request_id and status = 'pending'
  returning client_id into v_client;
  if not found then raise exception 'Demande introuvable'; end if;

  update safe_deposit_boxes set status = 'reserved' where id = p_safe_box_id;

  perform notify(v_client, 'safe_appointment', 'Rendez-vous programmé pour votre coffre', p_appointment_at::text, '/client/safes');
  perform log_audit('claim_safe_request', 'safe_rental_requests', p_request_id, jsonb_build_object(
    'client', (select display_name from profiles where id = v_client), 'safe_code', b.code));
end;
$function$;


-- ----------------------------------------------------------------------------
-- A6. `confirm_safe_rental` : les mêmes trous que le parcours direct
-- ----------------------------------------------------------------------------
--   - `select id into v_account` sans contrôle : un client sans compte actif
--     faisait échouer la confirmation sur « Compte introuvable: <uuid> »,
--     message illisible pour l'employé ;
--   - aucun contrôle de solde avant le prélèvement du premier loyer ;
--   - `last_charged_at` n'était pas renseigné : depuis la migration 0027, un
--     coffre loué par ce parcours aurait été REPRÉLEVÉ dès la nuit suivante,
--     la colonne nulle valant « jamais facturé » ;
--   - le coffre n'était ni verrouillé ni vérifié : entre le rendez-vous et la
--     confirmation, il pouvait avoir été loué à quelqu'un d'autre ;
--   - `b` pouvait être nul (demande sans coffre associé), et `b.weekly_fee`
--     nul avec lui.

create or replace function confirm_safe_rental(p_request_id uuid)
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
  select * into r from safe_rental_requests where id = p_request_id and status = 'processing' for update;
  if r is null then raise exception 'Demande introuvable'; end if;

  if r.safe_box_id is null then
    raise exception 'Aucun coffre n''a été associé à cette demande.';
  end if;
  select * into b from safe_deposit_boxes where id = r.safe_box_id for update;
  if b is null then raise exception 'Le coffre associé à cette demande n''existe plus'; end if;
  if b.status not in ('reserved', 'available') then
    raise exception 'Le coffre % n''est plus disponible (statut : %)', b.code, b.status;
  end if;

  v_min_balance := coalesce(get_setting_numeric('min_client_balance', r.client_id), 1000000);
  v_new_total := client_total_balance(r.client_id) - b.weekly_fee;
  if v_new_total < v_min_balance and not is_admin() then
    perform notify_all_staff('safe_needs_admin', 'Location de coffre sous le solde minimum — autorisation admin requise', b.code, '/admin/safes', true);
    return;
  end if;

  select id, balance into v_account, v_balance from accounts
  where client_id = r.client_id and status = 'active'
  order by is_bank_treasury, opened_at limit 1;

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

  update safe_rental_requests set status = 'validated', confirmed_by = auth.uid(), confirmed_at = now(), resulting_transaction_id = v_tx_id
  where id = p_request_id;

  perform notify(r.client_id, 'safe_validated', 'Location de coffre confirmée', b.code, '/client/safes');
  perform log_audit('confirm_safe_rental', 'safe_rental_requests', p_request_id, jsonb_build_object(
    'client', (select display_name from profiles where id = r.client_id), 'safe_code', b.code, 'weekly_fee', b.weekly_fee));
end;
$function$;


-- ----------------------------------------------------------------------------
-- B4. `repay_loan_installment_now` : prélever l'échéance de n'importe qui
-- ----------------------------------------------------------------------------
-- Cette fonction est appelée chaque nuit par le planificateur
-- (`process_due_loan_installments`), mais elle est aussi exposée en RPC à tout
-- utilisateur authentifié — sans le moindre contrôle de propriétaire. Il
-- suffisait de connaître l'identifiant d'une échéance pour DÉBITER LE COMPTE
-- D'UN AUTRE CLIENT, éventuellement le faire passer en négatif et déclencher
-- une alerte de fraude à sa place.
--
-- Second défaut : un client sans compte actif faisait remonter
-- « Compte introuvable » depuis `_adjust_balance`, ce qui interrompait la
-- BOUCLE ENTIÈRE. Une seule anomalie et plus aucune échéance n'était prélevée
-- cette nuit-là, pour personne. Le cas est désormais signalé au personnel et
-- l'échéance suivante est traitée.
--
-- Le prélèvement automatique doit rester possible même à découvert — c'est le
-- principe même de la pénalité de retard. Le contrôle de solde ne s'applique
-- donc qu'aux appels manuels (`auth.uid()` non nul), jamais au planificateur.

create or replace function repay_loan_installment_now(p_schedule_id uuid)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  s loan_schedules%rowtype;
  l loans%rowtype;
  v_client_account uuid;
  v_balance numeric;
  v_bank_account uuid;
  v_tx_id uuid;
  v_penalty_rate numeric;
  v_penalty numeric := 0;
  v_amount numeric;
  v_caller uuid;
begin
  select * into s from loan_schedules where id = p_schedule_id and status = 'pending' for update;
  if s is null then raise exception 'Échéance introuvable'; end if;
  select * into l from loans where id = s.loan_id;
  if l is null then raise exception 'Prêt introuvable'; end if;

  -- auth.uid() est nul quand l'appel vient du planificateur nocturne.
  v_caller := auth.uid();
  if v_caller is not null and v_caller <> l.client_id and not is_staff() then
    raise exception 'Cette échéance ne vous appartient pas';
  end if;

  select id, balance into v_client_account, v_balance from accounts
  where client_id = l.client_id and status='active'
  order by is_bank_treasury, opened_at limit 1;

  if v_client_account is null then
    if v_caller is null then
      -- Planificateur : on signale et on passe à l'échéance suivante plutôt
      -- que d'interrompre le traitement de tous les autres clients.
      perform notify_all_staff('loan_installment_failed', 'Échéance de prêt non prélevée — client sans compte actif',
        (select display_name from profiles where id = l.client_id), '/employee/loans');
      return;
    end if;
    raise exception 'Aucun compte actif pour prélever cette échéance.';
  end if;

  v_bank_account := bank_treasury_account_id();

  if s.due_date < current_date then
    v_penalty_rate := coalesce(get_setting_numeric('loan_late_penalty_rate', l.client_id), 5) / 100;
    v_penalty := round(s.amount_due * v_penalty_rate, 2);
  end if;
  v_amount := s.amount_due + v_penalty;

  -- Paiement volontaire : on refuse de créer un découvert. Le prélèvement
  -- automatique, lui, reste autorisé — sinon une échéance impayée ne serait
  -- jamais ni prélevée ni pénalisée.
  if v_caller is not null and v_amount > v_balance then
    raise exception 'Solde insuffisant : % $ disponibles pour une échéance de % $.', v_balance, v_amount;
  end if;

  perform _adjust_balance(v_client_account, -v_amount);
  perform _adjust_balance(v_bank_account, v_amount);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, related_request_type, related_request_id, created_by)
  values ('loan_repayment', 'validated', v_client_account, v_bank_account, v_amount,
    'Échéance prêt #' || s.installment_number || case when v_penalty > 0 then ' (+ pénalité de retard)' else '' end,
    'loan_schedules', s.id, v_caller)
  returning id into v_tx_id;

  update loan_schedules set status = case when v_penalty > 0 then 'late' else 'paid' end, penalty_applied = v_penalty, paid_at = now(), resulting_transaction_id = v_tx_id
  where id = p_schedule_id;

  update loans set outstanding_balance = greatest(0, outstanding_balance - s.principal) where id = l.id;

  if v_penalty > 0 then
    perform adjust_trust_score(l.client_id, -5);
    perform notify(l.client_id, 'loan_late', 'Échéance de prêt impayée — pénalité appliquée', v_amount || ' $', '/client/loans');
    perform notify_all_staff('loan_late', 'Échéance de prêt impayée', l.client_id::text, '/employee/clients');
  else
    perform adjust_trust_score(l.client_id, 1);
    perform notify(l.client_id, 'loan_installment_paid', 'Échéance de prêt prélevée', v_amount || ' $', '/client/loans');
  end if;

  if not exists (select 1 from loan_schedules where loan_id = l.id and status = 'pending') then
    update loans
    set status = 'closed', outstanding_balance = 0, closed_at = now()
    where id = l.id and status = 'active';

    if found then
      perform adjust_trust_score(l.client_id, 3);
      perform notify(l.client_id, 'loan_closed', 'Prêt intégralement remboursé',
        'Toutes vos échéances ont été réglées. Le prêt est soldé.', '/client/loans');
      perform notify_all_staff('loan_closed', 'Prêt soldé',
        (select display_name from profiles where id = l.client_id), '/employee/clients');
      perform log_audit('loan_auto_closed', 'loans', l.id, jsonb_build_object(
        'client', (select display_name from profiles where id = l.client_id)));
    end if;
  end if;

  if (select count(*) from accounts where id = v_client_account and balance < 0) > 0 then
    perform notify(l.client_id, 'account_negative', 'Votre compte est passé en négatif', null, '/client/accounts');
    perform notify_all_staff('account_negative', 'Compte client passé en négatif', l.client_id::text, '/employee/clients');
  end if;
end;
$function$;


-- ----------------------------------------------------------------------------
-- B5. Une échéance qui échoue ne doit pas emporter tout le traitement nocturne
-- ----------------------------------------------------------------------------
create or replace function process_due_loan_installments()
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  s record;
  v_err text;
begin
  for s in select id from loan_schedules where status = 'pending' and due_date <= current_date loop
    begin
      perform repay_loan_installment_now(s.id);
    exception when others then
      v_err := sqlerrm;
      perform notify_all_staff('loan_installment_failed', 'Échéance de prêt non prélevée',
        left(v_err, 200), '/employee/loans');
    end;
  end loop;
end;
$function$;


-- ----------------------------------------------------------------------------
-- Permissions (voir 0015 ; exceptions rappelées en 0021, 0022, 0026 et 0027).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

grant execute on function record_login_attempt(text, boolean) to anon;
grant execute on function gold_price_snapshot() to anon;
revoke execute on function revoke_user_sessions(uuid) from authenticated;

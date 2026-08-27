-- ============================================================================
-- NEWPAD — Migration 0018 : fuite monétaire sur les virements internes
-- ============================================================================
-- Trouvé par vérification de l'invariant de conservation sur les données de
-- production (4ème passe d'audit, 25/08/2026) : la somme de tous les soldes
-- ne correspondait pas à la masse monétaire attendue. La réconciliation
-- compte par compte contre le grand livre a isolé un écart de -0,50 $ sur un
-- compte client, dont voici la cause.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. BUG : la commission d'un virement INTERNE est détruite
-- ----------------------------------------------------------------------------
-- Code d'origine de decide_transfer :
--
--   v_fee := round(t.amount * v_fee_rate / 100, 2);          -- calculée TOUJOURS
--   perform _adjust_balance(t.sender_account_id, -t.amount);
--   perform _adjust_balance(t.recipient_account_id, t.amount - v_fee);
--   if v_fee > 0 and not t.is_internal then
--     perform _adjust_balance(v_bank_account, v_fee);         -- encaissée SI EXTERNE
--   end if;
--   insert into transactions (... fee_amount ...) values
--     (..., case when t.is_internal then 0 else v_fee end, ...);
--
-- Sur un virement interne (entre deux comptes d'un même client), la commission
-- est bel et bien retirée au destinataire (`t.amount - v_fee`) mais n'est
-- créditée à personne : elle sort du système. Trois conséquences :
--   1. de la monnaie est DÉTRUITE à chaque virement interne ;
--   2. le client paie une commission sur un virement entre ses propres
--      comptes, alors que tout le reste du code traite l'interne comme
--      gratuit (pas de montant minimum, fee_amount enregistré à 0) ;
--   3. les livres mentent : la ligne de transaction affiche fee_amount = 0
--      alors qu'une commission a bien été prélevée.
--
-- Correction : la commission vaut zéro sur un virement interne. Les trois
-- mouvements deviennent alors cohérents par construction, quelle que soit la
-- branche — la somme des deltas est toujours nulle.

create or replace function decide_transfer(p_transfer_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  t transfers%rowtype;
  v_sender_client uuid;
  v_recipient_client uuid;
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

  select client_id into v_sender_client from accounts where id = t.sender_account_id;
  select client_id into v_recipient_client from accounts where id = t.recipient_account_id;

  if not p_approve then
    update transfers set status = 'rejected', decided_by = auth.uid(), decided_at = now(), decision_note = p_note
    where id = p_transfer_id;
    perform notify(v_sender_client, 'transfer_rejected', 'Virement refusé', p_note, '/client/transfers');
    perform log_audit('reject_transfer', 'transfers', p_transfer_id, jsonb_build_object(
      'client', (select display_name from profiles where id = v_sender_client), 'amount', t.amount, 'note', p_note));
    return;
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

  -- CORRECTIF 0018 : la commission est nulle sur un virement interne, calculée
  -- une seule fois et utilisée partout — plus aucun écart possible entre le
  -- montant retiré au destinataire, celui encaissé par la banque et celui
  -- inscrit au grand livre.
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

-- ----------------------------------------------------------------------------
-- 2. BUG : un virement d'un compte VERS LUI-MÊME était accepté
-- ----------------------------------------------------------------------------
-- `submit_transfer` vérifiait que le compte émetteur appartient à l'appelant
-- et que le compte destinataire existe, mais jamais qu'ils sont différents.
-- Le seul virement présent en production est exactement ce cas : 50 $ envoyés
-- du compte BNW2605653309 vers ce même compte. L'opération n'a aucun sens
-- économique et, combinée au bug ci-dessus, ne faisait que détruire la
-- commission (-0,50 $ sur ce compte, écart constaté à la réconciliation).

create or replace function submit_transfer(p_sender_account_id uuid, p_recipient_account_id uuid, p_amount numeric, p_motif text)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_client_id uuid;
  v_recipient_client_id uuid;
  v_is_internal boolean;
  v_min_amount numeric;
  v_id uuid;
begin
  -- CORRECTIF 0018
  if p_sender_account_id = p_recipient_account_id then
    raise exception 'Le compte émetteur et le compte destinataire doivent être différents';
  end if;

  select client_id into v_client_id from accounts where id = p_sender_account_id;
  if v_client_id is null or v_client_id != auth.uid() then
    raise exception 'Compte émetteur invalide';
  end if;
  select client_id into v_recipient_client_id from accounts where id = p_recipient_account_id;
  if v_recipient_client_id is null then
    raise exception 'Compte destinataire invalide';
  end if;

  v_is_internal := (v_recipient_client_id = v_client_id);

  if not v_is_internal then
    v_min_amount := coalesce(get_setting_numeric('min_transfer_amount', v_client_id), 100000);
    if p_amount < v_min_amount then
      raise exception 'Le montant minimum de virement est de % $', v_min_amount;
    end if;
  end if;

  if p_amount <= 0 then
    raise exception 'Montant invalide';
  end if;

  insert into transfers (sender_account_id, recipient_account_id, amount, motif, is_internal)
  values (p_sender_account_id, p_recipient_account_id, p_amount, p_motif, v_is_internal)
  returning id into v_id;

  perform notify_all_staff('transfer_request', 'Nouveau virement à traiter', p_amount || ' $', '/employee/transfers');

  return v_id;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 3. Outil de contrôle permanent : vérification de la conservation
-- ----------------------------------------------------------------------------
-- L'invariant qui a permis de trouver le bug ci-dessus n'existait nulle part :
-- il fallait le reconstruire à la main. On l'installe comme fonction, pour
-- qu'un admin (ou une future tâche planifiée) puisse le vérifier à tout
-- moment. Toute ligne renvoyée est une anomalie à instruire.
create or replace function admin_check_ledger_integrity()
returns table (anomalie text, detail text, montant numeric)
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;

  -- a) Transactions à un seul côté : créditent ou débitent sans contrepartie.
  return query
    select 'Transaction sans contrepartie'::text,
           t.tx_type || ' du ' || to_char(t.created_at, 'DD/MM/YYYY') ||
             case when t.from_account_id is null then ' (crédit sans émetteur)' else ' (débit sans destinataire)' end,
           t.amount
    from transactions t
    where t.status = 'validated' and (t.from_account_id is null or t.to_account_id is null);

  -- b) Virements d'un compte vers lui-même.
  return query
    select 'Virement sur le même compte'::text,
           'Transaction ' || t.id::text,
           t.amount
    from transactions t
    where t.tx_type = 'transfer' and t.from_account_id = t.to_account_id;

  -- c) Comptes dont le solde ne correspond pas au grand livre.
  --    Reconstruction : l'émetteur est débité du montant plein, le
  --    destinataire crédité du montant NET de commission, et la commission
  --    crédite la trésorerie (elle n'a pas de ligne de transaction propre,
  --    elle vit dans la colonne fee_amount de la ligne concernée).
  --    Seule exception légitime : la trésorerie porte le capital initial de
  --    la banque (250 M$, posé directement au seed de la migration 0004 sans
  --    transaction de contrepartie — c'est la monnaie de départ du monde RP,
  --    elle ne vient par construction d'aucun compte). On la neutralise.
  return query
    with mouvements as (
      select from_account_id as acc, -amount as delta
        from transactions where status='validated' and from_account_id is not null
      union all
      select to_account_id, amount - coalesce(fee_amount, 0)
        from transactions where status='validated' and to_account_id is not null
      union all
      select (select id from accounts where is_bank_treasury), coalesce(fee_amount, 0)
        from transactions where status='validated' and coalesce(fee_amount, 0) <> 0
    ),
    ecarts as (
      select a.iban,
             coalesce(pr.display_name, 'Trésorerie') as titulaire,
             round(a.balance - coalesce(sum(m.delta), 0)
                   - case when a.is_bank_treasury then 250000000 else 0 end, 2) as ecart
      from accounts a
      left join mouvements m on m.acc = a.id
      left join profiles pr on pr.id = a.client_id
      group by a.id, a.iban, a.balance, a.is_bank_treasury, pr.display_name
    )
    select 'Solde incohérent avec le grand livre'::text,
           e.titulaire || ' (' || e.iban || ')',
           e.ecart
    from ecarts e
    where e.ecart <> 0;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 4. Permissions d'exécution (voir 0015).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

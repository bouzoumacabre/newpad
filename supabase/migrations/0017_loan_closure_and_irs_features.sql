-- ============================================================================
-- NEWPAD — Migration 0017 : clôture automatique des prêts + registre IRS
-- ============================================================================
-- Deux anomalies trouvées par confrontation systématique du code au schéma
-- réel (3ème passe d'audit, 25/08/2026).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. BUG : un prêt remboursé normalement n'est JAMAIS clôturé
-- ----------------------------------------------------------------------------
-- `repay_loan_early` (remboursement anticipé) fait bien passer le prêt en
-- 'closed' avec closed_at renseigné. Mais le chemin NORMAL — le client paie
-- ses échéances une par une via la tâche planifiée quotidienne — ne le fait
-- nulle part : `repay_loan_installment_now` se contente de décrémenter
-- outstanding_balance.
--
-- Conséquence : un client qui rembourse intégralement son prêt, dans les
-- temps, se retrouve avec outstanding_balance = 0, toutes ses échéances
-- réglées... et un prêt qui reste 'active' avec closed_at null, pour
-- toujours. Il apparaît donc éternellement endetté sur son propre écran
-- (`/client/loans` affiche « Solder » et le solde restant tant que
-- status = 'active') comme au registre du personnel.
--
-- Aucun prêt n'a encore atteint ce stade en production (le seul prêt en base
-- est encore en attente d'approbation) : la correction est préventive, mais
-- le bug était certain dès le premier prêt mené à son terme.
--
-- Note sur le statut d'échéance : une échéance payée AVEC pénalité de retard
-- est marquée 'late' (et non 'paid'), l'énumération installment_status ne
-- proposant que pending|paid|late. C'est volontaire — l'information « a été
-- payée en retard » doit être conservée — mais l'écran client affichait donc
-- « En retard » sur une échéance pourtant réglée. Corrigé côté frontend en
-- s'appuyant sur `paid_at`, qui distingue déjà les deux cas dans les données,
-- plutôt qu'en touchant à l'énumération (modification bien plus risquée).
-- La clôture ci-dessous ne teste que 'pending' : une échéance payée en
-- retard n'empêche donc jamais un prêt d'être soldé.

create or replace function repay_loan_installment_now(p_schedule_id uuid)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  s loan_schedules%rowtype;
  l loans%rowtype;
  v_client_account uuid;
  v_bank_account uuid;
  v_tx_id uuid;
  v_penalty_rate numeric;
  v_penalty numeric := 0;
  v_amount numeric;
begin
  select * into s from loan_schedules where id = p_schedule_id and status = 'pending' for update;
  if s is null then raise exception 'Échéance introuvable'; end if;
  select * into l from loans where id = s.loan_id;

  select id into v_client_account from accounts where client_id = l.client_id and status='active' order by is_bank_treasury, opened_at limit 1;
  v_bank_account := bank_treasury_account_id();

  if s.due_date < current_date then
    v_penalty_rate := coalesce(get_setting_numeric('loan_late_penalty_rate', l.client_id), 5) / 100;
    v_penalty := round(s.amount_due * v_penalty_rate, 2);
  end if;
  v_amount := s.amount_due + v_penalty;

  -- Le prélèvement s'effectue même à découvert (jamais bloqué)
  perform _adjust_balance(v_client_account, -v_amount);
  perform _adjust_balance(v_bank_account, v_amount);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, related_request_type, related_request_id, created_by)
  values ('loan_repayment', 'validated', v_client_account, v_bank_account, v_amount,
    'Échéance prêt #' || s.installment_number || case when v_penalty > 0 then ' (+ pénalité de retard)' else '' end,
    'loan_schedules', s.id, null)
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

  -- ---- CORRECTIF 0017 : clôture du prêt à la dernière échéance ------------
  -- Plus aucune échéance en attente => le prêt est intégralement remboursé.
  -- Le garde `status = 'active'` évite de rouvrir/écraser un prêt déjà soldé
  -- par anticipation (repay_loan_early l'a alors déjà passé en 'closed').
  if not exists (
    select 1 from loan_schedules where loan_id = l.id and status = 'pending'
  ) then
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

-- Rattrapage des prêts éventuellement déjà bloqués dans cet état (aucun à ce
-- jour, mais la requête est sans risque et rend la migration rejouable si le
-- correctif est appliqué plus tard sur une base déjà vécue).
update loans l
set status = 'closed', outstanding_balance = 0, closed_at = coalesce(closed_at, now())
where l.status = 'active'
  and exists (select 1 from loan_schedules s where s.loan_id = l.id)
  and not exists (select 1 from loan_schedules s where s.loan_id = l.id and s.status = 'pending');

-- ----------------------------------------------------------------------------
-- 2. INCOHÉRENCE : l'interface IRS échappait entièrement au registre
-- ----------------------------------------------------------------------------
-- `src/pages/irs/shell.js` filtre bien ses 4 entrées de menu sur
-- has('irs.clients.view'), has('irs.accounts.view'), has('irs.transactions.view')
-- et has('irs.gold.view')... mais aucune de ces clés n'a jamais été insérée au
-- registre. Or `has()` renvoie `true` par défaut quand la clé est absente des
-- drapeaux résolus : les 4 entrées étaient donc toujours affichées, et surtout
-- l'admin n'avait aucun moyen de les désactiver depuis /admin/permissions,
-- contrairement aux 3 autres interfaces. Le registre se voulait générique
-- pour les 4 rôles — l'IRS en était sorti par simple oubli d'insertion.
insert into feature_registry (key, label, area, category, default_roles, enabled, is_core) values
  ('irs.clients.view',      'Registre des clients',      'irs', 'Consultation', '{irs}', true, false),
  ('irs.accounts.view',     'Registre des comptes',      'irs', 'Consultation', '{irs}', true, false),
  ('irs.transactions.view', 'Registre des transactions', 'irs', 'Consultation', '{irs}', true, false),
  ('irs.gold.view',         "Registre des lingots d'or", 'irs', 'Consultation', '{irs}', true, false)
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- 3. Permissions d'exécution (voir 0015 : PostgreSQL accorde EXECUTE à PUBLIC
--    par défaut sur toute fonction recréée).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

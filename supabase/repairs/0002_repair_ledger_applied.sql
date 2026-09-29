-- ============================================================================
-- NEWPAD — RÉPARATION DES LIVRES (APPLIQUÉE LE 29/09/2026)
-- ============================================================================
-- Décision de l'utilisateur : « réparer les livres » (option A de 0001) et
-- « passer en perte » les deux comptes clôturés à −2 490 $. Remplace 0001,
-- dont le §2 était faux (voir plus bas). Essayé à blanc dans une transaction
-- annulée avant application ; contrôle d'intégrité propre après.
--
-- Aucun joueur ne perd d'argent : seule la trésorerie de la banque paie.
-- ============================================================================

begin;

do $$
declare v_treasury uuid := bank_treasury_account_id(); v_total numeric; v_count int; v_acc record;
begin
  -- §1 — 3 004 531 $ de dépôts d'ouverture jamais payés par la trésorerie
  -- (antérieurs au correctif 0010). La trésorerie les paie ; le grand livre
  -- indique enfin d'où venait l'argent.
  select count(*), coalesce(sum(amount), 0) into v_count, v_total
    from transactions where status = 'validated' and from_account_id is null;
  if v_count <> 9 or v_total <> 3004531.00 then
    raise exception 'Dépôts orphelins inattendus (% / %) : ne pas réparer sans comprendre', v_count, v_total;
  end if;
  perform _adjust_balance(v_treasury, -v_total);
  update transactions set from_account_id = v_treasury
   where status = 'validated' and from_account_id is null;

  -- §2 — 0,50 $ détruits par la commission d'un virement interne (avant 0018).
  -- Ils avaient été retirés du solde SANS ligne au grand livre : on les rend
  -- au solde, sans ligne non plus. (Le 0001 les faisait payer par la
  -- trésorerie avec une ligne : solde et grand livre montaient ensemble,
  -- l'écart de 0,50 $ restait signalé.)
  perform _adjust_balance((select id from accounts where iban = 'BNW2605653309'), 0.50);

  -- §3 — deux comptes clôturés à −2 490 $ (clôture avec dette, refusée depuis
  -- 0032) : dette passée en perte, la trésorerie l'absorbe.
  for v_acc in select id, balance from accounts where status = 'closed' and balance < 0 loop
    perform _adjust_balance(v_acc.id, -v_acc.balance);
    perform _adjust_balance(v_treasury, v_acc.balance);
    insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
    values ('admin_adjustment', 'validated', v_treasury, v_acc.id, -v_acc.balance,
            'Passage en perte : dette d''un compte clôturé avant le correctif 0032', null);
  end loop;
end $$;

insert into audit_log (actor_id, actor_role, action, target_type, target_id, details)
values (null, 'admin', 'data_repair_ledger', 'transactions', null,
        jsonb_build_object(
          'motif', 'Dépôts orphelins (0010), commission détruite (0018), dettes de comptes clôturés (0032)',
          'decision', 'Réparer les livres + passer en perte, décision de l''exploitant',
          'date_reparation', now()));

commit;

-- Après : admin_check_ledger_integrity() ne signale plus que le virement
-- d'août vers le même compte (trace historique, interdit depuis 0018) et
-- l'information sur l'émission monétaire cumulée.

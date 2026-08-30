-- ============================================================================
-- NEWPAD — RÉPARATION DE DONNÉES (À NE PAS EXÉCUTER SANS DÉCISION EXPLICITE)
-- ============================================================================
-- Ce fichier n'est PAS une migration : il ne décrit pas le schéma, il modifie
-- des soldes réels. Il est rangé à part (`supabase/repairs/`) précisément pour
-- qu'il ne parte jamais dans une application automatique de migrations.
--
-- Il corrige deux anomalies monétaires constatées sur la base de production le
-- 25/08/2026, dont les causes sont déjà corrigées dans le code (migrations
-- 0010 et 0018) mais dont les DONNÉES n'ont jamais été rattrapées.
--
-- POURQUOI CE N'EST PAS APPLIQUÉ D'OFFICE : les deux corrections déplacent de
-- l'argent dans une économie de jeu de rôle en cours. C'est une décision de
-- game design, pas une décision technique. Trois options légitimes :
--   (A) tout réparer (ci-dessous) — les livres de la banque redeviennent exacts ;
--   (B) ne rien faire — l'écart reste, mais aucun joueur n'est lésé ni surpris ;
--   (C) réparer la trésorerie sans toucher aux comptes clients (§1 seul).
-- ============================================================================


-- ----------------------------------------------------------------------------
-- §1 — 3 004 531,00 $ créés depuis rien (9 dépôts d'ouverture, 17-18/08/2026)
-- ----------------------------------------------------------------------------
-- Avant la migration 0010 (18/08), `decide_membership_request` et
-- `finalize_manual_account_opening` créditaient le compte du nouveau client
-- sans jamais débiter la trésorerie : l'argent apparaissait de nulle part. Le
-- code a été corrigé le jour même, mais les 9 dépôts déjà effectués n'ont
-- jamais été rattrapés — la trésorerie n'a jamais payé ces 3 004 531 $.
--
-- Les 9 lignes concernées portent `from_account_id = NULL` (crédit sans
-- contrepartie), ce qui les rend faciles à identifier de façon certaine.
--
-- IMPORTANT : cette réparation ne retire RIEN aux clients. Leur argent est
-- légitime, ils l'ont reçu à l'ouverture de leur compte. Elle corrige
-- uniquement les livres de la banque, qui auraient dû être débités.
-- Effet : trésorerie -3 004 531,00 $.

begin;

-- Vérification préalable — à lire avant de valider :
--   select count(*), sum(amount) from transactions
--   where status='validated' and from_account_id is null;
-- Doit renvoyer 9 lignes / 3004531.00. Si les chiffres diffèrent, NE PAS
-- CONTINUER : d'autres dépôts orphelins ont été créés depuis, il faut
-- comprendre pourquoi avant de réparer.

do $$
declare
  v_total numeric;
  v_count int;
  v_treasury uuid;
begin
  select count(*), coalesce(sum(amount), 0) into v_count, v_total
  from transactions where status = 'validated' and from_account_id is null;

  if v_count = 0 then
    raise notice 'Aucun dépôt orphelin : rien à réparer.';
    return;
  end if;

  v_treasury := bank_treasury_account_id();

  -- 1. La trésorerie paie enfin ces dépôts.
  perform _adjust_balance(v_treasury, -v_total);

  -- 2. Le grand livre devient cohérent : ces dépôts viennent de la trésorerie.
  update transactions
  set from_account_id = v_treasury
  where status = 'validated' and from_account_id is null;

  raise notice 'Réparé : % dépôts orphelins, % $ débités de la trésorerie.', v_count, v_total;
end $$;

-- Journalisation de l'opération (traçabilité : une réparation manuelle doit
-- rester visible dans le journal d'activité au même titre qu'une décision).
insert into audit_log (actor_id, actor_role, action, target_type, target_id, details)
select null, 'admin', 'data_repair_phantom_deposits', 'transactions', null,
       jsonb_build_object(
         'motif', 'Rattrapage des dépôts d''ouverture antérieurs au correctif 0010',
         'date_reparation', now());

commit;


-- ----------------------------------------------------------------------------
-- §2 — 0,50 $ détruits par la commission d'un virement interne
-- ----------------------------------------------------------------------------
-- Avant la migration 0018, `decide_transfer` retirait la commission au
-- destinataire d'un virement interne sans la créditer à personne : elle
-- sortait du système. Un seul virement est concerné en production (50 $ du
-- compte BNW2605653309 vers lui-même, 17/08/2026), soit 0,50 $ détruits au
-- détriment du client.
--
-- Effet : le compte client retrouve ses 0,50 $, la trésorerie les paie.
-- Montant symbolique — l'intérêt est la cohérence des livres, pas la somme.

begin;

do $$
declare
  v_account uuid;
  v_treasury uuid;
  v_amount numeric := 0.50;
begin
  select id into v_account from accounts where iban = 'BNW2605653309';
  if v_account is null then
    raise notice 'Compte introuvable — réparation §2 ignorée.';
    return;
  end if;

  v_treasury := bank_treasury_account_id();

  perform _adjust_balance(v_account, v_amount);
  perform _adjust_balance(v_treasury, -v_amount);

  insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
  values ('admin_adjustment', 'validated', v_treasury, v_account, v_amount,
          'Régularisation : commission indûment prélevée sur un virement interne (correctif 0018)', null);

  raise notice 'Réparé : % $ restitués au compte BNW2605653309.', v_amount;
end $$;

commit;


-- ----------------------------------------------------------------------------
-- VÉRIFICATION APRÈS RÉPARATION
-- ----------------------------------------------------------------------------
-- Connecté en tant qu'admin depuis l'application :
--   select * from admin_check_ledger_integrity();
-- Doit ne renvoyer AUCUNE ligne. Toute ligne restante est une anomalie que
-- cette réparation ne couvre pas — à instruire avant d'aller plus loin.
--
-- Contrôle direct de la masse monétaire (250 M$ = capital initial du seed) :
--   select sum(balance) from accounts;   -- doit valoir exactement 250000000.00

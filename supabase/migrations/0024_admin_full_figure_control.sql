-- ============================================================================
-- NEWPAD — Migration 0024 : contrôle admin complet sur tous les chiffres
-- ============================================================================
-- Étape 3 (suite) — demande explicite : pouvoir modifier depuis l'interface
-- admin n'importe quel montant (solde client, trésorerie de la banque, montant
-- d'une transaction passée), chaque modification réajustant automatiquement
-- tout le reste.
-- ============================================================================
--
-- LE PRINCIPE RETENU
--
-- « Réajuster automatiquement tout le reste » ne peut pas vouloir dire écrire
-- un nombre dans une colonne et partir : le solde d'un compte n'est pas une
-- opinion, c'est la somme de son historique. Écraser l'un sans l'autre rend
-- les deux faux et fait immédiatement sonner le contrôle d'intégrité du grand
-- livre (migration 0018).
--
-- Toute modification admin écrit donc SA CONTREPARTIE au grand livre. Le solde
-- affiché reste, à chaque instant, exactement égal à son historique — c'est
-- précisément ça, le réajustement automatique.
--
-- Deux natures de contrepartie, au choix de l'admin :
--
--   'treasury'  — l'argent vient de la banque ou y retourne. La masse
--                 monétaire totale du serveur ne change pas. C'est le cas
--                 normal : créditer un client appauvrit la banque d'autant.
--
--   'issuance'  — émission monétaire : de l'argent est créé à partir de rien,
--                 ou détruit. La masse totale change délibérément. C'est le
--                 geste de maître du jeu, réservé aux cas où l'on veut
--                 vraiment injecter ou retirer de la valeur du monde.
--
-- Une émission s'écrit comme une transaction `money_issuance` à un seul côté
-- — c'est la seule écriture unilatérale légitime du système, et le contrôle
-- d'intégrité la reconnaît comme telle (voir §4). Toutes les autres restent
-- des anomalies.


-- ----------------------------------------------------------------------------
-- 1. Ajustement de solde — avec choix de la contrepartie
-- ----------------------------------------------------------------------------
-- L'ancienne version imposait la trésorerie comme contrepartie et REFUSAIT
-- explicitement de toucher au compte de la banque. Les deux limites sautent.
-- La signature reste compatible : sans quatrième argument, le comportement
-- est identique à avant.

create or replace function admin_adjust_account_balance(
  p_account_id uuid,
  p_amount numeric,
  p_note text default null,
  p_counterpart text default 'treasury'
) returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_bank_account uuid;
  v_tx_id uuid;
  v_client uuid;
  v_is_treasury boolean;
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  if p_amount is null or p_amount = 0 then raise exception 'Le montant ne peut pas être nul'; end if;
  if p_counterpart not in ('treasury', 'issuance') then
    raise exception 'Contrepartie invalide : « treasury » (mouvement depuis la banque) ou « issuance » (émission monétaire)';
  end if;

  select client_id, is_bank_treasury into v_client, v_is_treasury
  from accounts where id = p_account_id;
  if not found then raise exception 'Compte introuvable'; end if;

  v_bank_account := bank_treasury_account_id();

  -- Ajuster la trésorerie contre elle-même n'aurait aucun effet.
  if p_account_id = v_bank_account and p_counterpart = 'treasury' then
    raise exception 'Pour modifier la trésorerie de la banque, utilisez l''émission monétaire — un mouvement de la banque vers elle-même est sans effet';
  end if;

  if p_counterpart = 'treasury' then
    perform _adjust_balance(p_account_id, p_amount);
    perform _adjust_balance(v_bank_account, -p_amount);

    insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
    values (
      'admin_adjustment', 'validated',
      case when p_amount < 0 then p_account_id else v_bank_account end,
      case when p_amount < 0 then v_bank_account else p_account_id end,
      abs(p_amount),
      coalesce('Ajustement manuel admin — ' || p_note, 'Ajustement manuel admin'),
      auth.uid()
    ) returning id into v_tx_id;
  else
    -- Émission monétaire : un seul côté, l'autre étant « hors du monde ».
    perform _adjust_balance(p_account_id, p_amount);

    insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
    values (
      'money_issuance', 'validated',
      case when p_amount < 0 then p_account_id else null end,
      case when p_amount < 0 then null else p_account_id end,
      abs(p_amount),
      coalesce(
        case when p_amount < 0 then 'Retrait de monnaie (admin) — ' else 'Émission de monnaie (admin) — ' end || p_note,
        case when p_amount < 0 then 'Retrait de monnaie (admin)' else 'Émission de monnaie (admin)' end
      ),
      auth.uid()
    ) returning id into v_tx_id;
  end if;

  if v_client is not null then
    perform notify(v_client, 'admin_adjustment', 'Ajustement de solde par la banque', p_note, '/client/accounts');
  end if;

  perform log_audit('admin_adjust_account_balance', 'accounts', p_account_id, jsonb_build_object(
    'amount', p_amount, 'counterpart', p_counterpart, 'note', p_note));
  return v_tx_id;
end;
$function$;


-- ----------------------------------------------------------------------------
-- 2. Fixer un solde à une valeur absolue
-- ----------------------------------------------------------------------------
-- « Je veux pouvoir tout modifier » se traduit, dans une interface, par : je
-- tape le nombre que je veux voir. Cette fonction calcule elle-même l'écart et
-- le passe par la machinerie ci-dessus — le grand livre reste donc complet.

create or replace function admin_set_account_balance(
  p_account_id uuid,
  p_new_balance numeric,
  p_note text default null,
  p_counterpart text default 'treasury'
) returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_current numeric;
  v_delta numeric;
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  if p_new_balance is null then raise exception 'Le nouveau solde est obligatoire'; end if;

  select balance into v_current from accounts where id = p_account_id;
  if not found then raise exception 'Compte introuvable'; end if;

  v_delta := round(p_new_balance - v_current, 2);
  if v_delta = 0 then
    raise exception 'Ce compte est déjà à % $', p_new_balance;
  end if;

  return admin_adjust_account_balance(
    p_account_id,
    v_delta,
    coalesce(p_note, 'Solde fixé à ' || p_new_balance || ' $'),
    p_counterpart
  );
end;
$function$;


-- ----------------------------------------------------------------------------
-- 3. Corriger le montant (et la commission) d'une transaction passée
-- ----------------------------------------------------------------------------
-- Jusqu'ici seule la DESCRIPTION d'une transaction était modifiable, pour
-- préserver l'intégrité comptable. La corriger vraiment est possible à une
-- condition : répercuter l'écart sur les soldes des comptes concernés, sinon
-- l'historique et les soldes divergent aussitôt.
--
-- Rappel du mécanisme d'un virement, pour comprendre la répercussion :
--     émetteur    -= montant
--     destinataire += montant - commission
--     banque       += commission
-- Corriger le montant de Δ revient donc à : émetteur -= Δ, destinataire += Δ.
-- Corriger la commission de Δf : destinataire -= Δf, banque += Δf.
-- Les deux se combinent sans se gêner.
--
-- Les côtés nuls (émission monétaire, dépôts orphelins historiques) sont
-- simplement ignorés dans la répercussion.

create or replace function admin_correct_transaction_amount(
  p_transaction_id uuid,
  p_new_amount numeric,
  p_note text default null,
  p_new_fee numeric default null
) returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  t transactions%rowtype;
  v_bank_account uuid;
  v_delta numeric;
  v_delta_fee numeric;
  v_new_fee numeric;
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  if p_new_amount is null or p_new_amount < 0 then
    raise exception 'Le nouveau montant doit être positif ou nul';
  end if;

  select * into t from transactions where id = p_transaction_id for update;
  if not found then raise exception 'Transaction introuvable'; end if;

  v_new_fee := coalesce(p_new_fee, t.fee_amount, 0);
  if v_new_fee < 0 then raise exception 'La commission ne peut pas être négative'; end if;
  if v_new_fee > p_new_amount then
    raise exception 'La commission (% $) ne peut pas dépasser le montant (% $)', v_new_fee, p_new_amount;
  end if;

  v_delta     := round(p_new_amount - t.amount, 2);
  v_delta_fee := round(v_new_fee - coalesce(t.fee_amount, 0), 2);

  if v_delta = 0 and v_delta_fee = 0 then
    raise exception 'Cette transaction porte déjà ce montant et cette commission';
  end if;

  v_bank_account := bank_treasury_account_id();

  -- Répercussion sur les soldes (les côtés absents sont ignorés).
  if t.from_account_id is not null and v_delta <> 0 then
    perform _adjust_balance(t.from_account_id, -v_delta);
  end if;
  if t.to_account_id is not null then
    perform _adjust_balance(t.to_account_id, v_delta - v_delta_fee);
  end if;
  if v_delta_fee <> 0 then
    perform _adjust_balance(v_bank_account, v_delta_fee);
  end if;

  update transactions
  set amount = p_new_amount,
      fee_amount = v_new_fee,
      description = coalesce(description, '') ||
        ' [corrigé le ' || to_char(now(), 'DD/MM/YYYY') ||
        case when p_note is not null and trim(p_note) <> '' then ' : ' || trim(p_note) else '' end || ']'
  where id = p_transaction_id;

  perform log_audit('admin_correct_transaction_amount', 'transactions', p_transaction_id, jsonb_build_object(
    'ancien_montant', t.amount, 'nouveau_montant', p_new_amount,
    'ancienne_commission', t.fee_amount, 'nouvelle_commission', v_new_fee,
    'note', p_note));
end;
$function$;


-- ----------------------------------------------------------------------------
-- 4. Le contrôle d'intégrité reconnaît l'émission monétaire
-- ----------------------------------------------------------------------------
-- Une émission est délibérée, typée et tracée : ce n'est pas une anomalie.
-- Elle est donc retirée de la règle « transaction sans contrepartie » — qui
-- continue de signaler toutes les autres, dont les 9 dépôts orphelins de
-- 2026 — et intégrée à la masse monétaire attendue, pour que la
-- reconstruction des soldes reste juste.
-- Une ligne d'information récapitule le total émis, afin que l'admin voie
-- toujours de combien la masse a été gonflée ou réduite à la main.

create or replace function admin_check_ledger_integrity()
returns table (anomalie text, detail text, montant numeric)
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;

  -- a) Transactions à un seul côté, hors émissions monétaires assumées.
  return query
    select 'Transaction sans contrepartie'::text,
           t.tx_type || ' du ' || to_char(t.created_at, 'DD/MM/YYYY') ||
             case when t.from_account_id is null then ' (crédit sans émetteur)' else ' (débit sans destinataire)' end,
           t.amount
    from transactions t
    where t.status = 'validated'
      and t.tx_type <> 'money_issuance'
      and (t.from_account_id is null or t.to_account_id is null);

  -- b) Virements d'un compte vers lui-même.
  return query
    select 'Virement sur le même compte'::text,
           'Transaction ' || t.id::text,
           t.amount
    from transactions t
    where t.tx_type = 'transfer' and t.from_account_id = t.to_account_id;

  -- c) Soldes incohérents avec le grand livre.
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

  -- d) Information (pas une anomalie) : masse monétaire créée à la main.
  return query
    select 'Émission monétaire cumulée (information)'::text,
           count(*)::text || ' opération(s) admin depuis l''origine',
           round(sum(case when t.to_account_id is not null then t.amount else -t.amount end), 2)
    from transactions t
    where t.status = 'validated' and t.tx_type = 'money_issuance'
    having count(*) > 0;
end;
$function$;


-- ----------------------------------------------------------------------------
-- 5. Registre de fonctionnalités et permissions d'exécution
-- ----------------------------------------------------------------------------
insert into feature_registry (key, label, area, category, default_roles, enabled, is_core) values
  ('admin.treasury.manage', 'Trésorerie & émission monétaire', 'admin', 'Administration', '{admin}', true, false)
on conflict (key) do nothing;

revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

grant execute on function record_login_attempt(text, boolean) to anon;
revoke execute on function revoke_user_sessions(uuid) from authenticated;

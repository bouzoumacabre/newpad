-- ============================================================================
-- NEWPAD — Migration 0033 : permissions, masquage, file d'attente, CMS
-- ============================================================================
-- Audit fonctionnalité par fonctionnalité — étape 8.
-- État constaté avant correction : 31 fonctionnalités au registre (toutes
-- activées), 0 exception par compte, 0 masque posé, 0 entrée en file d'attente,
-- 15 blocs de contenu public. Toutes les corrections sont donc préventives.
-- ============================================================================


-- ############################################################################
-- PARTIE A — LE SYSTÈME DE PERMISSIONS NE BLOQUAIT RIEN
-- ############################################################################

-- ----------------------------------------------------------------------------
-- A1. Aucune fonction serveur n'appelait `has_feature`
-- ----------------------------------------------------------------------------
-- `has_feature(key)` existe depuis l'origine et résout correctement registre +
-- rôle par défaut + exception par compte. Mais elle n'était appelée par AUCUNE
-- fonction métier : recherche faite sur les 200+ fonctions du schéma, zéro
-- occurrence.
--
-- Tout l'écran /admin/permissions — 31 fonctionnalités, les exceptions par
-- compte, le registre entier — ne faisait donc que MASQUER DES BOUTONS dans le
-- navigateur. Décocher « Créer un virement » retirait l'entrée de la barre
-- latérale, et `submit_transfer` restait intégralement appelable via l'API
-- REST, avec la clé publique que tout client possède déjà.
--
-- Un interrupteur qui n'éteint rien est pire que pas d'interrupteur du tout :
-- l'admin croit avoir fermé une porte.
--
-- Le contrôle est en outre à défaut permissif côté navigateur :
--
--     const has = (key) => (key in flags ? flags[key] : true);
--
-- une clé absente — parce que la requête a échoué, ou parce qu'elle appartient
-- à une autre « zone » que celle interrogée — vaut « autorisé ». Défendable
-- pour l'affichage, intenable comme contrôle d'accès.

create or replace function require_feature(p_key text)
returns void
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_label text;
begin
  if has_feature(p_key) then return; end if;
  select label into v_label from feature_registry where key = p_key;
  raise exception 'Fonctionnalité indisponible : %', coalesce(v_label, p_key)
    using hint = 'Cette fonctionnalité a été désactivée par l''administration.';
end;
$function$;


-- ----------------------------------------------------------------------------
-- A2. L'interrupteur global ne coupait pas pour l'admin
-- ----------------------------------------------------------------------------
-- `has_feature` renvoyait `true` pour l'admin AVANT de regarder si la
-- fonctionnalité était globalement activée :
--
--     if v_role = 'admin' then return true; end if;
--     select default_roles, enabled into ...
--
-- Les 12 clés `admin.*` du registre ne pouvaient donc rien produire, et surtout
-- décocher « Frapper de nouveaux lingots » n'empêchait pas l'admin de frapper
-- des lingots. L'interrupteur affichait « désactivé » en restant ouvert pour le
-- seul rôle qui s'en sert.
--
-- Désormais `enabled = false` coupe pour TOUT LE MONDE, admin compris — c'est
-- ce que « désactivée » veut dire. L'exception par compte, elle, conserve le
-- passe-droit administrateur.
--
-- Deux clés restent inconditionnellement ouvertes à l'admin :
-- `admin.permissions.manage` et `admin.system.config`. Sans elles, décocher la
-- mauvaise case enfermerait l'administration dehors, sans retour possible
-- depuis l'interface.

create or replace function has_feature(p_key text, p_uid uuid default auth.uid())
returns boolean
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_role user_role;
  v_default_roles user_role[];
  v_enabled boolean;
  v_override boolean;
begin
  select role into v_role from profiles where id = p_uid;
  if v_role is null then return false; end if;

  if v_role = 'admin' and p_key in ('admin.permissions.manage', 'admin.system.config') then
    return true;
  end if;

  select default_roles, enabled into v_default_roles, v_enabled
  from feature_registry where key = p_key;

  if v_default_roles is null then return false; end if;
  if not v_enabled then return false; end if;

  if v_role = 'admin' then return true; end if;

  select granted into v_override
  from permission_grants where account_id = p_uid and feature_key = p_key;

  if v_override is not null then
    return v_override;
  end if;

  return v_role = any(v_default_roles);
end;
$function$;


-- ----------------------------------------------------------------------------
-- A3. Résolution des fonctionnalités côté serveur, pour l'affichage
-- ----------------------------------------------------------------------------
-- Le navigateur recalculait lui-même registre + exceptions, zone par zone.
-- Deux implémentations de la même règle finissent toujours par diverger.
create or replace function my_feature_flags()
returns table(key text, area text, label text, allowed boolean)
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then return; end if;
  return query
  select f.key, f.area, f.label, has_feature(f.key) from feature_registry f order by f.key;
end;
$function$;


-- ----------------------------------------------------------------------------
-- A4. Application du contrôle aux portes d'entrée
-- ----------------------------------------------------------------------------
-- `perform require_feature('...')` est injecté en tête du corps de chaque
-- fonction concernée, avant tout contrôle métier. Le reste du corps n'est pas
-- réécrit : la définition existante est relue puis réinjectée avec cette seule
-- ligne en plus, ce qui évite de recopier à la main une vingtaine de fonctions
-- (et d'y introduire une divergence, comme cela a failli arriver ici même avec
-- `staff_list_transactions`).
do $do$
declare
  m record;
  v_def text;
  v_new text;
begin
  for m in
    select * from (values
      -- Portes client
      ('submit_transfer',                 'client.transfers.create'),
      ('submit_gold_bank_purchase',       'client.gold.buy_bank'),
      ('create_market_listing',           'client.gold.market'),
      ('submit_market_purchase',          'client.gold.market'),
      ('cancel_market_listing',           'client.gold.market'),
      ('submit_loan_request',             'client.loans.request'),
      ('submit_safe_request',             'client.safes.request'),
      ('submit_consulting_request',       'client.consulting'),
      ('create_support_ticket',           'client.support'),
      -- Portes personnel
      ('claim_transfer',                  'employee.transfers.process'),
      ('decide_transfer',                 'employee.transfers.process'),
      ('claim_safe_request',              'employee.safes.process'),
      ('confirm_safe_rental',             'employee.safes.process'),
      ('reject_safe_request',             'employee.safes.process'),
      ('staff_decide_safe_request',       'employee.safes.process'),
      ('decide_gold_bank_purchase',       'employee.gold.process'),
      ('decide_market_purchase',          'employee.gold.process'),
      ('employee_review_loan',            'employee.loans.review'),
      ('claim_membership_request',        'employee.membership.review'),
      ('decide_membership_request',       'employee.membership.review'),
      ('finalize_manual_account_opening', 'employee.accounts.open'),
      ('create_fraud_alert',              'employee.fraud.flag'),
      -- Portes admin
      ('admin_decide_loan',               'admin.loans.decide'),
      ('mint_gold_bar',                   'admin.gold.mint'),
      ('admin_update_gold_bar',           'admin.gold.edit_registry'),
      ('admin_set_account_balance',       'admin.treasury.manage'),
      ('admin_correct_transaction_amount','admin.treasury.manage'),
      ('admin_set_visibility_mask',       'admin.masking.manage')
    ) as t(fn, key)
  loop
    if not exists (select 1 from feature_registry where key = m.key) then
      raise exception 'Clé de fonctionnalité inconnue au registre : %', m.key;
    end if;

    select pg_get_functiondef(p.oid) into v_def
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = m.fn;

    if v_def is null then
      raise exception 'Fonction introuvable : %', m.fn;
    end if;
    if v_def ilike '%require_feature(%' then
      continue;  -- déjà protégée (migration rejouée)
    end if;

    -- Le premier `begin` sur sa propre ligne est celui du bloc extérieur.
    v_new := regexp_replace(v_def, E'\nbegin\n',
               E'\nbegin\n  perform require_feature(''' || m.key || E''');\n');
    if v_new = v_def then
      raise exception 'Point d''injection introuvable dans %', m.fn;
    end if;
    execute v_new;
  end loop;
end
$do$;


-- ----------------------------------------------------------------------------
-- A5. Deux versions concurrentes d'`admin_adjust_account_balance`
-- ----------------------------------------------------------------------------
-- La migration 0024 a ajouté le paramètre `p_counterpart` (trésorerie ou
-- émission monétaire) en créant une NOUVELLE signature à quatre arguments —
-- l'ancienne à trois est restée en place. Deux fonctions du même nom
-- coexistaient donc, dont une qui ignore la contrepartie et n'a pas les
-- garde-fous ajoutés à l'étape 3. L'interface appelle la bonne, mais rien
-- n'empêchait d'appeler l'autre.
drop function if exists admin_adjust_account_balance(uuid, numeric, text);


-- ############################################################################
-- PARTIE B — MASQUAGE PAR INTERFACE
-- ############################################################################

-- ----------------------------------------------------------------------------
-- B1. Le masquage ne s'appliquait pas à l'écran où il sert le plus
-- ----------------------------------------------------------------------------
-- Les policies RLS d'`accounts` et `transactions` appellent bien
-- `visible_for_current_role(...)` : une lecture DIRECTE de ces tables respecte
-- les masques. Mais une fonction `SECURITY DEFINER` contourne RLS par
-- construction — et `staff_list_transactions`, qui alimente
-- /employee/transactions et /admin/transactions, ne rétablissait pas le
-- contrôle. Masquer une transaction « de l'interface employé » ne la masquait
-- donc pas de l'écran employé : le cas d'usage principal de la fonctionnalité
-- était précisément le seul à ne rien faire.
--
-- (Les registres IRS, eux, appellent déjà `is_masked_for`. Et `client` ou
-- `lingot` ne sont pas des cibles masquables : l'énumération
-- `visibility_target` ne connaît que `account` et `transaction`.)

create or replace function staff_list_transactions(p_search text default null, p_tx_type text default null, p_category_id uuid default null, p_limit integer default 300)
returns table(id uuid, tx_type text, status request_status, amount numeric, fee_amount numeric,
              from_label text, to_label text, from_client_id uuid, to_client_id uuid,
              description text, created_at timestamptz)
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  return query
  select t.id, t.tx_type, t.status, t.amount, t.fee_amount,
    coalesce(pf.display_name, case when af.is_bank_treasury then 'Newman Bank (trésorerie)' else null end, 'Externe'),
    coalesce(pt.display_name, case when at_.is_bank_treasury then 'Newman Bank (trésorerie)' else null end, 'Externe'),
    af.client_id, at_.client_id,
    t.description, t.created_at
  from transactions t
  left join accounts af on af.id = t.from_account_id
  left join accounts at_ on at_.id = t.to_account_id
  left join profiles pf on pf.id = af.client_id
  left join profiles pt on pt.id = at_.client_id
  where visible_for_current_role('transaction', t.id)   -- CORRECTIF 0033
    and (p_search is null or p_search = '' or t.description ilike '%'||p_search||'%' or pf.display_name ilike '%'||p_search||'%' or pt.display_name ilike '%'||p_search||'%')
    and (p_tx_type is null or t.tx_type = p_tx_type)
    and (p_category_id is null or exists (
      select 1 from client_category_links ccl
      where ccl.category_id = p_category_id and ccl.client_id in (af.client_id, at_.client_id)
    ))
  order by t.created_at desc
  limit p_limit;
end;
$function$;


-- ############################################################################
-- PARTIE C — FILE D'ATTENTE DU GUICHET
-- ############################################################################

-- ----------------------------------------------------------------------------
-- C1. Un client pouvait s'inscrire lui-même en file, dans l'état de son choix
-- ----------------------------------------------------------------------------
--     with check (is_staff() or client_id = auth.uid())
--
-- Aucun écran client ne propose de rejoindre la file : c'est le personnel qui
-- inscrit les visiteurs au guichet. La policy laissait pourtant un client
-- écrire directement dans la table via l'API REST, avec le `status`, le
-- `visitor_name`, le `reason` et même `called_by`/`called_at`/`closed_at` de
-- son choix. De quoi peupler la file du personnel de visiteurs fantômes, ou
-- s'y inscrire comme déjà reçu.

drop policy if exists branch_queue_insert on branch_queue;

create policy branch_queue_insert on branch_queue
for insert with check (is_staff());


-- ############################################################################
-- PARTIE D — CONTENU PUBLIC (CMS)
-- ############################################################################

-- ----------------------------------------------------------------------------
-- D1. Un bloc mal formé cassait la page d'accueil publique
-- ----------------------------------------------------------------------------
-- L'écran /admin/cms édite le champ `content` en JSON brut, et l'écriture se
-- fait directement dans la table. Rien ne vérifiait la forme du bloc
-- enregistré : une valeur qui n'est pas un objet JSON faisait tomber le rendu
-- de la section — sur la page visible de tous, sans connexion.
--
-- On ne fige pas le format (il doit rester libre), on refuse seulement ce qui
-- ne peut pas s'afficher.

create or replace function _validate_site_content()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.section_key is null or trim(new.section_key) = '' then
    raise exception 'La clé de section est requise.';
  end if;
  if new.content is null then
    raise exception 'Le contenu du bloc « % » est vide.', new.section_key;
  end if;
  if jsonb_typeof(new.content) <> 'object' then
    raise exception 'Le contenu du bloc « % » doit être un objet JSON (entre accolades), pas un %.',
      new.section_key, jsonb_typeof(new.content);
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_validate_site_content on site_content;
create trigger trg_validate_site_content
before insert or update on site_content
for each row execute function _validate_site_content();


-- ----------------------------------------------------------------------------
-- Permissions (voir 0015 ; exceptions rappelées en 0021, 0022, 0026 à 0032).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

grant execute on function record_login_attempt(text, boolean) to anon;
grant execute on function gold_price_snapshot() to anon;
revoke execute on function revoke_user_sessions(uuid) from authenticated;
revoke execute on function _system_fraud_alert(text, text, text, uuid, uuid, uuid, text) from authenticated;
revoke execute on function _system_adjust_trust_score(uuid, numeric) from authenticated;
revoke execute on function _bypass_profile_guard() from authenticated;

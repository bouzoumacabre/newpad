-- ============================================================================
-- NEWPAD — Migration 0035 : adhésion, ouverture au guichet, file, catégories
-- ============================================================================
-- Audit fonctionnalité par fonctionnalité — étape 10.
-- ============================================================================


-- ############################################################################
-- PARTIE A — DEMANDE D'ADHÉSION
-- ############################################################################

-- ----------------------------------------------------------------------------
-- A1. La demande d'adhésion était un INSERT DIRECT, comme le consulting
-- ----------------------------------------------------------------------------
--     with check (applicant_id = auth.uid())
--
-- Une policy `with check` ne contrôle que la colonne qu'elle nomme. Le candidat
-- écrivait donc lui-même dans `membership_requests` : `status`, `decided_by`,
-- `decided_at`, `requires_admin_override`, `created_account_id`,
-- `admin_authorized_by` — toutes les colonnes de décision de la banque étaient
-- à sa main. Rien ne créait de compte pour autant, mais on pouvait fabriquer
-- une demande portant déjà « validée par un employé », ou sortir sa demande de
-- la file du personnel en la marquant refusée.
--
-- Et surtout, comme pour le consulting (étape 6) : UN INSERT NE NOTIFIE
-- PERSONNE. Une demande d'adhésion n'apparaissait que si un employé pensait à
-- ouvrir l'écran — c'est la toute première interaction d'un joueur avec la
-- banque, et elle pouvait dormir indéfiniment.
--
-- Le type de compte demandé n'était pas davantage vérifié : n'importe quelle
-- chaîne passait, et se retrouvait telle quelle dans `accounts.account_type` à
-- la validation.

drop policy if exists membership_insert on membership_requests;

create or replace function submit_membership_request(p_account_type text, p_initial_deposit numeric, p_motivation text)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
  v_role user_role;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role is null then raise exception 'Accès refusé'; end if;
  if v_role not in ('prospect', 'client') then
    raise exception 'Seul un particulier peut déposer une demande d''adhésion.';
  end if;

  if p_initial_deposit is null or p_initial_deposit < 0 then
    raise exception 'Le dépôt initial ne peut pas être négatif.';
  end if;
  if p_motivation is not null and length(p_motivation) > 4000 then
    raise exception 'Votre message est trop long (4 000 caractères maximum).';
  end if;
  -- `is_client_facing` compte autant que l'existence : `treasury` est un code
  -- valide de la table, mais c'est le compte de la banque elle-même. Sans ce
  -- filtre, un candidat pouvait demander un compte de type « trésorerie ».
  if p_account_type is null or not exists (
    select 1 from account_types where code = p_account_type and is_client_facing
  ) then
    raise exception 'Type de compte inconnu ou non proposé à la clientèle : %', coalesce(p_account_type, '(vide)');
  end if;

  if exists (
    select 1 from membership_requests
    where applicant_id = auth.uid() and status in ('pending', 'processing')
  ) then
    raise exception 'Votre demande est déjà en cours d''examen.';
  end if;

  insert into membership_requests (applicant_id, requested_account_type, initial_deposit, motivation)
  values (auth.uid(), p_account_type, p_initial_deposit, nullif(trim(coalesce(p_motivation, '')), ''))
  returning id into v_id;

  perform notify_all_staff('membership_request', 'Nouvelle demande d''adhésion',
    (select display_name from profiles where id = auth.uid()), '/employee/membership');

  return v_id;
end;
$function$;


-- ############################################################################
-- PARTIE B — OUVERTURE DE COMPTE AU GUICHET
-- ############################################################################

-- ----------------------------------------------------------------------------
-- B1. Une ouverture pouvait être finalisée DEUX FOIS
-- ----------------------------------------------------------------------------
--     select * into o from manual_account_openings where id = p_opening_id for update;
--
-- Aucune clause de statut. Le verrou empêche deux appels SIMULTANÉS, pas deux
-- appels successifs : rappeler la fonction sur une ouverture déjà validée
-- créait un SECOND compte au même client et débitait la trésorerie une
-- deuxième fois du dépôt initial. Un double-clic sur « Finaliser » suffisait.
--
-- Deuxième défaut : `p_client_profile_id` n'était pas vérifié. On pouvait
-- ouvrir un compte bancaire client au nom d'un employé, d'un admin ou de
-- l'IRS — et, ce faisant, promouvoir leur profil.

create or replace function finalize_manual_account_opening(p_opening_id uuid, p_client_profile_id uuid)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  o manual_account_openings%rowtype;
  v_min_balance numeric;
  v_account_id uuid;
  v_bank_account uuid;
  v_treasury numeric;
  v_role user_role;
begin
  perform require_feature('employee.accounts.open');
  if not is_staff() then raise exception 'Réservé au personnel'; end if;

  select * into o from manual_account_openings where id = p_opening_id for update;
  if o is null then raise exception 'Ouverture introuvable'; end if;

  -- CORRECTIF 0035 : une ouverture déjà finalisée ne peut plus l'être à nouveau.
  if o.status = 'validated' then
    raise exception 'Cette ouverture a déjà été finalisée le % — le compte % existe déjà.',
      to_char(o.decided_at, 'DD/MM/YYYY à HH24:MI'),
      coalesce((select iban from accounts where id = o.created_account_id), '(inconnu)');
  end if;
  if o.status = 'rejected' then
    raise exception 'Cette ouverture a été refusée.';
  end if;

  -- CORRECTIF 0035 : le compte s'ouvre pour un particulier, pas pour un membre
  -- du personnel ni pour l'IRS.
  select role into v_role from profiles where id = p_client_profile_id;
  if v_role is null then raise exception 'Profil introuvable'; end if;
  if v_role not in ('prospect', 'client') then
    raise exception 'Un compte bancaire ne peut être ouvert que pour un prospect ou un client (profil visé : %).', v_role;
  end if;

  if o.initial_deposit < 0 then
    raise exception 'Le dépôt initial ne peut pas être négatif';
  end if;

  v_bank_account := bank_treasury_account_id();

  if o.initial_deposit > 0 then
    select balance into v_treasury from accounts where id = v_bank_account;
    if o.initial_deposit > v_treasury then
      raise exception 'Dépôt initial de % $ impossible : la trésorerie de la banque ne dispose que de % $.',
        o.initial_deposit, v_treasury;
    end if;
  end if;

  v_min_balance := coalesce(get_setting_numeric('min_client_balance', p_client_profile_id), 1000000);
  if o.initial_deposit < v_min_balance and not is_admin() then
    update manual_account_openings set requires_admin_override = true where id = p_opening_id;
    perform notify_all_staff('account_opening_needs_admin', 'Ouverture de compte sous le solde minimum — autorisation admin requise', o.display_name, '/admin/account-opening', true);
    raise exception 'Le dépôt initial est sous le solde minimum requis (%). Autorisation admin nécessaire — demande enregistrée en attente.', v_min_balance;
  end if;

  insert into accounts (client_id, account_type, iban, balance, opened_by)
  values (p_client_profile_id, o.account_type, generate_iban(), o.initial_deposit, auth.uid())
  returning id into v_account_id;

  if v_role = 'prospect' then
    perform _bypass_profile_guard();
    update profiles set role = 'client', client_since = coalesce(client_since, current_date)
    where id = p_client_profile_id;
  end if;

  if o.initial_deposit > 0 then
    perform _adjust_balance(v_bank_account, -o.initial_deposit);
    insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
    values ('cash_deposit', 'validated', v_bank_account, v_account_id, o.initial_deposit, 'Dépôt initial à l''ouverture (guichet)', auth.uid());
  end if;

  update manual_account_openings set status = 'validated', client_id = p_client_profile_id, created_account_id = v_account_id, decided_at = now(),
    admin_authorized_by = case when is_admin() and o.initial_deposit < v_min_balance then auth.uid() else null end
  where id = p_opening_id;

  perform notify(p_client_profile_id, 'account_opened', 'Votre compte est ouvert',
    'Compte ' || (select iban from accounts where id = v_account_id) || ' ouvert au guichet.', '/client/accounts');
  perform log_audit('finalize_manual_account_opening', 'manual_account_openings', p_opening_id, jsonb_build_object(
    'client', (select display_name from profiles where id = p_client_profile_id),
    'deposit', o.initial_deposit));

  return v_account_id;
end;
$function$;


-- ----------------------------------------------------------------------------
-- B2. Une ouverture pouvait être enregistrée avec un dépôt négatif
-- ----------------------------------------------------------------------------
-- L'enregistrement dans la file du guichet est une écriture directe du
-- personnel. Le montant n'était contrôlé qu'à la finalisation : une ligne
-- aberrante pouvait donc rester dans la file, et n'échouer qu'au moment de la
-- valider, devant le client.
create or replace function _validate_manual_opening()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.display_name is null or trim(new.display_name) = '' then
    raise exception 'Le nom du titulaire est requis.';
  end if;
  if new.initial_deposit is null or new.initial_deposit < 0 then
    raise exception 'Le dépôt initial ne peut pas être négatif.';
  end if;
  if new.account_type is null or not exists (
    select 1 from account_types where code = new.account_type and is_client_facing
  ) then
    raise exception 'Type de compte inconnu ou non proposé à la clientèle : %', coalesce(new.account_type, '(vide)');
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_validate_manual_opening on manual_account_openings;
create trigger trg_validate_manual_opening
before insert on manual_account_openings
for each row execute function _validate_manual_opening();


-- ############################################################################
-- PARTIE C — FILE D'ATTENTE
-- ############################################################################

-- ----------------------------------------------------------------------------
-- C1. Une entrée de file pouvait être réécrite après coup
-- ----------------------------------------------------------------------------
-- La policy de modification (`is_staff()`) porte sur toutes les colonnes : le
-- personnel pouvait changer le nom du visiteur, le client rattaché ou l'heure
-- d'arrivée d'une entrée déjà en file. L'ordre de passage — le seul intérêt
-- d'une file d'attente — n'était garanti par rien.
create or replace function _freeze_branch_queue_identity()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.client_id is distinct from old.client_id
     or new.visitor_name is distinct from old.visitor_name
     or new.joined_at is distinct from old.joined_at then
    raise exception 'Le visiteur et son heure d''arrivée ne sont pas modifiables — retirez l''entrée et recréez-la.';
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_freeze_branch_queue_identity on branch_queue;
create trigger trg_freeze_branch_queue_identity
before update on branch_queue
for each row execute function _freeze_branch_queue_identity();


-- ############################################################################
-- PARTIE D — CATÉGORIES DE CLIENTÈLE
-- ############################################################################

-- Rien n'empêchait de créer deux fois « VIP » : deux catégories homonymes, des
-- clients répartis entre les deux, et un filtre qui n'en montre que la moitié.
create unique index if not exists idx_client_categories_unique_name
  on client_categories (lower(trim(name)));


-- ----------------------------------------------------------------------------
-- Permissions (voir 0015 ; exceptions rappelées en 0021, 0022, 0026 à 0034).
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
revoke execute on function notify(uuid, text, text, text, text, jsonb) from authenticated;
revoke execute on function notify_all_staff(text, text, text, text, boolean) from authenticated;
revoke execute on function purge_old_notifications() from authenticated;

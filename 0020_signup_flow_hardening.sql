-- ============================================================================
-- NEWPAD — Migration 0020 : durcissement du parcours d'entrée dans la banque
-- ============================================================================
-- Suite de l'audit fonctionnalité par fonctionnalité — étape 1, inscription et
-- adhésion. La faille critique d'élévation de privilèges est traitée en 0019 ;
-- voici les quatre anomalies restantes de ce même parcours.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. L'identifiant du profil n'était pas lié à l'identifiant de connexion
-- ----------------------------------------------------------------------------
-- Le trigger prenait `username` dans user_metadata — donc, comme le rôle, une
-- valeur librement choisie par l'appelant de /auth/v1/signup. L'identifiant de
-- CONNEXION, lui, est l'e-mail synthétique `<identifiant>@newpad.local`.
-- Rien ne garantissait que les deux coïncident : on pouvait se connecter avec
-- `attaquant` tout en apparaissant `banque.officielle` dans la recherche
-- clients du personnel, et bloquer au passage cet identifiant pour son
-- titulaire légitime (la colonne est UNIQUE).
--
-- L'identifiant est désormais DÉRIVÉ de l'e-mail. Les deux chemins de création
-- (inscription publique et Edge Function) construisent tous deux l'e-mail à
-- partir de l'identifiant demandé : le comportement légitime est donc
-- inchangé, seule la divergence devient impossible.
--
-- Vérifié avant application : aucun profil existant n'est dans ce cas.

create or replace function handle_new_auth_user()
returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_role user_role;
  v_username text;
begin
  if coalesce(new.raw_user_meta_data->>'honeypot', '') != '' then
    raise exception 'Inscription refusée';
  end if;

  -- Rôle : app_metadata uniquement — voir migration 0019. user_metadata est
  -- écrit par l'utilisateur et ne peut porter aucune décision d'autorisation.
  begin
    v_role := coalesce((new.raw_app_meta_data->>'role')::user_role, 'prospect');
  exception when others then
    v_role := 'prospect';
  end;

  -- Identifiant : dérivé de l'e-mail, jamais lu dans user_metadata.
  v_username := lower(split_part(new.email, '@', 1));

  insert into profiles (id, username, role, display_name, discord_id, phone_number)
  values (
    new.id,
    v_username,
    v_role,
    coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), v_username),
    nullif(trim(new.raw_user_meta_data->>'discord_id'), ''),
    nullif(trim(new.raw_user_meta_data->>'phone_number'), '')
  );
  return new;
end;
$function$;


-- ----------------------------------------------------------------------------
-- 2. Rien n'empêchait d'empiler les demandes d'adhésion
-- ----------------------------------------------------------------------------
-- La policy `membership_insert` vérifie bien que l'on ne dépose une demande
-- que pour soi-même (`applicant_id = auth.uid()`), mais pas qu'on n'en a pas
-- déjà une en cours. L'écran /prospect masque le formulaire quand une demande
-- est en attente — protection d'interface uniquement : un appel direct à
-- l'API pouvait insérer des milliers de lignes et noyer la file du personnel.
--
-- Un index unique partiel rend la règle structurelle : une seule demande
-- ouverte à la fois par personne. Une demande refusée n'est pas concernée,
-- la resoumission reste donc possible.

create unique index if not exists idx_membership_one_open_per_applicant
  on membership_requests (applicant_id)
  where status in ('pending', 'processing');


-- ----------------------------------------------------------------------------
-- 3. La banque pouvait distribuer de l'argent qu'elle n'avait pas
-- ----------------------------------------------------------------------------
-- Le dépôt initial est saisi par le demandeur (formulaire d'inscription) ou
-- par le guichetier, sans plafond nulle part. À l'approbation, le compte est
-- crédité et la trésorerie débitée du même montant — sans jamais vérifier que
-- la trésorerie peut couvrir.
--
-- Un dépôt de 500 000 000 $ demandé par un prospect et approuvé par un employé
-- pressé faisait donc simplement passer les fonds propres de la banque en
-- négatif de plusieurs centaines de millions.
--
-- La logique existante est même inversée du point de vue du risque : un dépôt
-- INFÉRIEUR au solde minimum est escaladé à l'admin, alors qu'un dépôt
-- démesuré — le seul réellement dangereux — passait sans aucun contrôle.
--
-- Règle ajoutée : la banque ne peut pas verser plus que ce qu'elle détient.
-- C'est un refus, pas une escalade : aucun admin ne devrait pouvoir créer de
-- la monnaie depuis rien, la conservation de la masse monétaire n'étant pas
-- une question de permission (voir le contrôle d'intégrité, migration 0018).

create or replace function decide_membership_request(p_request_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  m membership_requests%rowtype;
  v_min_balance numeric;
  v_account_id uuid;
  v_bank_account uuid;
  v_treasury numeric;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into m from membership_requests where id = p_request_id and status in ('pending','processing') for update;
  if m is null then raise exception 'Demande introuvable'; end if;

  if not p_approve then
    update membership_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now() where id = p_request_id;
    perform notify(m.applicant_id, 'membership_rejected', 'Votre demande d''adhésion a été refusée', p_note, '/prospect');
    perform log_audit('reject_membership', 'membership_requests', p_request_id, jsonb_build_object(
      'applicant', (select display_name from profiles where id = m.applicant_id), 'note', p_note));
    return;
  end if;

  if m.initial_deposit < 0 then
    raise exception 'Le dépôt initial ne peut pas être négatif';
  end if;

  v_bank_account := bank_treasury_account_id();

  -- CORRECTIF 0020 : contrôle de solvabilité de la banque.
  if m.initial_deposit > 0 then
    select balance into v_treasury from accounts where id = v_bank_account;
    if m.initial_deposit > v_treasury then
      raise exception 'Dépôt initial de % $ impossible : la trésorerie de la banque ne dispose que de % $.',
        m.initial_deposit, v_treasury;
    end if;
  end if;

  v_min_balance := coalesce(get_setting_numeric('min_client_balance', m.applicant_id), 1000000);
  if m.initial_deposit < v_min_balance and not is_admin() then
    update membership_requests set status = 'pending', requires_admin_override = true, processing_by = auth.uid(), processing_at = now()
    where id = p_request_id;
    perform notify_all_staff('membership_needs_admin', 'Adhésion sous le solde minimum — autorisation admin requise', m.applicant_id::text, '/admin/membership', true);
    return;
  end if;

  insert into accounts (client_id, account_type, iban, balance, opened_by)
  values (m.applicant_id, coalesce(m.requested_account_type, 'courant'), generate_iban(), m.initial_deposit, auth.uid())
  returning id into v_account_id;

  perform _bypass_profile_guard();
  update profiles set role = 'client', client_since = current_date where id = m.applicant_id;

  if m.initial_deposit > 0 then
    perform _adjust_balance(v_bank_account, -m.initial_deposit);
    insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
    values ('cash_deposit', 'validated', v_bank_account, v_account_id, m.initial_deposit, 'Dépôt initial à l''ouverture', auth.uid());
  end if;

  update membership_requests set status = 'validated', decided_by = auth.uid(), decided_at = now(),
    created_account_id = v_account_id, admin_authorized_by = case when is_admin() and m.initial_deposit < v_min_balance then auth.uid() else null end
  where id = p_request_id;

  perform notify(m.applicant_id, 'membership_approved', 'Bienvenue chez Newman Bank', 'Votre compte client est actif.', '/client');
  perform log_audit('approve_membership', 'membership_requests', p_request_id, jsonb_build_object(
    'applicant', (select display_name from profiles where id = m.applicant_id), 'initial_deposit', m.initial_deposit));
end;
$function$;


-- ----------------------------------------------------------------------------
-- 4. Une ouverture au guichet laissait le client en « prospect »
-- ----------------------------------------------------------------------------
-- `decide_membership_request` passe bien le profil en 'client'. Son équivalent
-- guichet, `finalize_manual_account_opening`, ne le faisait pas.
--
-- Sans conséquence tant que le guichetier créait un compte neuf (l'Edge
-- Function le crée directement en 'client'), mais le rattachement à un
-- PROSPECT DÉJÀ INSCRIT — précisément la possibilité ajoutée au 3ème lot —
-- produisait un client titulaire d'un compte approvisionné… mais toujours
-- bloqué sur l'écran d'attente « Demande en cours d'examen », sans jamais
-- pouvoir accéder à son argent.
--
-- Aucun cas en production à ce jour : le bug est latent, pas encore déclenché.
-- Le changement de rôle ne s'applique qu'à un prospect : rattacher un compte
-- supplémentaire à un employé ou un admin ne le rétrograde pas.

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
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into o from manual_account_openings where id = p_opening_id for update;
  if o is null then raise exception 'Ouverture introuvable'; end if;

  if o.initial_deposit < 0 then
    raise exception 'Le dépôt initial ne peut pas être négatif';
  end if;

  v_bank_account := bank_treasury_account_id();

  -- CORRECTIF 0020 : contrôle de solvabilité (voir §3).
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

  -- CORRECTIF 0020 : un prospect rattaché devient client, comme par l'autre voie.
  if (select role from profiles where id = p_client_profile_id) = 'prospect' then
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

  return v_account_id;
end;
$function$;


-- ----------------------------------------------------------------------------
-- 5. Permissions d'exécution (voir 0015).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

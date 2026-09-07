-- ============================================================================
-- NEWPAD — Migration 0039 : CORRECTIF DE RÉGRESSION
-- ============================================================================
-- Régression que j'ai introduite moi-même aux étapes 9 et 10.
--
-- Les migrations 0034 et 0035 ont retiré les policies d'insertion directe sur
-- `beneficiaries` et `membership_requests`, en déplaçant l'écriture vers des
-- fonctions serveur (`add_beneficiary`, `submit_membership_request`). Correct
-- sur le fond — mais la base et le site ne sont pas déployés en même temps :
-- les migrations sont appliquées immédiatement, le frontend est téléversé à la
-- main. Le site en ligne exécute donc encore la version d'avant, qui écrit
-- directement dans ces tables.
--
-- Résultat, en production, depuis l'application de 0035 :
--
--     « Impossible d'envoyer la demande pour le moment. »
--
-- sur l'écran de demande d'adhésion — c'est-à-dire la porte d'entrée de la
-- banque, fermée pour tout nouveau joueur. Et le même symptôme silencieux sur
-- l'ajout d'un bénéficiaire.
--
-- Leçon retenue : retirer une policy d'écriture est un changement RUPTUREUR
-- pour un frontend déployé séparément. La validation doit vivre là où les DEUX
-- chemins passent — c'est-à-dire dans un DÉCLENCHEUR sur la table, pas
-- seulement dans la fonction.
--
-- L'insertion directe est donc rétablie, mais la table se défend désormais
-- elle-même : les contrôles ajoutés en 0034/0035 sont déplacés dans des
-- déclencheurs, qui s'appliquent aussi bien à l'insertion directe qu'à l'appel
-- de la fonction. Rien de ce qui a été corrigé n'est perdu.
-- ============================================================================


-- ############################################################################
-- PARTIE A — DEMANDE D'ADHÉSION
-- ############################################################################

-- Normalisation plutôt que refus : un ancien client qui n'envoie que les
-- quatre champs légitimes passe sans rien changer ; un client malveillant qui
-- tenterait de préremplir les colonnes de décision de la banque les voit
-- ramenées à leur valeur d'origine, sans erreur ni indice.
create or replace function _guard_membership_request()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_role user_role;
begin
  if new.applicant_id is distinct from auth.uid() and auth.uid() is not null then
    raise exception 'Une demande d''adhésion ne peut être déposée que pour soi-même.';
  end if;

  if auth.uid() is not null then
    select role into v_role from profiles where id = new.applicant_id;
    if v_role is null then raise exception 'Profil introuvable'; end if;
    if v_role not in ('prospect', 'client') then
      raise exception 'Seul un particulier peut déposer une demande d''adhésion.';
    end if;
  end if;

  if new.initial_deposit is null or new.initial_deposit < 0 then
    raise exception 'Le dépôt initial ne peut pas être négatif.';
  end if;
  if length(coalesce(new.motivation, '')) > 4000 then
    raise exception 'Votre message est trop long (4 000 caractères maximum).';
  end if;
  if new.requested_account_type is null or not exists (
    select 1 from account_types where code = new.requested_account_type and is_client_facing
  ) then
    raise exception 'Type de compte inconnu ou non proposé à la clientèle : %',
      coalesce(new.requested_account_type, '(vide)');
  end if;

  if exists (
    select 1 from membership_requests
    where applicant_id = new.applicant_id and status in ('pending', 'processing')
  ) then
    raise exception 'Votre demande est déjà en cours d''examen.';
  end if;

  -- Colonnes de décision de la banque : jamais fournies par le demandeur.
  new.status := 'pending';
  new.requires_admin_override := false;
  new.processing_by := null;
  new.processing_at := null;
  new.decided_by := null;
  new.decided_at := null;
  new.created_account_id := null;
  new.admin_authorized_by := null;
  new.motivation := nullif(trim(coalesce(new.motivation, '')), '');

  return new;
end;
$function$;

drop trigger if exists trg_guard_membership_request on membership_requests;
create trigger trg_guard_membership_request
before insert on membership_requests
for each row execute function _guard_membership_request();


-- La notification au personnel vit elle aussi dans un déclencheur : c'était le
-- défaut d'origine (un INSERT ne notifie personne), et le corriger uniquement
-- dans la fonction laissait le chemin direct muet.
create or replace function _notify_new_membership_request()
returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  perform notify_all_staff('membership_request', 'Nouvelle demande d''adhésion',
    (select display_name from profiles where id = new.applicant_id), '/employee/membership');
  return new;
end;
$function$;

drop trigger if exists trg_notify_new_membership_request on membership_requests;
create trigger trg_notify_new_membership_request
after insert on membership_requests
for each row execute function _notify_new_membership_request();


-- Insertion directe rétablie. La policy ne garde que le contrôle de propriété ;
-- tout le reste est assuré par le déclencheur ci-dessus, donc identique quel
-- que soit le chemin d'écriture.
drop policy if exists membership_insert on membership_requests;
create policy membership_insert on membership_requests
for insert with check (applicant_id = auth.uid());


-- La fonction n'a plus à notifier ni à valider : le déclencheur s'en charge
-- pour les deux chemins. Elle reste le point d'entrée recommandé.
create or replace function submit_membership_request(p_account_type text, p_initial_deposit numeric, p_motivation text)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  insert into membership_requests (applicant_id, requested_account_type, initial_deposit, motivation)
  values (auth.uid(), p_account_type, p_initial_deposit, p_motivation)
  returning id into v_id;
  return v_id;
end;
$function$;


-- ############################################################################
-- PARTIE B — BÉNÉFICIAIRES
-- ############################################################################

-- Même principe : la résolution de l'IBAN et les contrôles passent dans un
-- déclencheur, pour que l'ancienne insertion directe en bénéficie aussi.
create or replace function _guard_beneficiary()
returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_account uuid;
  v_owner uuid;
  v_status text;
  v_count integer;
begin
  if new.client_id is distinct from auth.uid() and auth.uid() is not null then
    raise exception 'Accès refusé';
  end if;

  new.beneficiary_iban := upper(trim(coalesce(new.beneficiary_iban, '')));
  if new.beneficiary_iban = '' then raise exception 'L''IBAN du bénéficiaire est requis.'; end if;
  if new.label is null or trim(new.label) = '' then raise exception 'Le libellé est requis.'; end if;
  if length(new.label) > 80 then raise exception 'Le libellé est trop long (80 caractères maximum).'; end if;
  new.label := trim(new.label);

  select id, client_id, status into v_account, v_owner, v_status
  from accounts where upper(iban) = new.beneficiary_iban;

  if v_account is null then
    raise exception 'Aucun compte ne porte l''IBAN %. Vérifiez la saisie auprès du bénéficiaire.', new.beneficiary_iban;
  end if;
  if v_status = 'closed' then
    raise exception 'Le compte % est clôturé.', new.beneficiary_iban;
  end if;
  if v_owner = new.client_id then
    raise exception 'Ce compte est le vôtre — inutile de l''enregistrer comme bénéficiaire.';
  end if;
  if exists (
    select 1 from beneficiaries
    where client_id = new.client_id and upper(beneficiary_iban) = new.beneficiary_iban
  ) then
    raise exception 'Ce bénéficiaire est déjà enregistré.';
  end if;

  select count(*) into v_count from beneficiaries where client_id = new.client_id;
  if v_count >= 50 then
    raise exception 'Vous avez atteint la limite de 50 bénéficiaires enregistrés.';
  end if;

  -- La colonne prévue pour relier le bénéficiaire au compte réel restait vide
  -- sur le chemin direct : elle est désormais renseignée dans les deux cas.
  new.beneficiary_account_id := v_account;
  return new;
end;
$function$;

drop trigger if exists trg_guard_beneficiary on beneficiaries;
create trigger trg_guard_beneficiary
before insert on beneficiaries
for each row execute function _guard_beneficiary();


drop policy if exists beneficiaries_insert on beneficiaries;
create policy beneficiaries_insert on beneficiaries
for insert with check (client_id = auth.uid());

-- Modification : seul le libellé a un sens. Changer l'IBAN d'un bénéficiaire
-- existant reviendrait à contourner la résolution faite à l'enregistrement.
drop policy if exists beneficiaries_update on beneficiaries;
create policy beneficiaries_update on beneficiaries
for update using (client_id = auth.uid()) with check (client_id = auth.uid());

create or replace function _guard_beneficiary_update()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.beneficiary_iban is distinct from old.beneficiary_iban
     or new.beneficiary_account_id is distinct from old.beneficiary_account_id
     or new.client_id is distinct from old.client_id then
    raise exception 'Seul le libellé d''un bénéficiaire est modifiable — supprimez-le et recréez-le.';
  end if;
  if new.label is null or trim(new.label) = '' then raise exception 'Le libellé est requis.'; end if;
  if length(new.label) > 80 then raise exception 'Le libellé est trop long (80 caractères maximum).'; end if;
  new.label := trim(new.label);
  return new;
end;
$function$;

drop trigger if exists trg_guard_beneficiary_update on beneficiaries;
create trigger trg_guard_beneficiary_update
before update on beneficiaries
for each row execute function _guard_beneficiary_update();


-- La fonction devient un simple point d'entrée : les contrôles sont dans le
-- déclencheur, donc communs aux deux chemins.
create or replace function add_beneficiary(p_label text, p_iban text)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  insert into beneficiaries (client_id, label, beneficiary_iban)
  values (auth.uid(), p_label, p_iban)
  returning id into v_id;
  return v_id;
end;
$function$;


-- ############################################################################
-- PARTIE C — CONSULTING (même risque, vérifié)
-- ############################################################################
-- La policy d'insertion du consulting a été retirée en 0030, à l'étape 6 —
-- mais le frontend correspondant, lui, A ÉTÉ DÉPLOYÉ (vérifié par l'empreinte
-- du bundle en ligne). Ce chemin passe donc bien par `submit_consulting_request`
-- et n'est pas cassé. Aucune action ici : le noter suffit, pour que le motif
-- reste identifié.


-- ----------------------------------------------------------------------------
-- Permissions (voir 0038 : règle par balayage des fonctions internes).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

grant execute on function record_login_attempt(text, boolean) to anon;
grant execute on function gold_price_snapshot() to anon;

do $do$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace and left(p.proname, 1) = '_'
  loop
    execute format('revoke execute on function %s from authenticated', f.sig);
  end loop;
end
$do$;

revoke execute on function revoke_user_sessions(uuid) from authenticated;
revoke execute on function notify(uuid, text, text, text, text, jsonb) from authenticated;
revoke execute on function notify_all_staff(text, text, text, text, boolean) from authenticated;
revoke execute on function purge_old_notifications() from authenticated;
revoke execute on function log_audit(text, text, uuid, jsonb) from authenticated;
revoke execute on function generate_iban() from authenticated;

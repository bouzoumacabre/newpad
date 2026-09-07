-- ============================================================================
-- NEWPAD — Migration 0034 : notifications, bénéficiaires, documents, infos
-- ============================================================================
-- Audit fonctionnalité par fonctionnalité — étape 9.
-- État constaté : 99 notifications, 0 bénéficiaire enregistré, 0 document.
-- ============================================================================


-- ############################################################################
-- PARTIE A — NOTIFICATIONS
-- ############################################################################

-- ----------------------------------------------------------------------------
-- A1. N'importe quel client pouvait notifier n'importe qui
-- ----------------------------------------------------------------------------
-- `notify()` et `notify_all_staff()` sont des fonctions SECURITY DEFINER sans
-- le moindre contrôle de rôle, et le `grant execute ... to authenticated`
-- global les rendait appelables depuis le navigateur, avec la clé publique.
--
-- Un client pouvait donc fabriquer une notification adressée à qui il voulait,
-- avec le titre, le corps ET LE LIEN de son choix. C'est un hameçonnage interne
-- en une requête : une notification « Virement à valider » envoyée à un admin,
-- pointant vers l'écran de son choix ; ou, adressée à un autre client, un
-- message signé de la banque lui annonçant la suspension de son compte.
-- `notify_all_staff` permettait de faire la même chose à tout le personnel
-- d'un coup.
--
-- Aucune de ces deux fonctions n'est appelée depuis le navigateur : elles ne
-- servent qu'à l'intérieur d'autres fonctions SECURITY DEFINER, où le droit
-- d'exécution est évalué sur le propriétaire de la fonction et non sur
-- l'appelant. Le retrait est donc sans effet sur le fonctionnement.
--
-- (Le retrait figure dans le bloc de permissions en fin de fichier.)


-- ----------------------------------------------------------------------------
-- A2. Rien ne purgeait jamais les notifications
-- ----------------------------------------------------------------------------
-- La table ne connaît que l'insertion et le passage en « lu ». 99 lignes après
-- deux semaines d'usage de test ; en jeu réel, le panneau finit par charger un
-- historique que personne ne relit, et le badge de non-lus perd son sens.
create or replace function purge_old_notifications()
returns void
language sql security definer
set search_path to 'public', 'pg_temp'
as $function$
  delete from notifications
  where is_read = true and created_at < now() - interval '60 days';
$function$;

select cron.schedule('purge-notifications', '40 3 * * *', 'select purge_old_notifications();')
where not exists (select 1 from cron.job where jobname = 'purge-notifications');


-- ############################################################################
-- PARTIE B — BÉNÉFICIAIRES
-- ############################################################################

-- ----------------------------------------------------------------------------
-- B1. Un bénéficiaire pouvait pointer vers un IBAN qui n'existe pas
-- ----------------------------------------------------------------------------
-- L'enregistrement se faisait par écriture directe :
--
--     insert into beneficiaries { client_id, label, beneficiary_iban }
--
-- avec pour seule règle `client_id = auth.uid()`. Ni l'IBAN ni le libellé
-- n'étaient vérifiés, et `beneficiary_account_id` — la colonne prévue pour
-- relier le bénéficiaire au compte réel — restait vide. Conséquences :
--
--   - une faute de frappe dans l'IBAN était acceptée sans un mot, et le client
--     ne le découvrait qu'au moment d'émettre le virement ;
--   - le même bénéficiaire pouvait être enregistré dix fois ;
--   - rien ne limitait le nombre d'entrées.
--
-- L'IBAN est désormais résolu à l'enregistrement, et le compte réel mémorisé.

create or replace function add_beneficiary(p_label text, p_iban text)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_account uuid;
  v_owner uuid;
  v_status text;
  v_iban text;
  v_id uuid;
  v_count integer;
begin
  v_iban := upper(trim(coalesce(p_iban, '')));
  if v_iban = '' then raise exception 'L''IBAN du bénéficiaire est requis.'; end if;
  if p_label is null or trim(p_label) = '' then raise exception 'Le libellé est requis.'; end if;
  if length(p_label) > 80 then raise exception 'Le libellé est trop long (80 caractères maximum).'; end if;

  select id, client_id, status into v_account, v_owner, v_status
  from accounts where upper(iban) = v_iban;

  if v_account is null then
    raise exception 'Aucun compte ne porte l''IBAN %. Vérifiez la saisie auprès du bénéficiaire.', v_iban;
  end if;
  if v_status = 'closed' then
    raise exception 'Le compte % est clôturé.', v_iban;
  end if;
  if v_owner = auth.uid() then
    raise exception 'Ce compte est le vôtre — inutile de l''enregistrer comme bénéficiaire.';
  end if;

  if exists (select 1 from beneficiaries where client_id = auth.uid() and upper(beneficiary_iban) = v_iban) then
    raise exception 'Ce bénéficiaire est déjà enregistré.';
  end if;

  select count(*) into v_count from beneficiaries where client_id = auth.uid();
  if v_count >= 50 then
    raise exception 'Vous avez atteint la limite de 50 bénéficiaires enregistrés.';
  end if;

  insert into beneficiaries (client_id, label, beneficiary_iban, beneficiary_account_id)
  values (auth.uid(), trim(p_label), v_iban, v_account)
  returning id into v_id;
  return v_id;
end;
$function$;


-- L'écriture directe est retirée : elle contournerait tous les contrôles
-- ci-dessus. La suppression, elle, reste directe — elle ne peut rien casser.
drop policy if exists beneficiaries_insert on beneficiaries;
drop policy if exists beneficiaries_update on beneficiaries;

create or replace function rename_beneficiary(p_id uuid, p_label text)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if p_label is null or trim(p_label) = '' then raise exception 'Le libellé est requis.'; end if;
  if length(p_label) > 80 then raise exception 'Le libellé est trop long (80 caractères maximum).'; end if;
  update beneficiaries set label = trim(p_label) where id = p_id and client_id = auth.uid();
  if not found then raise exception 'Bénéficiaire introuvable'; end if;
end;
$function$;


-- ############################################################################
-- PARTIE C — DOCUMENTS
-- ############################################################################

-- ----------------------------------------------------------------------------
-- C1. L'écran Documents ne pouvait jamais rien afficher
-- ----------------------------------------------------------------------------
-- La table `documents` existe depuis l'origine, avec sa policy de lecture et
-- une policy d'insertion réservée au personnel. Mais AUCUNE fonction, aucun
-- écran, aucun chemin quel qu'il soit n'y écrit : `/client/documents` était
-- structurellement vide, et le restait quoi qu'il arrive.
--
-- La colonne prévue (`storage_path`) suppose un bucket Storage qui n'existe
-- pas — sa création fait partie de la migration 0016, toujours en attente de
-- décision. Plutôt que de laisser la fonctionnalité en panne jusque-là, un
-- document peut désormais être un ACTE TEXTE : attestation de compte, relevé,
-- courrier officiel — rédigé par la banque, lisible et imprimable par le
-- client. `storage_path` reste disponible pour les pièces jointes, plus tard.

alter table documents add column if not exists content text;

comment on column documents.content is
  'Corps du document lorsqu''il est émis sous forme de texte. `storage_path` reste réservé aux pièces jointes déposées dans Storage (bucket non encore créé — voir migration 0016).';

create or replace function issue_document(p_client_id uuid, p_doc_type text, p_title text, p_content text, p_period_label text default null)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  if p_title is null or trim(p_title) = '' then raise exception 'Le titre du document est requis.'; end if;
  if p_content is null or trim(p_content) = '' then raise exception 'Le contenu du document est requis.'; end if;
  if length(p_title) > 200 then raise exception 'Le titre est trop long (200 caractères maximum).'; end if;
  if length(p_content) > 20000 then raise exception 'Le document est trop long (20 000 caractères maximum).'; end if;
  if not exists (select 1 from profiles where id = p_client_id and role = 'client') then
    raise exception 'Client introuvable';
  end if;

  insert into documents (client_id, doc_type, title, content, period_label, generated_by)
  values (p_client_id, coalesce(nullif(trim(p_doc_type), ''), 'courrier'), trim(p_title), trim(p_content),
          nullif(trim(coalesce(p_period_label, '')), ''), auth.uid())
  returning id into v_id;

  perform notify(p_client_id, 'document_issued', 'Nouveau document disponible', trim(p_title), '/client/documents');
  perform log_audit('issue_document', 'documents', v_id, jsonb_build_object(
    'client', (select display_name from profiles where id = p_client_id), 'title', trim(p_title)));
  return v_id;
end;
$function$;


-- Un document émis par erreur devait pouvoir être retiré : la table n'avait ni
-- policy de suppression ni fonction pour le faire.
create or replace function revoke_document(p_id uuid, p_reason text default null)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  d documents%rowtype;
begin
  if not is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  select * into d from documents where id = p_id;
  if d is null then raise exception 'Document introuvable'; end if;

  delete from documents where id = p_id;
  perform log_audit('revoke_document', 'documents', p_id, jsonb_build_object(
    'client', (select display_name from profiles where id = d.client_id),
    'title', d.title, 'motif', p_reason));
end;
$function$;


create or replace function staff_list_documents(p_client_id uuid default null, p_limit integer default 200)
returns table(id uuid, client_id uuid, client_name text, doc_type text, title text,
              period_label text, created_at timestamptz, issued_by text)
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  return query
  select d.id, d.client_id, c.display_name, d.doc_type, d.title, d.period_label, d.created_at, g.display_name
  from documents d
  left join profiles c on c.id = d.client_id
  left join profiles g on g.id = d.generated_by
  where (p_client_id is null or d.client_id = p_client_id)
  order by d.created_at desc
  limit least(coalesce(p_limit, 200), 1000);
end;
$function$;


-- ############################################################################
-- PARTIE D — FICHE INFOS CLIENT
-- ############################################################################

-- Le contenu n'avait aucune borne : rien n'empêchait d'y coller un roman, sur
-- une fiche relue par trois rôles différents.
create or replace function upsert_client_info(p_client_id uuid, p_content text)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_staff() and not is_irs() then
    raise exception 'Réservé au personnel (employé, admin) et à l''IRS';
  end if;
  if length(coalesce(p_content, '')) > 10000 then
    raise exception 'La fiche est trop longue (10 000 caractères maximum).';
  end if;
  if not exists (select 1 from profiles where id = p_client_id and role = 'client') then
    raise exception 'Client introuvable';
  end if;
  insert into client_info_notes (client_id, content, updated_by, updated_at)
  values (p_client_id, p_content, auth.uid(), now())
  on conflict (client_id) do update set content = excluded.content, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  perform log_audit('upsert_client_info', 'client_info_notes', p_client_id, jsonb_build_object('client', (select display_name from profiles where id = p_client_id)));
end;
$function$;


-- ----------------------------------------------------------------------------
-- Permissions (voir 0015 ; exceptions rappelées en 0021, 0022, 0026 à 0033).
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

-- Émission de notifications : chemin interne uniquement (voir A1).
revoke execute on function notify(uuid, text, text, text, text, jsonb) from authenticated;
revoke execute on function notify_all_staff(text, text, text, text, boolean) from authenticated;
revoke execute on function purge_old_notifications() from authenticated;

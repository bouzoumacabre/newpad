-- ============================================================================
-- NEWPAD — Migration 0030 : consulting, support, messagerie
-- ============================================================================
-- Audit fonctionnalité par fonctionnalité — étape 6.
-- État constaté avant correction : 1 demande de consulting (déposée le 18/08,
-- refusée le 24/08 — six jours plus tard, ce qui s'explique par le défaut A1
-- ci-dessous), 1 ticket de support, 0 conversation de messagerie.
-- ============================================================================


-- ############################################################################
-- PARTIE A — CONSULTING PREMIUM
-- ############################################################################

-- ----------------------------------------------------------------------------
-- A1. La demande de consulting était un INSERT DIRECT dans la table
-- ----------------------------------------------------------------------------
-- Seule demande client de tout le système à ne pas passer par une fonction :
-- la policy `consulting_insert` (`with check (client_id = auth.uid())`)
-- autorisait le client à écrire directement dans `consulting_requests`. Une
-- policy `with check` ne contrôle QUE la colonne qu'elle nomme — toutes les
-- autres restent à la main de celui qui écrit. Conséquences :
--
--   1. AUCUNE NOTIFICATION AU PERSONNEL. Un INSERT ne déclenche rien : la
--      demande n'apparaissait que si un employé pensait à ouvrir l'écran. La
--      seule demande réelle est restée six jours sans réponse.
--   2. FALSIFICATION DE L'ÉTAT. Rien n'empêchait d'insérer une demande déjà
--      `status = 'assigned'` avec le conseiller de son choix, ou de renseigner
--      `decided_by`/`decided_at`/`decision_note` — c'est-à-dire de fabriquer
--      une décision de la banque qui n'a jamais eu lieu.
--   3. AUCUNE LIMITE. Autant de demandes que de clics.
--
-- Le chemin d'écriture passe désormais par une fonction, comme les huit autres
-- types de demandes. La policy d'insertion directe est retirée.

drop policy if exists consulting_insert on consulting_requests;

create or replace function submit_consulting_request(p_message text)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
begin
  if p_message is null or trim(p_message) = '' then
    raise exception 'Veuillez décrire votre demande.';
  end if;
  if length(p_message) > 4000 then
    raise exception 'Votre demande est trop longue (4 000 caractères maximum).';
  end if;

  if exists (
    select 1 from consulting_requests
    where client_id = auth.uid() and status in ('pending', 'assigned')
  ) then
    raise exception 'Vous avez déjà une demande de consulting en cours.';
  end if;

  insert into consulting_requests (client_id, message)
  values (auth.uid(), trim(p_message))
  returning id into v_id;

  perform notify_all_staff('consulting_request', 'Nouvelle demande de consulting premium',
    left(trim(p_message), 140), '/employee/consulting');

  return v_id;
end;
$function$;


-- ----------------------------------------------------------------------------
-- A2. `assign_consulting_request` : ni statut, ni existence, ni rôle vérifiés
-- ----------------------------------------------------------------------------
--     update consulting_requests set status = 'assigned', ... where id = p_id
--
-- Sans clause de statut ni `if not found` :
--   - une demande DÉJÀ REFUSÉE pouvait être réassignée et repassait en
--     « assigné », effaçant la décision précédente ;
--   - un identifiant inexistant ne provoquait aucune erreur : `v_client`
--     restait nul, `notify(null, ...)` était appelé, et l'employé voyait une
--     opération « réussie » qui n'avait rien fait ;
--   - `p_advisor_id` n'était pas vérifié : n'importe quel profil, y compris un
--     client, pouvait être désigné conseiller.

create or replace function assign_consulting_request(p_id uuid, p_advisor_id uuid)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_client uuid;
  v_advisor_role user_role;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;

  select role into v_advisor_role from profiles where id = p_advisor_id;
  if v_advisor_role is null then raise exception 'Conseiller introuvable'; end if;
  if v_advisor_role not in ('employee', 'admin') then
    raise exception 'Seul un membre du personnel peut être désigné conseiller';
  end if;

  update consulting_requests
  set status = 'assigned', assigned_advisor_id = p_advisor_id
  where id = p_id and status = 'pending'
  returning client_id into v_client;
  if not found then raise exception 'Demande introuvable ou déjà traitée'; end if;

  perform notify(v_client, 'consulting_assigned', 'Un conseiller vous a été attribué',
    (select display_name from profiles where id = p_advisor_id), '/client/consulting');
  perform notify_all_staff('consulting_decided', 'Demande de consulting prise en charge',
    (select display_name from profiles where id = v_client), '/employee/consulting');
  perform log_audit('assign_consulting_request', 'consulting_requests', p_id, jsonb_build_object(
    'client', (select display_name from profiles where id = v_client),
    'advisor', (select display_name from profiles where id = p_advisor_id)));
end;
$function$;


-- ----------------------------------------------------------------------------
-- A3. Un accompagnement pris en charge ne pouvait jamais être clôturé
-- ----------------------------------------------------------------------------
-- Le statut `closed` était prévu (l'interface employé sait déjà l'afficher —
-- « Clôturé ») mais aucune fonction ne le posait. Une fois assignée, une
-- demande restait « assigné » indéfiniment : le conseiller n'avait d'autre
-- choix que de la REFUSER pour la sortir de sa file, ce qui affichait au client
-- « Demande refusée » à la fin d'un accompagnement pourtant mené à son terme.

create or replace function close_consulting_request(p_id uuid, p_note text default null)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_client uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;

  update consulting_requests
  set status = 'closed', decision_note = p_note, decided_by = auth.uid(), decided_at = now()
  where id = p_id and status in ('pending', 'assigned')
  returning client_id into v_client;
  if not found then raise exception 'Demande introuvable ou déjà clôturée'; end if;

  perform notify(v_client, 'consulting_closed', 'Accompagnement terminé',
    coalesce(p_note, 'Votre accompagnement personnalisé est arrivé à son terme.'), '/client/consulting');
  perform log_audit('close_consulting_request', 'consulting_requests', p_id, jsonb_build_object(
    'client', (select display_name from profiles where id = v_client), 'note', p_note));
end;
$function$;


-- Refus : même garde-fou d'existence, et notification au personnel comme pour
-- les autres files (l'employé qui n'a pas décidé voyait la demande rester dans
-- sa liste sans savoir qu'un collègue l'avait traitée).
create or replace function reject_consulting_request(p_id uuid, p_note text default null)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_client uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  update consulting_requests set status = 'rejected', decision_note = p_note, decided_by = auth.uid(), decided_at = now()
  where id = p_id and status in ('pending','assigned')
  returning client_id into v_client;
  if not found then raise exception 'Demande introuvable ou déjà décidée'; end if;

  perform notify(v_client, 'consulting_rejected', 'Demande de consulting refusée', p_note, '/client/consulting');
  perform notify_all_staff('consulting_decided', 'Demande de consulting refusée',
    (select display_name from profiles where id = v_client), '/employee/consulting');
  perform log_audit('reject_consulting_request', 'consulting_requests', p_id, jsonb_build_object(
    'client', (select display_name from profiles where id = v_client), 'note', p_note));
end;
$function$;


-- ############################################################################
-- PARTIE B — SUPPORT
-- ############################################################################

-- ----------------------------------------------------------------------------
-- B1. Ticket sans sujet, sans message, et en nombre illimité
-- ----------------------------------------------------------------------------
create or replace function create_support_ticket(p_subject text, p_category text, p_first_message text)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
  v_open integer;
begin
  if p_subject is null or trim(p_subject) = '' then
    raise exception 'Le sujet est requis.';
  end if;
  if p_first_message is null or trim(p_first_message) = '' then
    raise exception 'Le message ne peut pas être vide.';
  end if;
  if length(p_subject) > 200 then
    raise exception 'Le sujet est trop long (200 caractères maximum).';
  end if;
  if length(p_first_message) > 4000 then
    raise exception 'Le message est trop long (4 000 caractères maximum).';
  end if;

  -- Garde-fou anti-inondation : le support reste ouvert à un client suspendu
  -- (exception délibérée de la migration 0022 — il doit pouvoir joindre la
  -- banque), il faut donc une limite ici plutôt qu'un blocage de profil.
  select count(*) into v_open from support_tickets
  where client_id = auth.uid() and status <> 'resolved';
  if v_open >= 5 then
    raise exception 'Vous avez déjà 5 tickets ouverts. Poursuivez la conversation dans un ticket existant.';
  end if;

  insert into support_tickets (client_id, subject, category)
  values (auth.uid(), trim(p_subject), p_category) returning id into v_id;
  insert into support_messages (ticket_id, author_id, author_role, body)
  values (v_id, auth.uid(), 'client', trim(p_first_message));

  perform notify_all_staff('support_new_ticket', 'Nouveau ticket de support', trim(p_subject), '/employee/support');
  return v_id;
end;
$function$;


-- ----------------------------------------------------------------------------
-- B2. Le statut « En cours » n'était jamais posé, et le corps jamais validé
-- ----------------------------------------------------------------------------
-- `ticket_status` prévoit trois états (open / in_progress / resolved) et les
-- deux interfaces personnel savent afficher « En cours » — mais AUCUNE fonction
-- ne posait jamais cette valeur. Tous les tickets restaient « Ouvert » jusqu'à
-- leur résolution : impossible de distinguer un ticket que personne n'a encore
-- lu d'un ticket déjà pris en charge par un collègue.

create or replace function post_support_message(p_ticket_id uuid, p_body text)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
  t support_tickets%rowtype;
  v_role user_role;
begin
  select * into t from support_tickets where id = p_ticket_id;
  if t is null then raise exception 'Ticket introuvable'; end if;
  v_role := current_role_name();
  if v_role = 'client' and t.client_id != auth.uid() then raise exception 'Accès refusé'; end if;
  if v_role not in ('client','employee','admin') then raise exception 'Accès refusé'; end if;

  if p_body is null or trim(p_body) = '' then
    raise exception 'Le message ne peut pas être vide.';
  end if;
  if length(p_body) > 4000 then
    raise exception 'Le message est trop long (4 000 caractères maximum).';
  end if;

  insert into support_messages (ticket_id, author_id, author_role, body)
  values (p_ticket_id, auth.uid(), v_role, trim(p_body)) returning id into v_id;

  update support_tickets set
    updated_at = now(),
    status = case
      when v_role in ('employee','admin') then 'in_progress'::ticket_status
      when status = 'resolved' then 'open'::ticket_status
      else status end,
    assigned_to = case when v_role in ('employee','admin') and assigned_to is null then auth.uid() else assigned_to end
  where id = p_ticket_id;

  if v_role = 'client' then
    perform notify_all_staff('support_new_message', 'Nouveau message sur un ticket', t.subject, '/employee/support');
  else
    perform notify(t.client_id, 'support_new_message', 'Nouveau message sur votre ticket', t.subject, '/client/support');
  end if;
  return v_id;
end;
$function$;


-- ----------------------------------------------------------------------------
-- B3. Prise en charge explicite d'un ticket
-- ----------------------------------------------------------------------------
-- Jusqu'ici, `assigned_to` n'était renseigné qu'en RÉPONDANT au ticket. Deux
-- employés pouvaient donc travailler en parallèle sur le même ticket sans le
-- savoir, jusqu'à ce que l'un des deux publie sa réponse.
create or replace function claim_support_ticket(p_ticket_id uuid)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  t support_tickets%rowtype;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  select * into t from support_tickets where id = p_ticket_id for update;
  if t is null then raise exception 'Ticket introuvable'; end if;
  if t.status = 'resolved' then raise exception 'Ce ticket est déjà résolu'; end if;
  if t.assigned_to is not null and t.assigned_to <> auth.uid() then
    raise exception 'Ce ticket est déjà pris en charge par %', (select display_name from profiles where id = t.assigned_to);
  end if;

  update support_tickets set assigned_to = auth.uid(), status = 'in_progress', updated_at = now()
  where id = p_ticket_id;

  perform notify(t.client_id, 'support_claimed', 'Votre ticket est pris en charge', t.subject, '/client/support');
  perform log_audit('claim_support_ticket', 'support_tickets', p_ticket_id, jsonb_build_object('subject', t.subject));
end;
$function$;


-- ----------------------------------------------------------------------------
-- B4. Un ticket était résolu SANS que le client en soit informé
-- ----------------------------------------------------------------------------
-- Toutes les autres décisions de la banque notifient le client. Celle-ci, non :
-- le ticket passait en « Résolu » en silence, et le client ne l'apprenait qu'en
-- rouvrant l'écran de support de lui-même.
create or replace function resolve_support_ticket(p_ticket_id uuid)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_client uuid;
  v_subject text;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  update support_tickets set status = 'resolved', resolved_at = now(), updated_at = now(),
    assigned_to = coalesce(assigned_to, auth.uid())
  where id = p_ticket_id and status <> 'resolved'
  returning client_id, subject into v_client, v_subject;
  if not found then raise exception 'Ticket introuvable ou déjà résolu'; end if;

  perform notify(v_client, 'support_resolved', 'Votre ticket a été résolu',
    v_subject || ' — répondez dans le ticket s''il vous reste une question.', '/client/support');
  perform log_audit('resolve_support_ticket', 'support_tickets', p_ticket_id, jsonb_build_object(
    'client', (select display_name from profiles where id = v_client), 'subject', v_subject));
end;
$function$;


-- ############################################################################
-- PARTIE C — MESSAGERIE INTER-RÔLES
-- ############################################################################

-- ----------------------------------------------------------------------------
-- C1. Le PREMIER message d'une conversation n'apparaissait jamais comme non lu
-- ----------------------------------------------------------------------------
-- `participant_a_last_read_at` et `participant_b_last_read_at` valent `now()`
-- PAR DÉFAUT, tout comme `last_message_at`. `now()` renvoyant l'horodatage de
-- début de transaction, les trois colonnes recevaient exactement la même
-- valeur à la création. Le test de non-lu (`last_message_at > last_read_at`)
-- était donc faux dès le départ : le destinataire voyait la conversation
-- apparaître déjà « lue », sans point ni gras.
--
-- La date de lecture du destinataire est désormais posée dans le passé — il
-- n'a par définition rien lu d'une conversation qui vient d'être créée.

create or replace function create_message_thread(p_recipient_id uuid, p_subject text, p_body text)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_caller_role user_role;
  v_recipient_role user_role;
  v_recipient_status text;
  v_thread_id uuid;
  v_recent integer;
begin
  if p_recipient_id = auth.uid() then
    raise exception 'Vous ne pouvez pas vous envoyer un message à vous-même';
  end if;

  select role into v_caller_role from profiles where id = auth.uid();
  if v_caller_role is null or v_caller_role not in ('client', 'employee', 'admin', 'irs') then
    raise exception 'Accès refusé';
  end if;

  select role, status into v_recipient_role, v_recipient_status from profiles where id = p_recipient_id;
  if v_recipient_role is null then
    raise exception 'Destinataire introuvable';
  end if;
  if v_recipient_status != 'active' then
    raise exception 'Ce destinataire n''est pas disponible';
  end if;
  if v_recipient_role not in ('client', 'employee', 'admin', 'irs') then
    raise exception 'Destinataire invalide';
  end if;
  if not (
    v_caller_role in ('admin', 'employee')
    or (v_caller_role = 'client' and v_recipient_role in ('employee', 'admin'))
    or (v_caller_role = 'irs' and v_recipient_role in ('employee', 'admin'))
  ) then
    raise exception 'Vous ne pouvez pas contacter ce type de profil';
  end if;
  if p_subject is null or trim(p_subject) = '' then
    raise exception 'Le sujet est requis';
  end if;
  if p_body is null or trim(p_body) = '' then
    raise exception 'Le message ne peut pas être vide';
  end if;
  if length(p_subject) > 200 then
    raise exception 'Le sujet est trop long (200 caractères maximum)';
  end if;
  if length(p_body) > 4000 then
    raise exception 'Le message est trop long (4 000 caractères maximum)';
  end if;

  -- Garde-fou anti-inondation : rien ne limitait le nombre de conversations
  -- ouvertes, et chacune émet une notification au destinataire.
  select count(*) into v_recent from message_threads
  where created_by = auth.uid() and created_at > now() - interval '1 hour';
  if v_recent >= 20 then
    raise exception 'Trop de conversations ouvertes en peu de temps. Réessayez dans un moment.';
  end if;

  insert into message_threads (
    created_by, participant_a, participant_a_role, participant_b, participant_b_role, subject,
    participant_a_last_read_at, participant_b_last_read_at, last_message_at)
  values (
    auth.uid(), auth.uid(), v_caller_role, p_recipient_id, v_recipient_role, trim(p_subject),
    now(), 'epoch'::timestamptz, now())
  returning id into v_thread_id;

  insert into thread_messages (thread_id, author_id, author_role, body)
  values (v_thread_id, auth.uid(), v_caller_role, trim(p_body));

  perform notify(p_recipient_id, 'new_message_thread', 'Nouveau message : ' || trim(p_subject),
    left(trim(p_body), 140), '/' || v_recipient_role || '/messages/' || v_thread_id);

  return v_thread_id;
end;
$function$;


-- ----------------------------------------------------------------------------
-- C2. L'expéditeur voyait SA PROPRE conversation passer en non lu
-- ----------------------------------------------------------------------------
-- `send_thread_message` avançait `last_message_at` sans toucher à la date de
-- lecture de l'auteur : sa propre réponse rendait aussitôt la conversation
-- « non lue » de son côté, en gras avec une pastille, dans sa propre liste.
create or replace function send_thread_message(p_thread_id uuid, p_body text)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  th message_threads%rowtype;
  v_caller_role user_role;
  v_other_id uuid;
  v_other_role user_role;
  v_id uuid;
  v_is_a boolean;
begin
  select * into th from message_threads where id = p_thread_id for update;
  if th is null then raise exception 'Conversation introuvable'; end if;
  if auth.uid() != th.participant_a and auth.uid() != th.participant_b then
    raise exception 'Accès refusé';
  end if;
  if th.status = 'closed' then
    raise exception 'Cette conversation est clôturée';
  end if;
  if p_body is null or trim(p_body) = '' then
    raise exception 'Le message ne peut pas être vide';
  end if;
  if length(p_body) > 4000 then
    raise exception 'Le message est trop long (4 000 caractères maximum)';
  end if;

  select role into v_caller_role from profiles where id = auth.uid();

  v_is_a := (auth.uid() = th.participant_a);
  v_other_id := case when v_is_a then th.participant_b else th.participant_a end;
  select role into v_other_role from profiles where id = v_other_id;

  insert into thread_messages (thread_id, author_id, author_role, body)
  values (p_thread_id, auth.uid(), v_caller_role, trim(p_body))
  returning id into v_id;

  update message_threads set
    last_message_at = now(),
    participant_a_last_read_at = case when v_is_a then now() else participant_a_last_read_at end,
    participant_b_last_read_at = case when v_is_a then participant_b_last_read_at else now() end
  where id = p_thread_id;

  perform notify(v_other_id, 'new_message', 'Nouveau message : ' || th.subject,
    left(trim(p_body), 140), '/' || coalesce(v_other_role::text, 'client') || '/messages/' || p_thread_id);

  return v_id;
end;
$function$;


-- ----------------------------------------------------------------------------
-- C3. Une conversation clôturée l'était DÉFINITIVEMENT
-- ----------------------------------------------------------------------------
-- Le bouton « Clôturer » n'avait aucune confirmation et aucune fonction ne
-- permettait de revenir en arrière : `send_thread_message` refuse d'écrire dans
-- une conversation close. Un clic de trop et l'échange était mort pour les deux
-- participants, sans recours — y compris pour l'admin.
create or replace function reopen_message_thread(p_thread_id uuid)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  th message_threads%rowtype;
  v_other_id uuid;
  v_other_role user_role;
begin
  select * into th from message_threads where id = p_thread_id for update;
  if th is null then raise exception 'Conversation introuvable'; end if;
  if auth.uid() != th.participant_a and auth.uid() != th.participant_b then
    raise exception 'Accès refusé';
  end if;
  if th.status <> 'closed' then raise exception 'Cette conversation est déjà ouverte'; end if;

  update message_threads set status = 'open' where id = p_thread_id;

  v_other_id := case when auth.uid() = th.participant_a then th.participant_b else th.participant_a end;
  select role into v_other_role from profiles where id = v_other_id;
  perform notify(v_other_id, 'thread_reopened', 'Conversation rouverte : ' || th.subject,
    null, '/' || coalesce(v_other_role::text, 'client') || '/messages/' || p_thread_id);
end;
$function$;


create or replace function close_message_thread(p_thread_id uuid)
returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  th message_threads%rowtype;
  v_other_id uuid;
  v_other_role user_role;
begin
  select * into th from message_threads where id = p_thread_id for update;
  if th is null then raise exception 'Conversation introuvable'; end if;
  if auth.uid() != th.participant_a and auth.uid() != th.participant_b then
    raise exception 'Accès refusé';
  end if;
  if th.status = 'closed' then raise exception 'Cette conversation est déjà clôturée'; end if;

  update message_threads set status = 'closed' where id = p_thread_id;

  -- L'autre participant doit savoir que l'échange a été clos — jusqu'ici il le
  -- découvrait en tentant de répondre.
  v_other_id := case when auth.uid() = th.participant_a then th.participant_b else th.participant_a end;
  select role into v_other_role from profiles where id = v_other_id;
  perform notify(v_other_id, 'thread_closed', 'Conversation clôturée : ' || th.subject,
    null, '/' || coalesce(v_other_role::text, 'client') || '/messages/' || p_thread_id);
end;
$function$;


-- ----------------------------------------------------------------------------
-- C4. Calcul du non-lu robuste
-- ----------------------------------------------------------------------------
create or replace function list_my_message_threads()
returns table(id uuid, subject text, status text, last_message_at timestamptz, created_at timestamptz,
              other_id uuid, other_display_name text, other_role user_role, unread boolean)
language plpgsql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  return query
  select
    t.id, t.subject, t.status, t.last_message_at, t.created_at,
    (case when t.participant_a = auth.uid() then t.participant_b else t.participant_a end) as other_id,
    p.display_name as other_display_name,
    (case when t.participant_a = auth.uid() then t.participant_b_role else t.participant_a_role end) as other_role,
    coalesce(
      t.last_message_at > coalesce(
        case when t.participant_a = auth.uid() then t.participant_a_last_read_at else t.participant_b_last_read_at end,
        'epoch'::timestamptz),
      false) as unread
  from message_threads t
  join profiles p on p.id = (case when t.participant_a = auth.uid() then t.participant_b else t.participant_a end)
  where t.participant_a = auth.uid() or t.participant_b = auth.uid()
  order by t.last_message_at desc;
end;
$function$;


-- ----------------------------------------------------------------------------
-- Permissions (voir 0015 ; exceptions rappelées en 0021, 0022, 0026 à 0029).
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

grant execute on function record_login_attempt(text, boolean) to anon;
grant execute on function gold_price_snapshot() to anon;
revoke execute on function revoke_user_sessions(uuid) from authenticated;

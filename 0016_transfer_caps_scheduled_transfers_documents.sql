-- ============================================================================
-- NEWPAD — Migration 0016 : plafonds de virement, virements permanents,
--                           documents/relevés, transparence client
-- ============================================================================
-- Lot d'évolutions issu de l'audit du 25/08/2026 (§5nonies), traitant les
-- recommandations de priorité moyenne identifiées mais non implémentées à
-- l'époque, faute de validation.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. PLAFONDS DE VIREMENT
-- ----------------------------------------------------------------------------
-- Jusqu'ici, `min_transfer_amount` était le SEUL seuil de virement :
-- `fraud_unusual_transfer_amount` ne fait que lever une alerte a posteriori,
-- il ne bloque rien. Un compte compromis (ou un client sous la contrainte
-- d'un braqueur en RP) pouvait donc vider intégralement ses comptes en une
-- seule opération. On ajoute deux plafonds, tous deux pilotables globalement
-- ET par client via le mécanisme d'exception existant (get_setting_numeric
-- avec p_client_id) : 0 = illimité, pour rester rétro-compatible.

insert into economic_settings (key, label, value, value_type, category) values
  ('max_transfer_amount', 'Plafond par virement (0 = illimité)', '{"amount": 0}', 'money', 'seuils'),
  ('max_daily_transfer_total', 'Plafond cumulé de virements sur 24 h (0 = illimité)', '{"amount": 0}', 'money', 'seuils')
on conflict (key) do nothing;

create or replace function submit_transfer(p_sender_account_id uuid, p_recipient_account_id uuid, p_amount numeric, p_motif text)
returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_client_id uuid;
  v_recipient_client_id uuid;
  v_is_internal boolean;
  v_min_amount numeric;
  v_max_amount numeric;
  v_max_daily numeric;
  v_today_total numeric;
  v_id uuid;
begin
  -- Reprise du correctif 0018 (virement d'un compte vers lui-même) : cette
  -- migration réécrit submit_transfer et l'effacerait sans cette ligne, quel
  -- que soit l'ordre d'application des deux migrations.
  if p_sender_account_id = p_recipient_account_id then
    raise exception 'Le compte émetteur et le compte destinataire doivent être différents';
  end if;

  select client_id into v_client_id from accounts where id = p_sender_account_id;
  if v_client_id is null or v_client_id != auth.uid() then
    raise exception 'Compte émetteur invalide';
  end if;
  select client_id into v_recipient_client_id from accounts where id = p_recipient_account_id;
  if v_recipient_client_id is null then
    raise exception 'Compte destinataire invalide';
  end if;

  v_is_internal := (v_recipient_client_id = v_client_id);

  if not v_is_internal then
    v_min_amount := coalesce(get_setting_numeric('min_transfer_amount', v_client_id), 100000);
    if p_amount < v_min_amount then
      raise exception 'Le montant minimum de virement est de % $', v_min_amount;
    end if;
  end if;

  if p_amount <= 0 then
    raise exception 'Montant invalide';
  end if;

  -- Plafonds (0 ou absent = illimité). Les virements internes (entre les
  -- comptes d'un même client) ne sont pas plafonnés : l'argent ne quitte
  -- jamais le patrimoine du client, plafonner n'apporterait aucune sécurité.
  if not v_is_internal then
    v_max_amount := coalesce(get_setting_numeric('max_transfer_amount', v_client_id), 0);
    if v_max_amount > 0 and p_amount > v_max_amount then
      raise exception 'Le plafond par virement est de % $. Contactez la banque pour un relèvement.', v_max_amount;
    end if;

    v_max_daily := coalesce(get_setting_numeric('max_daily_transfer_total', v_client_id), 0);
    if v_max_daily > 0 then
      -- Cumul des virements non refusés des dernières 24 h, toutes demandes
      -- confondues (en attente, en traitement ou validées) : une demande en
      -- attente engage déjà le plafond, sinon il suffirait d'empiler les
      -- demandes plus vite que le personnel ne les traite pour le contourner.
      select coalesce(sum(t.amount), 0) into v_today_total
      from transfers t
      join accounts a on a.id = t.sender_account_id
      where a.client_id = v_client_id
        and t.is_internal = false
        and t.status <> 'rejected'
        and t.requested_at > now() - interval '24 hours';

      if v_today_total + p_amount > v_max_daily then
        raise exception 'Plafond de % $ sur 24 h dépassé (déjà % $ engagés). Contactez la banque pour un relèvement.', v_max_daily, v_today_total;
      end if;
    end if;
  end if;

  insert into transfers (sender_account_id, recipient_account_id, amount, motif, is_internal)
  values (p_sender_account_id, p_recipient_account_id, p_amount, p_motif, v_is_internal)
  returning id into v_id;

  perform notify_all_staff('transfer_request', 'Nouveau virement à traiter', p_amount || ' $', '/employee/transfers');

  return v_id;
end;
$function$;

-- ----------------------------------------------------------------------------
-- 2. VIREMENTS PERMANENTS (programmés / récurrents)
-- ----------------------------------------------------------------------------
-- Cas d'usage RP : salaire versé par une entreprise à ses employés, loyer,
-- versement régulier vers son compte épargne.
--
-- CHOIX D'ARCHITECTURE IMPORTANT : l'échéance ne débite JAMAIS directement.
-- Elle dépose une demande de virement ordinaire (`transfers`, statut
-- 'pending') que le personnel valide comme n'importe quelle autre. C'est
-- délibéré : le principe central du projet est qu'aucun mouvement de fonds
-- n'existe sans validation d'une action prévue par le système. Un virement
-- permanent qui s'exécuterait tout seul créerait un contournement permanent
-- de ce contrôle — un client pourrait programmer un virement pour qu'il
-- s'exécute pendant qu'aucun employé n'est connecté. Le gain pour le client
-- reste réel : il ne ressaisit plus rien, l'échéance est déposée toute seule.

create table if not exists scheduled_transfers (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references profiles(id) on delete cascade,
  sender_account_id uuid not null references accounts(id) on delete cascade,
  recipient_account_id uuid not null references accounts(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  motif text,
  frequency_days int not null check (frequency_days between 1 and 365),
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  runs_count int not null default 0,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  cancelled_reason text,
  created_at timestamptz not null default now()
);

comment on table scheduled_transfers is 'Virements permanents. Chaque échéance dépose une demande de virement ordinaire soumise à validation du personnel — jamais de débit automatique.';

create index if not exists idx_scheduled_transfers_client on scheduled_transfers(client_id, created_at desc);
create index if not exists idx_scheduled_transfers_due on scheduled_transfers(next_run_at) where status = 'active';

alter table scheduled_transfers enable row level security;

-- Lecture seule directe ; toute écriture passe par les fonctions ci-dessous.
drop policy if exists scheduled_transfers_select on scheduled_transfers;
create policy scheduled_transfers_select on scheduled_transfers
  for select using (client_id = auth.uid() or is_staff());

create or replace function create_scheduled_transfer(
  p_sender_account_id uuid,
  p_recipient_account_id uuid,
  p_amount numeric,
  p_motif text,
  p_frequency_days int,
  p_first_run_at timestamptz default null
) returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_client_id uuid;
  v_recipient_client_id uuid;
  v_is_internal boolean;
  v_min_amount numeric;
  v_max_amount numeric;
  v_first timestamptz;
  v_id uuid;
begin
  select client_id into v_client_id from accounts where id = p_sender_account_id and status = 'active';
  if v_client_id is null or v_client_id != auth.uid() then
    raise exception 'Compte émetteur invalide ou inactif';
  end if;
  select client_id into v_recipient_client_id from accounts where id = p_recipient_account_id and status = 'active';
  if v_recipient_client_id is null then
    raise exception 'Compte destinataire invalide ou inactif';
  end if;
  if p_amount <= 0 then raise exception 'Montant invalide'; end if;
  if p_frequency_days is null or p_frequency_days < 1 or p_frequency_days > 365 then
    raise exception 'La fréquence doit être comprise entre 1 et 365 jours';
  end if;

  v_is_internal := (v_recipient_client_id = v_client_id);

  -- Mêmes bornes que pour un virement ponctuel : inutile de laisser
  -- programmer une échéance qui sera systématiquement refusée à l'exécution.
  if not v_is_internal then
    v_min_amount := coalesce(get_setting_numeric('min_transfer_amount', v_client_id), 100000);
    if p_amount < v_min_amount then
      raise exception 'Le montant minimum de virement est de % $', v_min_amount;
    end if;
    v_max_amount := coalesce(get_setting_numeric('max_transfer_amount', v_client_id), 0);
    if v_max_amount > 0 and p_amount > v_max_amount then
      raise exception 'Le plafond par virement est de % $', v_max_amount;
    end if;
  end if;

  v_first := coalesce(p_first_run_at, now() + (p_frequency_days || ' days')::interval);
  if v_first < now() - interval '1 minute' then
    raise exception 'La première échéance ne peut pas être dans le passé';
  end if;

  insert into scheduled_transfers (client_id, sender_account_id, recipient_account_id, amount, motif, frequency_days, next_run_at)
  values (v_client_id, p_sender_account_id, p_recipient_account_id, p_amount, p_motif, p_frequency_days, v_first)
  returning id into v_id;

  perform log_audit('create_scheduled_transfer', 'scheduled_transfers', v_id, jsonb_build_object(
    'amount', p_amount, 'frequency_days', p_frequency_days, 'first_run_at', v_first));

  return v_id;
end;
$function$;

create or replace function cancel_scheduled_transfer(p_id uuid, p_reason text default null) returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_row scheduled_transfers%rowtype;
begin
  select * into v_row from scheduled_transfers where id = p_id and status = 'active';
  if v_row is null then raise exception 'Virement permanent introuvable ou déjà annulé'; end if;
  if v_row.client_id <> auth.uid() and not is_staff() then
    raise exception 'Ce virement permanent ne vous appartient pas';
  end if;

  update scheduled_transfers
  set status = 'cancelled', cancelled_reason = p_reason
  where id = p_id;

  -- Annulation par le personnel : le client doit en être informé.
  if v_row.client_id <> auth.uid() then
    perform notify(v_row.client_id, 'scheduled_transfer_cancelled', 'Virement permanent annulé par la banque',
      coalesce(p_reason, 'Contactez votre conseiller pour plus d''informations.'), '/client/transfers');
  end if;

  perform log_audit('cancel_scheduled_transfer', 'scheduled_transfers', p_id, jsonb_build_object('reason', p_reason));
end;
$function$;

-- Liste enrichie : le client ne peut pas lire directement le compte
-- destinataire d'un tiers (RLS `accounts_select`), il faut donc résoudre
-- l'IBAN et le nom du bénéficiaire côté serveur, comme le fait déjà
-- resolve_account_by_iban pour un virement ponctuel.
create or replace function list_my_scheduled_transfers()
returns table (
  id uuid,
  amount numeric,
  motif text,
  frequency_days int,
  next_run_at timestamptz,
  last_run_at timestamptz,
  runs_count int,
  status text,
  sender_iban text,
  recipient_iban text,
  recipient_name text
)
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  select s.id, s.amount, s.motif, s.frequency_days, s.next_run_at, s.last_run_at,
         s.runs_count, s.status,
         sa.iban, ra.iban,
         coalesce(rp.display_name, 'Compte banque')
  from scheduled_transfers s
  join accounts sa on sa.id = s.sender_account_id
  join accounts ra on ra.id = s.recipient_account_id
  left join profiles rp on rp.id = ra.client_id
  where s.client_id = auth.uid()
  order by (s.status = 'active') desc, s.next_run_at asc;
$function$;

create or replace function process_scheduled_transfers() returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  s record;
  v_sender accounts%rowtype;
  v_recipient accounts%rowtype;
  v_transfer_id uuid;
begin
  for s in
    select * from scheduled_transfers
    where status = 'active' and next_run_at <= now()
    order by next_run_at asc
  loop
    select * into v_sender from accounts where id = s.sender_account_id;
    select * into v_recipient from accounts where id = s.recipient_account_id;

    -- Un compte fermé/gelé d'un côté ou de l'autre rend l'échéance
    -- impossible : on annule le virement permanent plutôt que d'empiler
    -- indéfiniment des demandes vouées au refus, et on prévient le client.
    if v_sender is null or v_sender.status <> 'active'
       or v_recipient is null or v_recipient.status <> 'active' then
      update scheduled_transfers
      set status = 'cancelled',
          cancelled_reason = 'Compte émetteur ou destinataire inactif à l''échéance'
      where id = s.id;
      perform notify(s.client_id, 'scheduled_transfer_cancelled', 'Virement permanent annulé',
        'Un des comptes concernés n''est plus actif.', '/client/transfers');
      continue;
    end if;

    insert into transfers (sender_account_id, recipient_account_id, amount, motif, is_internal)
    values (s.sender_account_id, s.recipient_account_id, s.amount,
            coalesce(s.motif, 'Virement permanent'),
            (v_sender.client_id = v_recipient.client_id))
    returning id into v_transfer_id;

    update scheduled_transfers
    set last_run_at = now(),
        runs_count = runs_count + 1,
        next_run_at = next_run_at + (s.frequency_days || ' days')::interval
    where id = s.id;

    perform notify(s.client_id, 'scheduled_transfer_submitted', 'Échéance de virement permanent déposée',
      s.amount || ' $ — en attente de validation par la banque', '/client/transfers');
    perform notify_all_staff('transfer_request', 'Virement permanent à traiter', s.amount || ' $', '/employee/transfers');
  end loop;
end;
$function$;

-- Échéances traitées à 05h00 UTC, après les frais (03h00) et les échéances
-- de prêt (04h00), pour que le solde du jour soit déjà à jour.
select cron.schedule('newpad-scheduled-transfers', '0 5 * * *', $$select process_scheduled_transfers();$$);

-- ----------------------------------------------------------------------------
-- 3. DOCUMENTS / RELEVÉS — branchement du stockage
-- ----------------------------------------------------------------------------
-- La table `documents` et ses policies existent depuis la migration 0001b, et
-- l'écran client `/client/documents` sait les afficher depuis la phase 3 —
-- mais aucun bucket Storage n'avait jamais été créé et aucune interface ne
-- permettait d'en émettre. Le message « Vos relevés et attestations
-- apparaîtront ici » ne pouvait donc jamais se réaliser. On ouvre le circuit.

insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- Convention de chemin : <client_id>/<uuid>-<nom du fichier>. Le premier
-- segment du chemin porte donc l'autorisation de lecture côté client.
drop policy if exists documents_bucket_staff_insert on storage.objects;
create policy documents_bucket_staff_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents' and public.is_staff());

drop policy if exists documents_bucket_select on storage.objects;
create policy documents_bucket_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (public.is_staff() or (storage.foldername(name))[1] = auth.uid()::text)
  );

drop policy if exists documents_bucket_staff_delete on storage.objects;
create policy documents_bucket_staff_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents' and public.is_staff());

-- Émission d'un document : l'insertion directe était déjà permise au
-- personnel par la policy `documents_staff_insert`, mais passer par une
-- fonction permet de notifier le client et de journaliser dans le même
-- mouvement (le client doit savoir qu'un relevé l'attend).
create or replace function staff_create_document(
  p_client_id uuid,
  p_doc_type text,
  p_title text,
  p_period_label text default null,
  p_storage_path text default null
) returns uuid
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id uuid;
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  if p_doc_type not in ('releve', 'rib', 'contrat', 'attestation', 'autre') then
    raise exception 'Type de document invalide';
  end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'Le titre est obligatoire'; end if;

  insert into documents (client_id, doc_type, title, period_label, storage_path, generated_by)
  values (p_client_id, p_doc_type, trim(p_title), p_period_label, p_storage_path, auth.uid())
  returning id into v_id;

  perform notify(p_client_id, 'document_issued', 'Nouveau document disponible', trim(p_title), '/client/documents');
  perform log_audit('staff_create_document', 'documents', v_id, jsonb_build_object(
    'client', (select display_name from profiles where id = p_client_id),
    'doc_type', p_doc_type, 'title', trim(p_title)));

  return v_id;
end;
$function$;

create or replace function staff_delete_document(p_id uuid) returns void
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not is_staff() then raise exception 'Réservé au personnel'; end if;
  delete from documents where id = p_id;
  if not found then raise exception 'Document introuvable'; end if;
  perform log_audit('staff_delete_document', 'documents', p_id, '{}'::jsonb);
end;
$function$;

-- Liste des documents d'un client, pour la fiche client côté personnel.
create or replace function staff_list_client_documents(p_client_id uuid)
returns setof documents
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  select * from documents
  where is_staff() and client_id = p_client_id
  order by created_at desc;
$function$;

-- ----------------------------------------------------------------------------
-- 4. ENREGISTREMENT DES NOUVEAUX ÉCRANS AU REGISTRE DE FONCTIONNALITÉS
-- ----------------------------------------------------------------------------

insert into feature_registry (key, label, area, category, default_roles, enabled, is_core) values
  ('client.transfers.scheduled', 'Virements permanents', 'client', 'Comptes & Virements', '{client}', true, false)
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- 5. PERMISSIONS D'EXÉCUTION
-- ----------------------------------------------------------------------------
-- Rappel de l'audit 0015 : PostgreSQL accorde EXECUTE à PUBLIC par défaut à
-- la création d'une fonction. Toute migration qui en crée doit refermer
-- explicitement, sinon les nouvelles fonctions redeviennent appelables par un
-- visiteur anonyme.
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

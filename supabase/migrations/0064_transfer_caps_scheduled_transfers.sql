-- ############################################################################
-- 0064 — PLAFONDS DE VIREMENT ET VIREMENTS PERMANENTS
-- ############################################################################
-- Reprise de la 0016 (écrite en août, jamais appliquée), vérifiée et adaptée
-- le 29/09/2026 sur décision de l'exploitant. La 0016 n'est PAS appliquée
-- telle quelle :
--   - son `submit_transfer` datait d'août et aurait effacé les correctifs
--     posés depuis (profil suspendu, registre de fonctionnalités, comptes
--     gelés, contrôle de solde, arrondi) : on repart de la version en base ;
--   - sa partie « documents » (bucket Storage) est remplacée par les
--     documents texte de la 0034, déjà en service.
--
-- 1. Plafonds : le plafond par virement était LU par submit_transfer mais le
--    réglage n'existait pas ; on crée les deux réglages, à 0 = illimité, donc
--    sans effet tant que l'admin ne les pose pas. Pilotables par client via
--    le mécanisme d'exception existant.
-- 2. Le contrôle de solde au dépôt inclut désormais la commission, payée par
--    l'émetteur depuis la 0062.
-- 3. Virements permanents : une échéance ne débite JAMAIS directement. Elle
--    dépose une demande de virement ordinaire que le personnel valide — sinon
--    un client pourrait programmer un mouvement de fonds pour une heure où
--    aucun employé n'est connecté.
-- ############################################################################

insert into economic_settings (key, label, value, value_type, category) values
  ('max_transfer_amount', 'Plafond par virement (0 = illimité)', '{"amount": 0}', 'money', 'seuils'),
  ('max_daily_transfer_total', 'Plafond cumulé de virements sur 24 h (0 = illimité)', '{"amount": 0}', 'money', 'seuils')
on conflict (key) do nothing;

create or replace function public.submit_transfer(p_sender_account_id uuid, p_recipient_account_id uuid, p_amount numeric, p_motif text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_client_id uuid;
  v_balance numeric;
  v_recipient_client_id uuid;
  v_is_internal boolean;
  v_min_amount numeric;
  v_max_amount numeric;
  v_max_daily numeric;
  v_engage numeric;
  v_fee numeric := 0;
  v_montant numeric;
  v_id uuid;
begin
  perform require_active_profile();
  perform require_feature('client.transfers.create');
  if p_sender_account_id = p_recipient_account_id then
    raise exception 'Le compte émetteur et le compte destinataire doivent être différents';
  end if;

  v_montant := round(coalesce(p_amount, 0), 2);

  select client_id, balance into v_client_id, v_balance
  from accounts where id = p_sender_account_id and status = 'active';
  if v_client_id is null or v_client_id != auth.uid() then
    raise exception 'Compte émetteur invalide ou inactif';
  end if;

  select client_id into v_recipient_client_id
  from accounts where id = p_recipient_account_id and status = 'active';
  if v_recipient_client_id is null then
    raise exception 'Compte destinataire invalide ou inactif';
  end if;

  if v_montant <= 0 then
    raise exception 'Montant invalide';
  end if;

  v_is_internal := (v_recipient_client_id = v_client_id);

  if not v_is_internal then
    v_fee := round(v_montant * coalesce((get_setting('transfer_commission_rate')->>'amount')::numeric, 0) / 100, 2);
  end if;

  if v_montant + v_fee > v_balance then
    raise exception 'Solde insuffisant : % $ disponibles sur ce compte (il faut % $, commission comprise).',
      v_balance, v_montant + v_fee;
  end if;

  if not v_is_internal then
    v_min_amount := coalesce(get_setting_numeric('min_transfer_amount', v_client_id), 100000);
    if v_montant < v_min_amount then
      raise exception 'Le montant minimum de virement est de % $', v_min_amount;
    end if;
    v_max_amount := get_setting_numeric('max_transfer_amount', v_client_id);
    if v_max_amount is not null and v_max_amount > 0 and v_montant > v_max_amount then
      raise exception 'Le plafond par virement est de % $. Contactez la banque pour un relèvement.', v_max_amount;
    end if;

    -- Plafond sur 24 h glissantes : une demande en attente engage déjà le
    -- plafond, sinon il suffirait d'empiler les demandes plus vite que le
    -- personnel ne les traite. Les virements internes n'y entrent pas :
    -- l'argent ne quitte pas le patrimoine du client.
    v_max_daily := get_setting_numeric('max_daily_transfer_total', v_client_id);
    if v_max_daily is not null and v_max_daily > 0 then
      select coalesce(sum(t.amount), 0) into v_engage
      from transfers t
      join accounts a on a.id = t.sender_account_id
      where a.client_id = v_client_id
        and not t.is_internal
        and t.status not in ('rejected', 'cancelled')
        and t.requested_at > now() - interval '24 hours';
      if v_engage + v_montant > v_max_daily then
        raise exception 'Plafond de % $ sur 24 h dépassé (% $ déjà engagés). Contactez la banque pour un relèvement.',
          v_max_daily, v_engage;
      end if;
    end if;
  end if;

  insert into transfers (sender_account_id, recipient_account_id, amount, motif, is_internal)
  values (p_sender_account_id, p_recipient_account_id, v_montant, p_motif, v_is_internal)
  returning id into v_id;

  perform notify_all_staff('transfer_request', 'Nouveau virement à traiter', v_montant || ' $', '/employee/transfers');

  return v_id;
end;
$function$;

-- ----------------------------------------------------------------------------
-- Virements permanents
-- ----------------------------------------------------------------------------
create table if not exists scheduled_transfers (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references profiles(id) on delete cascade,
  sender_account_id uuid not null references accounts(id) on delete cascade,
  recipient_account_id uuid not null references accounts(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  motif text check (motif is null or length(motif) <= 200),
  frequency_days int not null check (frequency_days between 1 and 365),
  next_run_at timestamptz not null,
  last_run_at timestamptz,
  runs_count int not null default 0,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  cancelled_reason text,
  created_at timestamptz not null default now(),
  check (sender_account_id <> recipient_account_id)
);
comment on table scheduled_transfers is
  'Virements permanents. Chaque échéance dépose une demande de virement ordinaire, soumise à la validation du personnel — jamais de débit automatique.';

create index if not exists idx_scheduled_transfers_client on scheduled_transfers(client_id, created_at desc);
create index if not exists idx_scheduled_transfers_due on scheduled_transfers(next_run_at) where status = 'active';

alter table scheduled_transfers enable row level security;
drop policy if exists scheduled_transfers_select on scheduled_transfers;
create policy scheduled_transfers_select on scheduled_transfers
  for select to authenticated using (client_id = auth.uid() or is_staff());

create or replace function create_scheduled_transfer(
  p_sender_account_id uuid, p_recipient_account_id uuid, p_amount numeric,
  p_motif text, p_frequency_days int, p_first_run_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_client_id uuid; v_recipient_client_id uuid; v_is_internal boolean;
  v_min_amount numeric; v_max_amount numeric; v_montant numeric; v_first timestamptz; v_id uuid;
begin
  perform require_active_profile();
  perform require_feature('client.transfers.scheduled');
  if p_sender_account_id = p_recipient_account_id then
    raise exception 'Le compte émetteur et le compte destinataire doivent être différents';
  end if;
  v_montant := round(coalesce(p_amount, 0), 2);

  select client_id into v_client_id from accounts where id = p_sender_account_id and status = 'active';
  if v_client_id is null or v_client_id <> auth.uid() then
    raise exception 'Compte émetteur invalide ou inactif';
  end if;
  select client_id into v_recipient_client_id from accounts where id = p_recipient_account_id and status = 'active';
  if v_recipient_client_id is null then raise exception 'Compte destinataire invalide ou inactif'; end if;
  if v_montant <= 0 then raise exception 'Montant invalide'; end if;
  if p_frequency_days is null or p_frequency_days not between 1 and 365 then
    raise exception 'La fréquence doit être comprise entre 1 et 365 jours';
  end if;

  -- Mêmes bornes qu'un virement ponctuel : inutile de programmer une
  -- échéance qui sera refusée à chaque fois.
  v_is_internal := (v_recipient_client_id = v_client_id);
  if not v_is_internal then
    v_min_amount := coalesce(get_setting_numeric('min_transfer_amount', v_client_id), 100000);
    if v_montant < v_min_amount then
      raise exception 'Le montant minimum de virement est de % $', v_min_amount;
    end if;
    v_max_amount := get_setting_numeric('max_transfer_amount', v_client_id);
    if v_max_amount is not null and v_max_amount > 0 and v_montant > v_max_amount then
      raise exception 'Le plafond par virement est de % $', v_max_amount;
    end if;
  end if;

  v_first := coalesce(p_first_run_at, now() + make_interval(days => p_frequency_days));
  if v_first < now() - interval '1 minute' then
    raise exception 'La première échéance ne peut pas être dans le passé';
  end if;

  insert into scheduled_transfers (client_id, sender_account_id, recipient_account_id, amount, motif, frequency_days, next_run_at)
  values (v_client_id, p_sender_account_id, p_recipient_account_id, v_montant,
          nullif(trim(coalesce(p_motif, '')), ''), p_frequency_days, v_first)
  returning id into v_id;

  perform log_audit('create_scheduled_transfer', 'scheduled_transfers', v_id, jsonb_build_object(
    'amount', v_montant, 'frequency_days', p_frequency_days, 'first_run_at', v_first));
  return v_id;
end;
$function$;

create or replace function cancel_scheduled_transfer(p_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare v_row scheduled_transfers%rowtype;
begin
  perform require_active_profile();
  select * into v_row from scheduled_transfers where id = p_id and status = 'active';
  if v_row.id is null then raise exception 'Virement permanent introuvable ou déjà annulé'; end if;
  if v_row.client_id <> auth.uid() and not is_staff() then
    raise exception 'Ce virement permanent ne vous appartient pas';
  end if;

  update scheduled_transfers set status = 'cancelled', cancelled_reason = p_reason where id = p_id;

  if v_row.client_id <> auth.uid() then
    perform notify(v_row.client_id, 'scheduled_transfer_cancelled', 'Virement permanent annulé par la banque',
      coalesce(p_reason, 'Contactez votre conseiller pour plus d''informations.'), '/client/transfers');
  end if;
  perform log_audit('cancel_scheduled_transfer', 'scheduled_transfers', p_id, jsonb_build_object('reason', p_reason));
end;
$function$;

-- Le client ne peut pas lire le compte d'un tiers (RLS) : l'IBAN et le nom du
-- bénéficiaire sont résolus ici, comme resolve_account_by_iban.
create or replace function list_my_scheduled_transfers()
returns table (id uuid, amount numeric, motif text, frequency_days int, next_run_at timestamptz,
               last_run_at timestamptz, runs_count int, status text,
               sender_iban text, recipient_iban text, recipient_name text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select s.id, s.amount, s.motif, s.frequency_days, s.next_run_at, s.last_run_at,
         s.runs_count, s.status, sa.iban, ra.iban,
         coalesce(rp.display_name, 'Newman Bank')
  from scheduled_transfers s
  join accounts sa on sa.id = s.sender_account_id
  join accounts ra on ra.id = s.recipient_account_id
  left join profiles rp on rp.id = ra.client_id
  where s.client_id = auth.uid()
  order by (s.status = 'active') desc, s.next_run_at asc
  limit 100;
$function$;

-- Tâche planifiée : dépose les échéances dues comme demandes ordinaires.
create or replace function process_scheduled_transfers()
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  s record; v_sender accounts%rowtype; v_recipient accounts%rowtype; v_statut text;
begin
  for s in select * from scheduled_transfers
            where status = 'active' and next_run_at <= now()
            order by next_run_at loop
    select * into v_sender from accounts where id = s.sender_account_id;
    select * into v_recipient from accounts where id = s.recipient_account_id;
    select status into v_statut from profiles where id = s.client_id;

    -- Un compte fermé ou gelé rend l'échéance impossible : on annule plutôt
    -- que d'empiler des demandes vouées au refus, et on prévient le client.
    if v_sender.id is null or v_sender.status <> 'active'
       or v_recipient.id is null or v_recipient.status <> 'active' then
      update scheduled_transfers
         set status = 'cancelled', cancelled_reason = 'Compte émetteur ou destinataire inactif à l''échéance'
       where id = s.id;
      perform notify(s.client_id, 'scheduled_transfer_cancelled', 'Virement permanent annulé',
        'Un des comptes concernés n''est plus actif.', '/client/transfers');
      continue;
    end if;

    -- Profil suspendu ou gelé : l'échéance attend, sans être annulée.
    if v_statut is distinct from 'active' then continue; end if;

    insert into transfers (sender_account_id, recipient_account_id, amount, motif, is_internal)
    values (s.sender_account_id, s.recipient_account_id, s.amount,
            coalesce(s.motif, 'Virement permanent'), v_sender.client_id = v_recipient.client_id);

    update scheduled_transfers
       set last_run_at = now(), runs_count = runs_count + 1,
           next_run_at = next_run_at + make_interval(days => s.frequency_days)
     where id = s.id;

    perform notify(s.client_id, 'scheduled_transfer_submitted', 'Échéance de virement permanent déposée',
      s.amount || ' $ — en attente de validation par la banque', '/client/transfers');
    perform notify_all_staff('transfer_request', 'Virement permanent à traiter', s.amount || ' $', '/employee/transfers');
  end loop;
end;
$function$;

-- 05 h 00 UTC : après les frais (03 h) et les échéances de prêt (04 h).
select cron.schedule('newpad-scheduled-transfers', '0 5 * * *', $$select process_scheduled_transfers();$$);

insert into feature_registry (key, label, area, category, default_roles, enabled, is_core) values
  ('client.transfers.scheduled', 'Virements permanents', 'client', 'Comptes & Virements', '{client}', true, false)
on conflict (key) do nothing;

do $verif$
declare v_mauvaises text;
begin
  select string_agg(policyname || ' (' || tablename || ')', ', ') into v_mauvaises
  from pg_policies
  where schemaname = 'public'
    and (coalesce(qual, '') || coalesce(with_check, '')) ~ '[^a-zA-Z0-9_]_[a-z][a-z_]*\(';
  if v_mauvaises is not null then
    raise exception 'Policies appelant une fonction interne : %', v_mauvaises;
  end if;
end
$verif$;

revoke execute on function create_scheduled_transfer(uuid, uuid, numeric, text, int, timestamptz) from public, anon;
revoke execute on function cancel_scheduled_transfer(uuid, text) from public, anon;
revoke execute on function list_my_scheduled_transfers() from public, anon;
-- Réservée à la tâche planifiée : un client qui l'appellerait déposerait en
-- avance les échéances de tout le monde.
revoke execute on function process_scheduled_transfers() from public, anon, authenticated;
grant execute on function create_scheduled_transfer(uuid, uuid, numeric, text, int, timestamptz) to authenticated;
grant execute on function cancel_scheduled_transfer(uuid, text) to authenticated;
grant execute on function list_my_scheduled_transfers() to authenticated;

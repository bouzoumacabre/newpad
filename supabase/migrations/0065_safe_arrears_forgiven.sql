-- ############################################################################
-- 0065 — COFFRES : au-delà de 8 semaines, les arriérés sont effacés
-- ############################################################################
-- Décision de l'exploitant (29/09/2026). Le prélèvement était plafonné à 8
-- semaines par passage, mais la date de dernier prélèvement n'avançait que de
-- ces 8 semaines : le reste des arriérés tombait les jours suivants, 8
-- semaines à la fois, quitte à mettre le compte en négatif. Désormais, au
-- plus 8 semaines sont prélevées et le reste est effacé : un joueur ne se
-- retrouve jamais avec une grosse dette surprise après une panne de la tâche
-- ou un compte bloqué. Le client est prévenu du nombre de semaines effacées.
-- Aucun coffre n'était loué au moment de la migration.
-- ############################################################################

create or replace function public.charge_safe_weekly_fees()
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  box record;
  v_account uuid;
  v_bank_account uuid;
  v_tx_id uuid;
  v_depuis timestamptz;
  v_dues int;
  v_semaines int;
  v_effacees int;
  v_montant numeric;
  v_echecs int := 0;
  v_premier text;
begin
  v_bank_account := bank_treasury_account_id();

  for box in
    select * from safe_deposit_boxes
    where status = 'rented'
      and client_id is not null
      and weekly_fee > 0
      and (last_charged_at is null or last_charged_at <= now() - interval '7 days')
  loop
    begin
      v_depuis := coalesce(box.last_charged_at, now() - interval '7 days');
      v_dues := greatest(1, floor(extract(epoch from (now() - v_depuis)) / 604800)::int);
      v_semaines := least(8, v_dues);
      v_effacees := v_dues - v_semaines;
      v_montant := round(box.weekly_fee * v_semaines, 2);

      select id into v_account from accounts
      where client_id = box.client_id and status = 'active'
      order by is_bank_treasury, opened_at limit 1;

      if v_account is null then
        perform notify_all_staff('safe_fee_failed', 'Loyer de coffre non prélevé — client sans compte actif',
          'Coffre ' || box.code, '/employee/safes');
        continue;
      end if;

      perform _adjust_balance(v_account, -v_montant);
      perform _adjust_balance(v_bank_account, v_montant);

      insert into transactions (tx_type, status, from_account_id, to_account_id, amount, description, created_by)
      values ('safe_rental', 'validated', v_account, v_bank_account, v_montant,
              'Location coffre ' || box.code || ' (' || v_semaines || ' semaine(s)'
              || case when v_effacees > 0 then ', ' || v_effacees || ' effacée(s)' else '' end || ')', null)
      returning id into v_tx_id;

      -- Toutes les semaines dues sont soldées : prélevées ou effacées.
      update safe_deposit_boxes
      set last_charged_at = v_depuis + (v_dues * interval '7 days')
      where id = box.id;

      perform notify(box.client_id, 'safe_fee_charged', 'Loyer du coffre prélevé',
        v_montant || ' $ — coffre ' || box.code ||
        case when v_semaines > 1 then ' (' || v_semaines || ' semaines)' else '' end ||
        case when v_effacees > 0 then ' — ' || v_effacees || ' semaine(s) d''arriérés effacée(s) par la banque' else '' end,
        '/client/safes');

      if (select balance from accounts where id = v_account) < 0 then
        perform notify_all_staff('account_negative', 'Compte client passé en négatif suite au loyer d''un coffre',
          box.client_id::text, '/employee/clients');
      end if;
    exception when others then
      v_echecs := v_echecs + 1;
      if v_premier is null then v_premier := 'Coffre ' || box.code || ' : ' || sqlerrm; end if;
    end;
  end loop;

  if v_echecs > 0 then
    perform notify_all_staff('safe_fee_failed', v_echecs || ' loyer(s) de coffre non prélevé(s)',
      left(coalesce(v_premier, ''), 200), '/employee/safes');
  end if;
end;
$function$;

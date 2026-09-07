-- ============================================================================
-- NEWPAD — Test de fumée des fonctions de lecture
-- ============================================================================
-- À coller dans le SQL Editor de Supabase. Ne modifie RIEN : le bloc se termine
-- par une exception qui annule la transaction, et le résultat est dans le
-- message d'erreur. Une erreur « P0001: RESULTAT: ... » est donc le SUCCÈS.
--
-- ----------------------------------------------------------------------------
-- Pourquoi ce test existe
-- ----------------------------------------------------------------------------
-- L'audit segmenté a trouvé trois fonctions qui n'avaient JAMAIS fonctionné :
--
--   list_messageable_contacts  « column reference "role" is ambiguous »
--   my_transactions            « column reference "id" is ambiguous »
--   my_feature_flags           « structure of query does not match ... »
--
-- Les trois se créent sans erreur : PostgreSQL ne vérifie le corps d'une
-- fonction PL/pgSQL qu'à l'exécution. Les trois échouaient à chaque appel. Et
-- les trois sont restées invisibles pour la même raison — l'appel côté écran
-- est enveloppé dans un repli qui renvoie une liste vide, donc l'utilisateur
-- voit « aucun résultat » au lieu d'une erreur.
--
-- Relire le code ne les trouve pas : la requête est correcte, c'est sa
-- collision avec la signature qui ne l'est pas. Seul un appel réel les révèle.
--
-- ----------------------------------------------------------------------------
-- Quand le rejouer
-- ----------------------------------------------------------------------------
-- Après toute migration qui crée ou recrée une fonction de lecture, et avant
-- chaque livraison de frontend. Ajouter les nouvelles fonctions à la liste.
--
-- Un refus d'accès volontaire (« Réservé au personnel », « Fonctionnalité
-- indisponible », « Accès refusé ») est le comportement attendu et n'est pas
-- signalé. Seule une erreur SQL l'est.
-- ============================================================================

do $do$
declare
  v_uid uuid;
  v_role text;
  f text;
  n bigint;
  v_res text := '';
  v_msg text;
  v_appels int := 0;

  -- Fonctions de lecture appelables sans argument obligatoire : celles qu'un
  -- écran déclenche à son ouverture. Requête pour régénérer cette liste :
  --
  --   select p.proname from pg_proc p
  --   where p.pronamespace = 'public'::regnamespace
  --     and has_function_privilege('authenticated', p.oid, 'execute')
  --     and p.provolatile in ('s','i')
  --     and p.pronargs = p.pronargdefaults
  --   order by 1;
  fonctions text[] := array[
    'admin_check_ledger_integrity','admin_list_account_anomalies','admin_list_login_log',
    'admin_treasury_stats','gold_price_snapshot','irs_list_accounts','irs_list_clients',
    'irs_list_gold_bars','irs_list_transactions','irs_stats','is_admin','is_irs','is_staff',
    'list_audit_actions','list_distinct_tx_types','list_messageable_contacts',
    'list_my_message_threads','my_feature_flags','my_transaction_types','my_transactions',
    'staff_list_audit_log','staff_list_documents','staff_list_transactions'
  ];
  roles text[] := array['client','employee','admin','irs'];
begin
  foreach v_role in array roles loop
    select id into v_uid from profiles p
    where p.role::text = v_role and p.status = 'active' limit 1;

    if v_uid is null then
      v_res := v_res || E'\n[' || v_role || '] aucun profil actif — rôle non testé';
      continue;
    end if;

    -- On se place dans la peau de cet utilisateur pour la durée du test :
    -- auth.uid() renverra son identifiant, et les fonctions SECURITY DEFINER
    -- se comporteront exactement comme depuis son navigateur.
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_uid::text, 'role', 'authenticated')::text, true);

    foreach f in array fonctions loop
      v_appels := v_appels + 1;
      begin
        execute format('select count(*) from %I()', f) into n;
      exception when others then
        v_msg := sqlerrm;
        if v_msg ilike '%Réservé%' or v_msg ilike '%Accès refusé%'
           or v_msg ilike '%Fonctionnalité indisponible%' or v_msg ilike '%Non authentifié%' then
          null; -- refus volontaire : c'est le comportement correct
        else
          v_res := v_res || E'\n[' || v_role || '] ' || f || ' -> ' || left(v_msg, 120);
        end if;
      end;
    end loop;
  end loop;

  if v_res = '' then
    v_res := ' AUCUNE ANOMALIE — ' || v_appels || ' appels';
  end if;

  -- L'exception annule tout ce qui précède : le test ne laisse aucune trace.
  raise exception 'RESULTAT:%', v_res;
end
$do$;

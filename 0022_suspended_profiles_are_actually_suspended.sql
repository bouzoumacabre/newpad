-- ============================================================================
-- NEWPAD — Migration 0022 : un profil suspendu doit l'être réellement
-- ============================================================================
-- Audit étape 2 (connexion & session), suite.
-- ============================================================================
--
-- LE PROBLÈME
--
-- `/admin/clients` et `/admin/staff` permettent de passer un profil en
-- `suspended` ou `frozen`, et `admin_set_profile_status` enregistre bien la
-- valeur. Mais absolument rien ne s'appuyait dessus :
--
--   - le garde de routage côté application ne teste que `profile.role`,
--     jamais `profile.status` : un suspendu se connecte et navigue partout ;
--   - aucune des cinq fonctions de dépôt de demande — submit_transfer,
--     submit_loan_request, submit_gold_bank_purchase, submit_market_purchase,
--     submit_safe_request — ne vérifie le statut du demandeur.
--
-- Suspendre un client soupçonné de fraude était donc un geste purement
-- décoratif : il continuait à virer de l'argent, demander des prêts et
-- acheter de l'or. Seules quelques fonctions de DÉCISION (côté personnel)
-- testaient le statut, c'est-à-dire bien trop tard — la file du personnel
-- était déjà remplie de demandes d'un compte censé être bloqué.
-- Un employé révoqué gardait de la même façon tous ses accès.
--
--
-- LA CORRECTION
--
-- Plutôt que d'ajouter le test dans les cinq fonctions concernées — en
-- oubliant forcément les chemins d'écriture ajoutés plus tard — la règle est
-- posée par un déclencheur sur les tables de demandes elles-mêmes. Toute
-- insertion, quel qu'en soit le chemin (fonction SECURITY DEFINER, écriture
-- directe, ou code futur), est vérifiée.
--
-- Volontairement NON couvertes : le support et la messagerie. Une personne
-- suspendue doit conserver un moyen de joindre la banque — c'est justement
-- le moment où elle en a besoin.

create or replace function _reject_if_profile_inactive()
returns trigger
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_status text;
begin
  -- Pas d'appelant identifié : tâche planifiée, Edge Function en service_role,
  -- ou migration. Ces chemins n'ont pas de profil à vérifier.
  if auth.uid() is null then
    return new;
  end if;

  select status into v_status from profiles where id = auth.uid();

  -- Profil introuvable : on laisse passer plutôt que de bloquer un cas non
  -- prévu ; les fonctions appelées font déjà leurs propres vérifications.
  if v_status is null or v_status = 'active' then
    return new;
  end if;

  if v_status = 'suspended' then
    raise exception 'Votre compte est suspendu : aucune nouvelle opération n''est possible. Contactez la banque par la messagerie ou le support.';
  elsif v_status = 'frozen' then
    raise exception 'Votre compte est gelé : aucune nouvelle opération n''est possible. Contactez la banque par la messagerie ou le support.';
  else
    raise exception 'Votre compte n''est pas actif : aucune nouvelle opération n''est possible.';
  end if;
end;
$function$;

comment on function _reject_if_profile_inactive() is
  'Refuse toute demande émise par un profil suspendu ou gelé. Posé en déclencheur sur les tables de demandes pour couvrir tous les chemins d''écriture, présents et futurs. Support et messagerie volontairement exclus.';

do $$
declare
  t text;
  tables text[] := array[
    'transfers',
    'loans',
    'gold_bank_purchase_requests',
    'gold_market_purchase_requests',
    'gold_market_listings',
    'safe_rental_requests',
    'consulting_requests',
    'membership_requests'
  ];
begin
  foreach t in array tables loop
    execute format('drop trigger if exists trg_reject_inactive_profile on %I', t);
    execute format(
      'create trigger trg_reject_inactive_profile before insert on %I
       for each row execute function _reject_if_profile_inactive()', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Permissions d'exécution (voir 0015). `record_login_attempt` doit conserver
-- son accès anon (exception documentée en 0021) : le revoke global le lui
-- retirerait de nouveau, on le réaccorde donc juste après.
-- ----------------------------------------------------------------------------
revoke execute on all functions in schema public from public;
revoke execute on all functions in schema public from anon;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema public to service_role;

grant execute on function record_login_attempt(text, boolean) to anon;
revoke execute on function revoke_user_sessions(uuid) from authenticated;

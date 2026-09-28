-- ############################################################################
-- 0057 — CRÉER VOTRE APP : un guichet, pas une application de plus
-- ############################################################################
-- « Demander une application pour votre entreprise », c'est exactement ce que
-- fait le socle des démarches (0054) : un formulaire, un dossier, une
-- conversation, une décision. Aucune table, aucune fonction nouvelle : on
-- déclare `create-app` comme guichet, tenu par l'administration Newpad.
--
-- Données seulement. Les nouveaux administrateurs Newpad ne deviennent pas
-- membres automatiquement : les ajouter depuis NewPro (organisation `newpad`).
-- ############################################################################

-- L'organisation qui instruit les demandes. Membres : les administrateurs
-- Newpad actifs au moment de la migration, en direction (ils composent la
-- démarche et décident des dossiers).
insert into organizations (slug, name, kind, description, owner_id, status)
select 'newpad', 'Newpad', 'other',
       'Administration de la tablette : instruction des demandes d''application.',
       (select id from profiles
         where status = 'active' and (newpad_role = 'admin' or role = 'admin')
         order by created_at limit 1),
       'active'
on conflict (slug) do nothing;

insert into organization_members (organization_id, profile_id, member_role, grade_label)
select o.id, p.id, 'owner', 'Administration Newpad'
from organizations o
join profiles p on p.status = 'active' and (p.newpad_role = 'admin' or p.role = 'admin')
where o.slug = 'newpad'
on conflict (organization_id, profile_id) do nothing;

update app_registry set is_service = true, status = 'live' where slug = 'create-app';

-- La démarche elle-même. Modifiable ensuite depuis l'onglet « Instruction »
-- de l'application, comme n'importe quelle démarche de guichet.
insert into service_procedures (app_slug, organization_id, title, description, fields, requires_files, sort_order)
select 'create-app', o.id, 'Demander une application',
       'Décrivez l''application que vous voulez pour votre entreprise. L''administration Newpad étudie la demande et vous répond dans ce dossier. Une application peut devenir une vitrine (catalogue et rendez-vous), un guichet (démarches et dossiers) ou une application sur mesure.',
       '[
         {"key":"entreprise","label":"Entreprise","type":"text","required":true},
         {"key":"nom_app","label":"Nom souhaité pour l''application","type":"text","required":true},
         {"key":"type","label":"Type d''application","type":"select","required":true,
          "options":["Vitrine (catalogue et rendez-vous)","Guichet (démarches et dossiers)","Sur mesure","Je ne sais pas"]},
         {"key":"usage","label":"À quoi servira-t-elle ?","type":"textarea","required":true},
         {"key":"fonctions","label":"Fonctionnalités souhaitées","type":"textarea","required":false},
         {"key":"contact","label":"Contact (Discord ou téléphone)","type":"text","required":false}
       ]'::jsonb,
       false, 10
from organizations o
where o.slug = 'newpad'
  and not exists (select 1 from service_procedures sp
                   where sp.app_slug = 'create-app' and sp.title = 'Demander une application');

-- ############################################################################
-- 0061 — NEW AI en ligne, en version guide gratuite
-- ############################################################################
-- L'écran NEW AI n'appelle plus aucun modèle : il oriente vers les
-- applications par mots-clés (src/apps/ai/guide.js). Plus de coût, plus de
-- clé : l'application peut passer en ligne. Le quota (0060) et l'Edge
-- Function `new-ai` restent en place, inutilisés, pour une version
-- générative future.
-- ############################################################################

update app_registry
   set status = 'live', description = 'Le guide de la tablette'
 where slug = 'ai';

-- ============================================================================
-- NEWPAD — Migration 0029 : portée de lecture du parc de coffres
-- ============================================================================
-- La politique de lecture sur `safe_deposit_boxes` était `auth.uid() is not
-- null` : n'importe quel client connecté pouvait lire la table entière,
-- `client_id` compris, et savoir donc QUI loue un coffre — une information que
-- l'interface ne montre nulle part, et qui n'a aucune raison de sortir de la
-- banque.
--
-- Nouvelle portée : les coffres libres (nécessaires pour la demande), le sien,
-- et l'intégralité du parc pour le personnel.
-- ============================================================================

drop policy if exists safe_boxes_select on safe_deposit_boxes;

create policy safe_boxes_select on safe_deposit_boxes
for select using (
  status = 'available'
  or client_id = auth.uid()
  or is_staff()
);

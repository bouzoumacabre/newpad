// ============================================================================
// NEWPAD — Notifications (partagées par les 4 interfaces internes)
// ============================================================================

import { supabase } from './supabaseClient.js';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

export async function getMyNotifications(limit = 50) {
  return unwrap(await supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(limit));
}

export async function markNotificationsRead(ids) {
  const { error } = await supabase.rpc('mark_notifications_read', { p_ids: ids });
  if (error) throw error;
}

export async function markAllNotificationsRead() {
  const { error } = await supabase.rpc('mark_all_notifications_read');
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// Abonnement temps réel — un seul canal, des écouteurs nommés
// ----------------------------------------------------------------------------
// `renderShell()` est appelée à CHAQUE navigation, et elle s'abonnait sans
// jamais se désabonner : la valeur de retour (la fonction de désabonnement)
// était ignorée. Après trente changements d'écran, trente canaux Realtime
// coexistaient sur la même connexion, trente écouteurs se déclenchaient pour
// une seule notification, et le panneau se rechargeait trente fois. Le
// symptôme s'aggrave à mesure qu'on utilise l'interface — donc précisément
// quand on la sollicite le plus.
//
// Première correction tentée : la coquille se désabonnait avant de se
// réabonner. Un test l'a écartée — le désabonnement vidant l'ensemble des
// écouteurs, le canal était FERMÉ puis rouvert à chaque navigation. Pas de
// fuite, mais une reconstruction de l'abonnement WebSocket à chaque écran, et
// une fenêtre pendant laquelle une notification se perd.
//
// D'où les écouteurs NOMMÉS : la coquille se réenregistre sous la même clé à
// chaque rendu et remplace simplement son écouteur précédent. Le canal, lui,
// reste ouvert du début à la fin de la session.

let canal = null;
let canalUserId = null;
const ecouteurs = new Map(); // clé -> fonction

function diffuser(payload) {
  for (const fn of ecouteurs.values()) {
    // Un écouteur défaillant ne doit pas priver les autres de l'événement.
    try { fn(payload); } catch (err) { console.error('[newpad] écouteur de notification en erreur :', err); }
  }
}

/**
 * @param {string} userId
 * @param {Function} onInsert
 * @param {string} [cle] identité logique de l'abonné. Se réabonner sous la même
 *   clé REMPLACE l'écouteur précédent au lieu de s'y ajouter — c'est ce qui
 *   permet à la coquille de se réenregistrer à chaque navigation sans que rien
 *   ne s'accumule ni ne soit reconstruit.
 */
export function subscribeToMyNotifications(userId, onInsert, cle) {
  if (canal && canalUserId !== userId) {
    supabase.removeChannel(canal);
    canal = null;
    canalUserId = null;
    ecouteurs.clear();
  }

  const id = cle || Symbol('abonne');
  ecouteurs.set(id, onInsert);

  if (!canal) {
    canalUserId = userId;
    canal = supabase
      .channel(`notifications-${userId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` },
        diffuser
      )
      .subscribe();
  }

  return () => {
    ecouteurs.delete(id);
    if (ecouteurs.size === 0 && canal) {
      supabase.removeChannel(canal);
      canal = null;
      canalUserId = null;
    }
  };
}

// Appelée à la déconnexion : sans cela le canal survivrait à la session.
export function resetNotificationsSubscription() {
  if (canal) supabase.removeChannel(canal);
  canal = null;
  canalUserId = null;
  ecouteurs.clear();
}

// Diagnostic, utilisé par la vérification de l'étape 17.
export function activeNotificationListeners() {
  return ecouteurs.size;
}

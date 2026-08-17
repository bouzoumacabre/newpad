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

export function subscribeToMyNotifications(userId, onInsert) {
  const channel = supabase
    .channel(`notifications-${userId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` }, onInsert)
    .subscribe();
  return () => supabase.removeChannel(channel);
}

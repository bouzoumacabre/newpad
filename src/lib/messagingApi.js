// ============================================================================
// NEWPAD — Messagerie inter-rôles (tickets 1:1 entre Client/Employé/Admin/IRS)
// Les clients ne peuvent pas se contacter entre eux — appliqué côté serveur
// dans create_message_thread(), voir migration 0010.
// ============================================================================

import { supabase } from './supabaseClient.js';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

export async function listMessageableContacts(search) {
  return unwrap(await supabase.rpc('list_messageable_contacts', { p_search: search || null }));
}

export async function listMyThreads() {
  return unwrap(await supabase.rpc('list_my_message_threads'));
}

export async function getThreadMessages(threadId) {
  return unwrap(await supabase.from('thread_messages').select('*').eq('thread_id', threadId).order('created_at', { ascending: true }));
}

export async function createMessageThread(recipientId, subject, body) {
  return unwrap(await supabase.rpc('create_message_thread', { p_recipient_id: recipientId, p_subject: subject, p_body: body }));
}

export async function sendThreadMessage(threadId, body) {
  return unwrap(await supabase.rpc('send_thread_message', { p_thread_id: threadId, p_body: body }));
}

export async function markThreadRead(threadId) {
  const { error } = await supabase.rpc('mark_thread_read', { p_thread_id: threadId });
  if (error) throw error;
}

export async function closeMessageThread(threadId) {
  const { error } = await supabase.rpc('close_message_thread', { p_thread_id: threadId });
  if (error) throw error;
}

// Réouverture (migration 0030). Sans elle, une conversation clôturée par erreur
// était définitivement close : plus aucun message ne pouvait y être écrit, par
// aucun des deux participants ni par l'admin.
export async function reopenMessageThread(threadId) {
  const { error } = await supabase.rpc('reopen_message_thread', { p_thread_id: threadId });
  if (error) throw error;
}

export function subscribeToThreadMessages(threadId, onInsert) {
  const channel = supabase
    .channel(`thread-messages-${threadId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'thread_messages', filter: `thread_id=eq.${threadId}` }, onInsert)
    .subscribe();
  return () => supabase.removeChannel(channel);
}

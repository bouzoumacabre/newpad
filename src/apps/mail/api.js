// ============================================================================
// NewMail — accès à la messagerie interne
// ============================================================================
import { supabase } from '../../lib/supabaseClient.js';

export const DOSSIERS = [
  ['inbox', 'Réception'],
  ['sent', 'Envoyés'],
  ['drafts', 'Brouillons'],
  ['archive', 'Archives'],
  ['trash', 'Corbeille'],
];

// Les noms d'expéditeur et de destinataires sont assemblés côté serveur : un
// joueur n'a pas le droit de parcourir les profils des autres, et élargir cette
// lecture pour afficher trois noms ouvrirait un annuaire de toute la ville.
export async function listMail(folder = 'inbox') {
  const { data, error } = await supabase.rpc('mail_list', { p_folder: folder });
  if (error) throw error;
  return data || [];
}

export async function getMail(id) {
  const { data, error } = await supabase.rpc('mail_get', { p_id: id });
  if (error) throw error;
  return data;
}

export async function sendMail({ to, subject, body, fileIds = null }) {
  const { data, error } = await supabase.rpc('mail_send', {
    p_to: to,
    p_subject: subject,
    p_body: body,
    p_file_ids: fileIds && fileIds.length ? fileIds : null,
  });
  if (error) throw error;
  return data;
}

export async function setFolder(id, folder) {
  const { error } = await supabase.rpc('mail_set_folder', { p_message_id: id, p_folder: folder });
  if (error) throw error;
}

export async function markRead(id, read = true) {
  const { error } = await supabase.rpc('mail_mark_read', { p_message_id: id, p_read: read });
  if (error) throw error;
}

export async function unreadCount() {
  const { data, error } = await supabase.rpc('mail_unread_count');
  if (error) return 0;
  return data || 0;
}

// ----------------------------------------------------------------------------
// Brouillons — seule table de l'application écrite directement : un brouillon
// n'engage rien, n'est visible de personne, et passer par une fonction à chaque
// frappe n'apporterait aucune garantie.
// ----------------------------------------------------------------------------
export async function listDrafts() {
  const { data, error } = await supabase
    .from('mail_drafts')
    .select('id, to_profile_id, subject, body, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function saveDraft({ id = null, toProfileId = null, subject = '', body = '' }) {
  const { data: session } = await supabase.auth.getSession();
  const uid = session?.session?.user?.id;
  if (!uid) throw new Error('Session expirée');
  const ligne = {
    owner_id: uid, to_profile_id: toProfileId, subject, body, updated_at: new Date().toISOString(),
  };
  if (id) ligne.id = id;
  const { data, error } = await supabase.from('mail_drafts').upsert(ligne).select('id').single();
  if (error) throw error;
  return data.id;
}

export async function deleteDraft(id) {
  const { error } = await supabase.from('mail_drafts').delete().eq('id', id);
  if (error) throw error;
}

// ============================================================================
// NewFiles — accès au coffre documentaire
// ============================================================================
import { supabase } from '../../lib/supabaseClient.js';

const BUCKET = 'newpad-files';
export const TAILLE_MAX = 25 * 1024 * 1024;

export const CATEGORIES = [
  ['identity', 'Identité'],
  ['bank', 'Banque'],
  ['work', 'Emploi'],
  ['legal', 'Juridique'],
  ['medical', 'Médical'],
  ['vehicle', 'Véhicule'],
  ['property', 'Immobilier'],
  ['insurance', 'Assurance'],
  ['music', 'Musique'],
  ['business', 'Entreprise'],
  ['other', 'Autre'],
];

export function categorieLabel(cle) {
  const t = CATEGORIES.find((c) => c[0] === cle);
  return t ? t[1] : 'Autre';
}

async function monId() {
  const { data } = await supabase.auth.getSession();
  return data?.session?.user?.id || null;
}

// Tout ce que je peux voir : mes documents ET ceux qu'on m'a partagés. La
// distinction se fait sur `owner_id`, pas par deux requêtes — les policies
// renvoient déjà exactement l'ensemble autorisé.
export async function listFiles() {
  const { data, error } = await supabase
    .from('files')
    .select('id, owner_id, organization_id, name, category, mime_type, size_bytes, storage_path, description, source_app, is_official, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function listPermissions(fileId) {
  const { data, error } = await supabase
    .from('file_permissions')
    .select('id, file_id, grantee_type, grantee_id, permission, note, expires_at, created_at')
    .eq('file_id', fileId);
  if (error) throw error;
  return data || [];
}

export async function uploadFile(file, { category = 'other', description = null, organizationId = null, sourceApp = 'files' } = {}) {
  if (!file) throw new Error('Aucun fichier sélectionné');
  if (file.size > TAILLE_MAX) throw new Error('Fichier trop lourd (25 Mo maximum).');

  const uid = await monId();
  if (!uid) throw new Error('Session expirée');

  // Le chemin commence par l'identifiant du propriétaire : c'est ce que
  // vérifient à la fois la policy du bucket et la fonction d'enregistrement.
  // Le nom d'origine n'est pas réutilisé tel quel — deux dépôts du même
  // « contrat.pdf » s'écraseraient, et un nom de fichier hostile n'a pas à
  // devenir un chemin de stockage.
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  const chemin = `${uid}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error: errUp } = await supabase.storage.from(BUCKET).upload(chemin, file, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (errUp) throw errUp;

  const { data, error } = await supabase.rpc('newfiles_register', {
    p_name: file.name,
    p_storage_path: chemin,
    p_category: category,
    p_mime_type: file.type || null,
    p_size_bytes: file.size,
    p_description: description,
    p_organization_id: organizationId,
    p_source_app: sourceApp,
  });
  if (error) {
    // L'objet est déjà dans le stockage : sans ce nettoyage il resterait
    // orphelin, invisible dans l'application mais bien facturé.
    await supabase.storage.from(BUCKET).remove([chemin]).catch(() => {});
    throw error;
  }
  return data;
}

// Le bucket est privé : on ne peut pas construire une URL publique. Une URL
// signée, valable quelques minutes, n'est délivrée qu'à qui la policy autorise.
export async function fileUrl(storagePath, secondes = 300) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(storagePath, secondes);
  if (error) throw error;
  return data.signedUrl;
}

export async function updateFile(id, { name, category, description }) {
  const { error } = await supabase.rpc('newfiles_update', {
    p_id: id, p_name: name, p_category: category || null, p_description: description || null,
  });
  if (error) throw error;
}

export async function deleteFile(id) {
  const { data, error } = await supabase.rpc('newfiles_delete', { p_id: id });
  if (error) throw error;
  // La fonction renvoie le chemin : l'objet lui-même se supprime côté client,
  // la base n'ayant aucun moyen d'écrire dans le stockage.
  if (data) await supabase.storage.from(BUCKET).remove([data]).catch(() => {});
}

export async function shareFile(fileId, { granteeType = 'profile', granteeId, permission = 'view', expiresAt = null, note = null }) {
  const { error } = await supabase.rpc('newfiles_share', {
    p_file_id: fileId,
    p_grantee_type: granteeType,
    p_grantee_id: granteeId,
    p_permission: permission,
    p_expires_at: expiresAt,
    p_note: note,
  });
  if (error) throw error;
}

export async function revokeShare(fileId, granteeType, granteeId) {
  const { error } = await supabase.rpc('newfiles_revoke', {
    p_file_id: fileId, p_grantee_type: granteeType, p_grantee_id: granteeId,
  });
  if (error) throw error;
}

export async function searchRecipients(query) {
  const { data, error } = await supabase.rpc('newfiles_search_recipients', { p_query: query });
  if (error) throw error;
  return data || [];
}

export function formatTaille(octets) {
  if (octets == null) return '';
  if (octets < 1024) return octets + ' o';
  if (octets < 1024 * 1024) return Math.round(octets / 1024) + ' Ko';
  return (octets / (1024 * 1024)).toFixed(1).replace('.', ',') + ' Mo';
}

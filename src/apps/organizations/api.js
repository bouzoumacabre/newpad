// ============================================================================
// Organisations — accès partagé par NewPage, NewPro et l'administration
// ============================================================================
// Une seule couche d'accès pour les trois : l'annuaire public, le back-office
// et l'administration parlent à la même table. Trois fichiers séparés auraient
// fini par valider les mêmes champs de trois façons différentes.

import { supabase } from '../../lib/supabaseClient.js';

export const GENRES = [
  ['company', 'Entreprise'],
  ['government', 'Gouvernement'],
  ['media', 'Média'],
  ['label', 'Label musical'],
  ['dealership', 'Concession'],
  ['jewelry', 'Joaillerie'],
  ['insurance', 'Assurance'],
  ['hospital', 'Établissement de santé'],
  ['realestate', 'Immobilier'],
  ['association', 'Association'],
  ['other', 'Autre'],
];

export const ICONE_PAR_GENRE = {
  company: 'briefcase', government: 'government', media: 'news', label: 'music',
  dealership: 'car', jewelry: 'gem', insurance: 'shield', hospital: 'medical',
  realestate: 'home', association: 'social', other: 'directory',
};

export function genreLabel(cle) {
  const t = GENRES.find((g) => g[0] === cle);
  return t ? t[1] : 'Autre';
}

const CHAMPS = 'id, slug, name, kind, description, logo_url, banner_url, owner_id, ' +
  'contact_email, contact_phone, location, opening_hours, discord_url, status, is_published';

// Annuaire public — lisible sans compte : on cherche une adresse avant d'être
// client de quoi que ce soit.
export async function listPublicOrganizations() {
  const { data, error } = await supabase
    .from('organizations').select(CHAMPS).order('name');
  if (error) throw error;
  return data || [];
}

export async function getOrganization(id) {
  const { data, error } = await supabase
    .from('organizations').select(CHAMPS).eq('id', id).single();
  if (error) throw error;
  return data;
}

// Mes organisations, avec mon rôle. Une jointure côté client buterait sur la
// policy pour une entreprise non publiée dont on est pourtant membre.
export async function myOrganizations() {
  const { data, error } = await supabase.rpc('neworg_mine');
  if (error) throw error;
  return data || [];
}

export async function listMembers(orgId) {
  const { data, error } = await supabase.rpc('neworg_members', { p_organization_id: orgId });
  if (error) throw error;
  return data || [];
}

export async function setMember(orgId, profileId, memberRole, gradeLabel) {
  const { error } = await supabase.rpc('newpad_set_org_member', {
    p_organization_id: orgId, p_profile_id: profileId,
    p_member_role: memberRole, p_grade_label: gradeLabel || null,
  });
  if (error) throw error;
}

export async function removeMember(orgId, profileId) {
  const { error } = await supabase.rpc('newpad_remove_org_member', {
    p_organization_id: orgId, p_profile_id: profileId,
  });
  if (error) throw error;
}

export async function upsertOrganization(org) {
  const { data, error } = await supabase.rpc('newpad_upsert_organization', {
    p_id: org.id || null,
    p_name: org.name,
    p_slug: org.slug,
    p_kind: org.kind || 'company',
    p_description: org.description || null,
    p_logo_url: org.logo_url || null,
    p_owner_id: org.owner_id || null,
    p_contact_email: org.contact_email || null,
    p_contact_phone: org.contact_phone || null,
    p_location: org.location || null,
    p_status: org.status || 'active',
  });
  if (error) throw error;
  return data;
}

// La fiche d'annuaire passe par une fonction, comme le reste. Une policy
// d'UPDATE porte sur la LIGNE, pas sur les colonnes : autoriser un responsable
// à corriger ses horaires l'autoriserait du même geste à changer le statut, le
// propriétaire ou le nom de son entreprise.
export async function updateOrgProfile(orgId, champs) {
  const { error } = await supabase.rpc('neworg_update_profile', {
    p_organization_id: orgId,
    p_description: champs.description ?? null,
    p_contact_email: champs.contact_email ?? null,
    p_contact_phone: champs.contact_phone ?? null,
    p_location: champs.location ?? null,
    p_opening_hours: champs.opening_hours ?? null,
    p_discord_url: champs.discord_url ?? null,
    p_logo_url: champs.logo_url ?? null,
    p_is_published: champs.is_published ?? null,
  });
  if (error) throw error;
}

export async function listAnnouncements(orgId) {
  const { data, error } = await supabase
    .from('organization_announcements')
    .select('id, title, body, author_id, created_at')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data || [];
}

export async function postAnnouncement(orgId, title, body) {
  const { data, error } = await supabase.rpc('neworg_post_announcement', {
    p_organization_id: orgId, p_title: title, p_body: body,
  });
  if (error) throw error;
  return data;
}

export async function deleteAnnouncement(id) {
  const { error } = await supabase.rpc('neworg_delete_announcement', { p_id: id });
  if (error) throw error;
}

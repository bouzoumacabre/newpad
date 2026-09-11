// ============================================================================
// NewWork — accès à l'emploi
// ============================================================================
import { supabase } from '../../lib/supabaseClient.js';

export const CONTRATS = [
  ['cdi', 'Poste permanent'],
  ['cdd', 'Durée déterminée'],
  ['mission', 'Mission'],
  ['stage', 'Apprentissage'],
  ['benevolat', 'Bénévolat'],
];

export const STATUTS = {
  received: ['Reçue', 'badge-neutral'],
  viewed: ['Consultée', 'badge-neutral'],
  interview: ['Entretien', 'badge-pending'],
  accepted: ['Acceptée', 'badge-success'],
  rejected: ['Refusée', 'badge-danger'],
};

export function contratLabel(c) {
  const t = CONTRATS.find((x) => x[0] === c);
  return t ? t[1] : c;
}

export async function listOffers(query = null) {
  const { data, error } = await supabase.rpc('newwork_list_offers', { p_query: query });
  if (error) throw error;
  return data || [];
}

export async function publishOffer(o) {
  const { data, error } = await supabase.rpc('newwork_publish_offer', {
    p_organization_id: o.organizationId,
    p_title: o.title,
    p_description: o.description,
    p_contract_type: o.contractType || 'cdi',
    p_compensation: o.compensation || null,
    p_location: o.location || null,
    p_id: o.id || null,
  });
  if (error) throw error;
  return data;
}

export async function closeOffer(id, open = false) {
  const { error } = await supabase.rpc('newwork_close_offer', { p_id: id, p_open: open });
  if (error) throw error;
}

export async function apply(offerId, message, fileIds) {
  const { data, error } = await supabase.rpc('newwork_apply', {
    p_offer_id: offerId,
    p_message: message || null,
    p_file_ids: fileIds && fileIds.length ? fileIds : null,
  });
  if (error) throw error;
  return data;
}

export async function myApplications() {
  const { data, error } = await supabase.rpc('newwork_my_applications');
  if (error) throw error;
  return data || [];
}

export async function offerApplications(offerId) {
  const { data, error } = await supabase.rpc('newwork_offer_applications', { p_offer_id: offerId });
  if (error) throw error;
  return data || [];
}

export async function applicantFiles(applicationId) {
  const { data, error } = await supabase.rpc('newwork_applicant_files', { p_application_id: applicationId });
  if (error) throw error;
  return data || [];
}

export async function decide(applicationId, status, note = null) {
  const { error } = await supabase.rpc('newwork_decide', {
    p_application_id: applicationId, p_status: status, p_note: note,
  });
  if (error) throw error;
}

// Les offres d'une entreprise, ouvertes ET fermées : la policy laisse ses
// membres voir son historique.
export async function orgOffers(orgId) {
  const { data, error } = await supabase
    .from('job_offers')
    .select('id, title, description, contract_type, compensation, location, is_open, created_at')
    .eq('organization_id', orgId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function myWorkProfile(profileId) {
  const { data, error } = await supabase
    .from('work_profiles')
    .select('profile_id, headline, about, skills, open_to_work')
    .eq('profile_id', profileId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function saveWorkProfile(profileId, p) {
  const { error } = await supabase.from('work_profiles').upsert({
    profile_id: profileId,
    headline: p.headline || null,
    about: p.about || null,
    skills: p.skills || [],
    open_to_work: p.openToWork !== false,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

// ============================================================================
// NEWPAD — Wrapper API pour l'interface Admin
// ============================================================================
// Réutilise largement employeeApi.js (les lectures/actions du personnel sont
// identiques pour l'admin, qui est staff). Ce fichier n'ajoute que les
// fonctions strictement réservées à l'admin : décisions finales (prêts),
// registre des lingots, corrections de caisse, statuts comptes/profils,
// rôles & titres, registre de fonctionnalités, permissions par compte,
// pilotage économique, exceptions client, masquage, comptes IRS, CMS.
// ============================================================================

import { supabase } from './supabaseClient.js';

async function requireUser() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Non authentifié');
  return user;
}

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

// Ré-export direct des fonctions employé réutilisables telles quelles (lecture
// staff + actions non réservées à l'admin) — voir employeeApi.js pour le détail.
export * from './employeeApi.js';

// ----------------------------------------------------------------------------
// PRÊTS — décision finale (admin uniquement)
// ----------------------------------------------------------------------------

export async function decideLoanFinal(loanId, approve, note) {
  const { error } = await supabase.rpc('admin_decide_loan', { p_loan_id: loanId, p_approve: approve, p_note: note || null });
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// LINGOTS D'OR — registre complet & frappe
// ----------------------------------------------------------------------------

export async function getAllGoldBars() {
  return unwrap(
    await supabase
      .from('gold_bars')
      .select('*, profiles(display_name, username)')
      .order('minted_at', { ascending: false })
  );
}

export async function mintGoldBar({ serial, weightGrams, notes }) {
  return unwrap(
    await supabase.rpc('mint_gold_bar', { p_serial: serial, p_weight_grams: weightGrams, p_notes: notes || null })
  );
}

export async function adminUpdateGoldBar(id, { status, location, ownerClientId, notes } = {}) {
  const { error } = await supabase.rpc('admin_update_gold_bar', {
    p_gold_bar_id: id,
    p_status: status || null,
    p_location: location || null,
    p_owner_client_id: ownerClientId || null,
    p_notes: notes || null,
  });
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// CAISSE — correction manuelle
// ----------------------------------------------------------------------------

export async function adjustCashierReport(reportId, amount, note) {
  const { error } = await supabase.rpc('admin_adjust_cashier_report', { p_report_id: reportId, p_amount: amount, p_note: note || null });
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// COMPTES & PROFILS — statuts, rôles, exceptions
// ----------------------------------------------------------------------------

export async function adminSetAccountStatus(accountId, status) {
  const { error } = await supabase.rpc('admin_set_account_status', { p_account_id: accountId, p_status: status });
  if (error) throw error;
}

export async function adminSetProfileStatus(profileId, status) {
  const { error } = await supabase.rpc('admin_set_profile_status', { p_profile_id: profileId, p_status: status });
  if (error) throw error;
}

export async function updateProfileRole(profileId, { role, employeeTitle } = {}) {
  const patch = {};
  if (role !== undefined) patch.role = role;
  if (employeeTitle !== undefined) patch.employee_title = employeeTitle || null;
  const { error } = await supabase.from('profiles').update(patch).eq('id', profileId);
  if (error) throw error;
}

export async function updateProfileOverrides(profileId, { minBalanceOverride, minTransferOverride, trustScore } = {}) {
  const patch = {};
  if (minBalanceOverride !== undefined) patch.min_balance_override = minBalanceOverride;
  if (minTransferOverride !== undefined) patch.min_transfer_override = minTransferOverride;
  if (trustScore !== undefined) patch.trust_score = trustScore;
  const { error } = await supabase.from('profiles').update(patch).eq('id', profileId);
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// REGISTRE DE FONCTIONNALITÉS
// ----------------------------------------------------------------------------

export async function getFeatureRegistry() {
  return unwrap(await supabase.from('feature_registry').select('*').order('area', { ascending: true }).order('category', { ascending: true }).order('key', { ascending: true }));
}

export async function upsertFeatureFlag({ key, label, description, area, category, defaultRoles, enabled, isCore }) {
  const user = await requireUser();
  const row = {
    key,
    label,
    description: description || null,
    area,
    category: category || null,
    default_roles: defaultRoles || [],
    enabled: enabled !== undefined ? enabled : true,
    updated_by: user.id,
  };
  if (isCore !== undefined) row.is_core = isCore;
  return unwrap(await supabase.from('feature_registry').upsert(row).select().single());
}

export async function setFeatureEnabled(key, enabled) {
  const user = await requireUser();
  const { error } = await supabase.from('feature_registry').update({ enabled, updated_by: user.id }).eq('key', key);
  if (error) throw error;
}

export async function deleteFeatureFlag(key) {
  const { error } = await supabase.from('feature_registry').delete().eq('key', key);
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// PERMISSIONS PAR COMPTE (exceptions individuelles)
// ----------------------------------------------------------------------------

export async function getPermissionGrants(accountId) {
  return unwrap(await supabase.from('permission_grants').select('*, feature_registry(label, area)').eq('account_id', accountId).order('granted_at', { ascending: false }));
}

export async function upsertPermissionGrant({ id, accountId, featureKey, granted, note }) {
  const user = await requireUser();
  const row = { account_id: accountId, feature_key: featureKey, granted, note: note || null, granted_by: user.id };
  if (id) row.id = id;
  return unwrap(await supabase.from('permission_grants').upsert(row, { onConflict: 'account_id,feature_key' }).select().single());
}

export async function deletePermissionGrant(id) {
  const { error } = await supabase.from('permission_grants').delete().eq('id', id);
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// PILOTAGE ÉCONOMIQUE
// ----------------------------------------------------------------------------

export async function getEconomicSettings() {
  return unwrap(await supabase.from('economic_settings').select('*').order('category', { ascending: true }).order('key', { ascending: true }));
}

export async function upsertEconomicSetting({ key, label, value, valueType, category }) {
  const user = await requireUser();
  const row = { key, value, updated_by: user.id };
  if (label !== undefined) row.label = label;
  if (valueType !== undefined) row.value_type = valueType;
  if (category !== undefined) row.category = category;
  return unwrap(await supabase.from('economic_settings').upsert(row).select().single());
}

// ----------------------------------------------------------------------------
// EXCEPTIONS PAR CLIENT
// ----------------------------------------------------------------------------

export async function getClientOverrides(clientId) {
  return unwrap(await supabase.from('client_setting_overrides').select('*, economic_settings(label, value_type)').eq('client_id', clientId).order('updated_at', { ascending: false }));
}

export async function upsertClientOverride({ id, clientId, settingKey, value, note }) {
  const user = await requireUser();
  const row = { client_id: clientId, setting_key: settingKey, value, note: note || null, updated_by: user.id };
  if (id) row.id = id;
  return unwrap(await supabase.from('client_setting_overrides').upsert(row, { onConflict: 'client_id,setting_key' }).select().single());
}

export async function deleteClientOverride(id) {
  const { error } = await supabase.from('client_setting_overrides').delete().eq('id', id);
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// MASQUAGE PAR INTERFACE
// ----------------------------------------------------------------------------

export async function getVisibilityMasks() {
  return unwrap(await supabase.from('visibility_masks').select('*').order('created_at', { ascending: false }));
}

export async function setVisibilityMask({ type, id, hiddenFrom, reason }) {
  const { error } = await supabase.rpc('admin_set_visibility_mask', {
    p_type: type,
    p_id: id,
    p_hidden_from: hiddenFrom || [],
    p_reason: reason || null,
  });
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// COMPTES IRS
// ----------------------------------------------------------------------------

export async function getIrsAccounts() {
  return unwrap(await supabase.from('irs_accounts').select('*, profiles(display_name, username, role)').order('granted_at', { ascending: false }));
}

export async function grantIrsAccount(profileId) {
  const user = await requireUser();
  return unwrap(
    await supabase
      .from('irs_accounts')
      .upsert({ profile_id: profileId, granted_by: user.id, granted_at: new Date().toISOString(), revoked_at: null })
      .select()
      .single()
  );
}

export async function revokeIrsAccount(profileId) {
  const { error } = await supabase.from('irs_accounts').update({ revoked_at: new Date().toISOString() }).eq('profile_id', profileId);
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// CONTENU DU SITE (CMS)
// ----------------------------------------------------------------------------

export async function getSiteContent(area) {
  let q = supabase.from('site_content').select('*').order('area', { ascending: true }).order('sort_order', { ascending: true });
  if (area) q = q.eq('area', area);
  return unwrap(await q);
}

export async function upsertSiteContent({ id, area, sectionKey, content, sortOrder, isActive }) {
  const user = await requireUser();
  const row = { area, section_key: sectionKey, content, sort_order: sortOrder ?? 0, is_active: isActive !== undefined ? isActive : true, updated_by: user.id };
  if (id) row.id = id;
  return unwrap(await supabase.from('site_content').upsert(row).select().single());
}

export async function deleteSiteContent(id) {
  const { error } = await supabase.from('site_content').delete().eq('id', id);
  if (error) throw error;
}

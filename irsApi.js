// ============================================================================
// NEWPAD — Wrapper API pour l'interface IRS (Hurricane FA)
// ============================================================================
// Lecture STRICTEMENT SEULE. Le rôle IRS n'a AUCUNE policy RLS sur les
// tables de base (deny by default) — toute lecture passe exclusivement par
// les fonctions SECURITY DEFINER `irs_*` (0003_policies.sql), qui appliquent
// elles-mêmes le masquage par interface (`visibility_masks`) et ne
// contiennent aucune capacité d'écriture. Ce fichier n'expose donc que des
// appels RPC en lecture, plus le profil/mot de passe (identique aux autres
// rôles, via l'auth Supabase standard — ça ne touche à aucune donnée
// bancaire).

import { supabase } from './supabaseClient.js';

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

export async function getIrsStats() {
  return unwrap(await supabase.rpc('irs_stats'));
}

export async function listIrsClients(search, limit = 100) {
  return unwrap(await supabase.rpc('irs_list_clients', { p_search: search || null, p_limit: limit }));
}

export async function listIrsAccounts(search, limit = 100) {
  return unwrap(await supabase.rpc('irs_list_accounts', { p_search: search || null, p_limit: limit }));
}

export async function listIrsTransactions(search, limit = 200) {
  return unwrap(await supabase.rpc('irs_list_transactions', { p_search: search || null, p_limit: limit }));
}

export async function listIrsGoldBars(limit = 200) {
  return unwrap(await supabase.rpc('irs_list_gold_bars', { p_limit: limit }));
}

// ----------------------------------------------------------------------------
// PARAMÈTRES DU COMPTE (profil + mot de passe — identique aux autres rôles)
// ----------------------------------------------------------------------------

export async function updateDisplayName(displayName) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Non authentifié');
  const { error } = await supabase.from('profiles').update({ display_name: displayName }).eq('id', user.id);
  if (error) throw error;
}

export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

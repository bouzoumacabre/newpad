// ============================================================================
// NEWPAD — Wrapper API pour l'interface Client
// ============================================================================
// Toute écriture qui touche à l'argent passe exclusivement par les fonctions
// SECURITY DEFINER de la base (supabase.rpc(...)) — jamais par un insert/update
// direct sur accounts/transactions. Les lectures passent par les policies RLS
// (auto-filtrées côté serveur au compte du client connecté).

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

// ----------------------------------------------------------------------------
// FONCTIONNALITÉS (registre générique + permissions par compte)
// ----------------------------------------------------------------------------

export async function getClientFeatures() {
  const user = await requireUser();
  const [{ data: features, error: e1 }, { data: grants, error: e2 }] = await Promise.all([
    supabase.from('feature_registry').select('*').eq('area', 'client'),
    supabase.from('permission_grants').select('feature_key, granted').eq('account_id', user.id),
  ]);
  if (e1) throw e1;
  if (e2) throw e2;
  const overrides = new Map((grants || []).map((g) => [g.feature_key, g.granted]));
  const flags = {};
  for (const f of features || []) {
    if (overrides.has(f.key)) { flags[f.key] = f.enabled && overrides.get(f.key); }
    else { flags[f.key] = f.enabled && (f.default_roles || []).includes('client'); }
  }
  return { flags, features: features || [] };
}

// ----------------------------------------------------------------------------
// COMPTES
// ----------------------------------------------------------------------------

export async function getMyAccounts() {
  return unwrap(await supabase.from('accounts').select('*').order('opened_at', { ascending: true }));
}

export async function getMyTotalBalance() {
  const user = await requireUser();
  return unwrap(await supabase.rpc('client_total_balance', { p_client_id: user.id }));
}

export async function getAccountTransactions(accountId, limit = 50) {
  return unwrap(
    await supabase
      .from('transactions')
      .select('*')
      .or(`from_account_id.eq.${accountId},to_account_id.eq.${accountId}`)
      .order('created_at', { ascending: false })
      .limit(limit)
  );
}

export async function getMyTransactions(limit = 100) {
  const accounts = await getMyAccounts();
  const ids = accounts.map((a) => a.id);
  if (ids.length === 0) return [];
  const orClause = ids.map((id) => `from_account_id.eq.${id}`).concat(ids.map((id) => `to_account_id.eq.${id}`)).join(',');
  return unwrap(
    await supabase.from('transactions').select('*').or(orClause).order('created_at', { ascending: false }).limit(limit)
  );
}

// ----------------------------------------------------------------------------
// BÉNÉFICIAIRES
// ----------------------------------------------------------------------------

export async function getBeneficiaries() {
  return unwrap(await supabase.from('beneficiaries').select('*').order('label', { ascending: true }));
}

export async function addBeneficiary({ label, iban }) {
  const user = await requireUser();
  return unwrap(
    await supabase.from('beneficiaries').insert({ client_id: user.id, label, beneficiary_iban: iban }).select().single()
  );
}

export async function deleteBeneficiary(id) {
  const { error } = await supabase.from('beneficiaries').delete().eq('id', id);
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// VIREMENTS
// ----------------------------------------------------------------------------

export async function resolveAccountByIban(iban) {
  const rows = unwrap(await supabase.rpc('resolve_account_by_iban', { p_iban: iban }));
  return rows && rows[0] ? rows[0] : null;
}

export async function submitTransfer({ senderAccountId, recipientAccountId, amount, motif }) {
  return unwrap(
    await supabase.rpc('submit_transfer', {
      p_sender_account_id: senderAccountId,
      p_recipient_account_id: recipientAccountId,
      p_amount: amount,
      p_motif: motif,
    })
  );
}

export async function getMyTransfers() {
  return unwrap(await supabase.from('transfers').select('*').order('created_at', { ascending: false }));
}

// ----------------------------------------------------------------------------
// LINGOTS D'OR — banque + marché de revente
// ----------------------------------------------------------------------------

export async function getBankGoldStock() {
  return unwrap(
    await supabase.from('gold_bars').select('*').is('owner_client_id', null).eq('status', 'in_vault').order('weight_grams', { ascending: false })
  );
}

export async function getMyGoldBars() {
  const user = await requireUser();
  return unwrap(await supabase.from('gold_bars').select('*').eq('owner_client_id', user.id).order('weight_grams', { ascending: false }));
}

export async function buyGoldFromBank(goldBarId) {
  return unwrap(await supabase.rpc('submit_gold_bank_purchase', { p_gold_bar_id: goldBarId }));
}

export async function getMyGoldPurchaseRequests() {
  return unwrap(await supabase.from('gold_bank_purchase_requests').select('*').order('created_at', { ascending: false }));
}

export async function getMarketListings() {
  return unwrap(await supabase.from('gold_market_listings').select('*, gold_bars(*)').eq('status', 'active').order('listed_at', { ascending: false }));
}

export async function getMyMarketListings() {
  const user = await requireUser();
  return unwrap(await supabase.from('gold_market_listings').select('*, gold_bars(*)').eq('seller_client_id', user.id).order('listed_at', { ascending: false }));
}

export async function listGoldForSale(goldBarId, price) {
  return unwrap(await supabase.rpc('create_market_listing', { p_gold_bar_id: goldBarId, p_price: price }));
}

export async function buyFromMarket(listingId) {
  return unwrap(await supabase.rpc('submit_market_purchase', { p_listing_id: listingId }));
}

export async function getMyMarketPurchaseRequests() {
  const user = await requireUser();
  return unwrap(await supabase.from('gold_market_purchase_requests').select('*, gold_market_listings(*, gold_bars(*))').eq('buyer_client_id', user.id).order('created_at', { ascending: false }));
}

// ----------------------------------------------------------------------------
// COFFRES-FORTS
// ----------------------------------------------------------------------------

export async function getAvailableSafeBoxes() {
  return unwrap(await supabase.from('safe_deposit_boxes').select('*').eq('status', 'available').order('annual_fee', { ascending: true }));
}

export async function getMySafeBoxes() {
  const user = await requireUser();
  return unwrap(await supabase.from('safe_deposit_boxes').select('*').eq('client_id', user.id));
}

export async function getMySafeRequests() {
  return unwrap(await supabase.from('safe_rental_requests').select('*, safe_deposit_boxes(*)').order('requested_at', { ascending: false }));
}

export async function requestSafeBox() {
  return unwrap(await supabase.rpc('submit_safe_request'));
}

// ----------------------------------------------------------------------------
// PRÊTS PROFESSIONNELS
// ----------------------------------------------------------------------------

export async function getMyLoans() {
  return unwrap(await supabase.from('loans').select('*').order('requested_at', { ascending: false }));
}

export async function getLoanSchedule(loanId) {
  return unwrap(await supabase.from('loan_schedules').select('*').eq('loan_id', loanId).order('installment_number', { ascending: true }));
}

export async function requestLoan({ amount, purpose, termMonths }) {
  return unwrap(await supabase.rpc('submit_loan_request', { p_amount: amount, p_purpose: purpose, p_term_months: termMonths }));
}

export async function repayLoanEarly(loanId) {
  return unwrap(await supabase.rpc('repay_loan_early', { p_loan_id: loanId }));
}

// ----------------------------------------------------------------------------
// CONSULTING PREMIUM
// ----------------------------------------------------------------------------

export async function getMyConsultingRequests() {
  return unwrap(await supabase.from('consulting_requests').select('*').order('created_at', { ascending: false }));
}

export async function requestConsulting(message) {
  const user = await requireUser();
  return unwrap(await supabase.from('consulting_requests').insert({ client_id: user.id, message }).select().single());
}

// ----------------------------------------------------------------------------
// DOCUMENTS
// ----------------------------------------------------------------------------

export async function getMyDocuments() {
  return unwrap(await supabase.from('documents').select('*').order('created_at', { ascending: false }));
}

// ----------------------------------------------------------------------------
// SUPPORT (tickets = fil de discussion)
// ----------------------------------------------------------------------------

export async function getMySupportTickets() {
  return unwrap(await supabase.from('support_tickets').select('*').order('updated_at', { ascending: false }));
}

export async function getSupportMessages(ticketId) {
  return unwrap(await supabase.from('support_messages').select('*').eq('ticket_id', ticketId).order('created_at', { ascending: true }));
}

export async function createSupportTicket({ subject, category, firstMessage }) {
  return unwrap(await supabase.rpc('create_support_ticket', { p_subject: subject, p_category: category, p_first_message: firstMessage }));
}

export async function postSupportMessage(ticketId, body) {
  return unwrap(await supabase.rpc('post_support_message', { p_ticket_id: ticketId, p_body: body }));
}

// ----------------------------------------------------------------------------
// NOTIFICATIONS — voir ./notifications.js (module partagé entre les 4 rôles)
// ----------------------------------------------------------------------------
export { getMyNotifications, markNotificationsRead, markAllNotificationsRead, subscribeToMyNotifications } from './notifications.js';

// ----------------------------------------------------------------------------
// PARAMÈTRES ÉCONOMIQUES (lecture seule, pour affichage contextualisé)
// ----------------------------------------------------------------------------

export async function getEconomicSetting(key) {
  const user = await requireUser();
  return unwrap(await supabase.rpc('get_setting', { p_key: key, p_client_id: user.id }));
}

// ----------------------------------------------------------------------------
// PARAMÈTRES DU COMPTE (profil + mot de passe)
// ----------------------------------------------------------------------------

export async function updateDisplayName(displayName) {
  const user = await requireUser();
  const { error } = await supabase.from('profiles').update({ display_name: displayName }).eq('id', user.id);
  if (error) throw error;
}

export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// ADHÉSION (rôle prospect)
// ----------------------------------------------------------------------------

export async function getMyMembershipRequest() {
  const user = await requireUser();
  const { data, error } = await supabase
    .from('membership_requests')
    .select('*')
    .eq('applicant_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function submitMembershipRequest({ requestedAccountType, initialDeposit, motivation }) {
  const user = await requireUser();
  return unwrap(
    await supabase
      .from('membership_requests')
      .insert({
        applicant_id: user.id,
        requested_account_type: requestedAccountType,
        initial_deposit: initialDeposit,
        motivation,
      })
      .select()
      .single()
  );
}

// ----------------------------------------------------------------------------
// CONTENU PUBLIC — infos de la ville (réutilisé côté client)
// ----------------------------------------------------------------------------

export async function getCityNews() {
  return unwrap(
    await supabase.from('site_content').select('*').eq('area', 'public').eq('section_key', 'city_news').order('sort_order', { ascending: true })
  );
}

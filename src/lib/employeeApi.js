// ============================================================================
// NEWPAD — Wrapper API pour l'interface Employé
// ============================================================================
// Toute écriture qui touche à l'argent ou à un mouvement métier (adhésion,
// virement, lingot, coffre, prêt) passe exclusivement par les fonctions
// SECURITY DEFINER existantes. Les lectures passent par RLS (is_staff()) qui
// donne au personnel une vue large mais toujours en lecture pour l'argent.
// Quelques tables non-financières (file clients, alertes fraude, catégories)
// acceptent une écriture directe côté staff, autorisée explicitement par RLS.

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
// CLIENTS — recherche & fiche
// ----------------------------------------------------------------------------

export async function searchClients(query, limit = 30) {
  let q = supabase.from('profiles').select('*').eq('role', 'client').order('display_name', { ascending: true }).limit(limit);
  if (query && query.trim()) {
    q = q.or(`display_name.ilike.%${query.trim()}%,username.ilike.%${query.trim()}%`);
  }
  return unwrap(await q);
}

export async function searchProfilesAnyRole(query, limit = 20) {
  if (!query || query.trim().length < 2) return [];
  return unwrap(
    await supabase
      .from('profiles')
      .select('*')
      .or(`display_name.ilike.%${query.trim()}%,username.ilike.%${query.trim()}%`)
      .order('display_name', { ascending: true })
      .limit(limit)
  );
}

export async function getClientProfile(clientId) {
  return unwrap(await supabase.from('profiles').select('*').eq('id', clientId).single());
}

export async function getClientAccounts(clientId) {
  return unwrap(await supabase.from('accounts').select('*').eq('client_id', clientId).order('opened_at', { ascending: true }));
}

export async function getClientCategories() {
  return unwrap(await supabase.from('client_categories').select('*').order('name', { ascending: true }));
}

export async function createClientCategory({ name, color, description }) {
  return unwrap(
    await supabase
      .from('client_categories')
      .insert({ name, color: color || '#c9a227', description: description || null })
      .select()
      .single()
  );
}

export async function getClientCategoryLinks(clientId) {
  return unwrap(await supabase.from('client_category_links').select('*, client_categories(*)').eq('client_id', clientId));
}

// Renvoie les identifiants des clients rattachés à une catégorie donnée —
// utilisé pour filtrer la recherche client par catégorie côté personnel.
export async function getClientIdsInCategory(categoryId) {
  const rows = unwrap(await supabase.from('client_category_links').select('client_id').eq('category_id', categoryId));
  return rows.map((r) => r.client_id);
}

export async function addClientCategoryLink(clientId, categoryId) {
  const user = await requireUser();
  const { error } = await supabase.from('client_category_links').insert({ client_id: clientId, category_id: categoryId, linked_by: user.id });
  if (error) throw error;
}

export async function removeClientCategoryLink(clientId, categoryId) {
  const { error } = await supabase.from('client_category_links').delete().eq('client_id', clientId).eq('category_id', categoryId);
  if (error) throw error;
}

export async function getClientLoans(clientId) {
  return unwrap(await supabase.from('loans').select('*').eq('client_id', clientId).order('requested_at', { ascending: false }));
}

export async function getClientGoldBars(clientId) {
  return unwrap(await supabase.from('gold_bars').select('*').eq('owner_client_id', clientId).order('weight_grams', { ascending: false }));
}

// ----------------------------------------------------------------------------
// ADHÉSION
// ----------------------------------------------------------------------------

export async function getMembershipRequests(statusFilter) {
  let q = supabase.from('membership_requests').select('*, profiles!membership_requests_applicant_id_fkey(display_name, username)').order('created_at', { ascending: false });
  if (statusFilter) q = q.in('status', statusFilter);
  return unwrap(await q);
}

export async function claimMembershipRequest(id) {
  const { error } = await supabase.rpc('claim_membership_request', { p_request_id: id });
  if (error) throw error;
}

export async function decideMembershipRequest(id, approve, note) {
  const { error } = await supabase.rpc('decide_membership_request', { p_request_id: id, p_approve: approve, p_note: note || null });
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// OUVERTURE DE COMPTE AU GUICHET
// ----------------------------------------------------------------------------

export async function getManualAccountOpenings() {
  return unwrap(await supabase.from('manual_account_openings').select('*').order('created_at', { ascending: false }));
}

export async function createManualAccountOpening({ displayName, accountType, initialDeposit }) {
  const user = await requireUser();
  return unwrap(
    await supabase
      .from('manual_account_openings')
      .insert({ requested_by: user.id, display_name: displayName, account_type: accountType, initial_deposit: initialDeposit })
      .select()
      .single()
  );
}

export async function finalizeManualAccountOpening(openingId, clientProfileId) {
  return unwrap(await supabase.rpc('finalize_manual_account_opening', { p_opening_id: openingId, p_client_profile_id: clientProfileId }));
}

// ----------------------------------------------------------------------------
// CRÉATION DE COMPTE (Edge Function service_role — guichet / personnel)
// ----------------------------------------------------------------------------
// Seule opération du site qui a besoin de la clé service_role (créer un
// utilisateur Supabase Auth). Réservé au personnel : un employé peut créer un
// compte "client" (cas guichet), seul un admin peut créer "employee"/"admin"/
// "irs" — l'Edge Function applique elle-même cette règle côté serveur.
export async function createAccount({ username, password, displayName, role, employeeTitle, discordId, phoneNumber }) {
  const { data, error } = await supabase.functions.invoke('create-account', {
    body: { username, password, displayName, role, employeeTitle: employeeTitle || null, discordId: discordId || null, phoneNumber: phoneNumber || null },
  });
  if (error) {
    // Le corps JSON {error: "..."} renvoyé par la fonction est dans error.context
    let message = error.message;
    try {
      const body = await error.context?.json?.();
      if (body?.error) message = body.error;
    } catch (_) { /* pas de corps JSON exploitable, on garde le message par défaut */ }
    throw new Error(message);
  }
  return data;
}

// ----------------------------------------------------------------------------
// FILE CLIENTS (guichet)
// ----------------------------------------------------------------------------

export async function getBranchQueue() {
  return unwrap(await supabase.from('branch_queue').select('*, profiles!branch_queue_client_id_fkey(display_name, username)').order('joined_at', { ascending: true }));
}

export async function addToBranchQueue({ visitorName, reason, clientId }) {
  const { error } = await supabase.from('branch_queue').insert({ visitor_name: visitorName, reason, client_id: clientId || null });
  if (error) throw error;
}

export async function updateBranchQueueStatus(id, status) {
  const user = await requireUser();
  const patch = { status };
  if (status === 'in_service') { patch.called_by = user.id; patch.called_at = new Date().toISOString(); }
  if (status === 'done' || status === 'cancelled') { patch.closed_at = new Date().toISOString(); }
  const { error } = await supabase.from('branch_queue').update(patch).eq('id', id);
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// VIREMENTS
// ----------------------------------------------------------------------------

export async function getTransfersQueue() {
  return unwrap(await supabase.from('transfers').select('*').order('requested_at', { ascending: false }));
}

export async function claimTransfer(id) {
  const { error } = await supabase.rpc('claim_transfer', { p_transfer_id: id });
  if (error) throw error;
}

export async function decideTransfer(id, approve, note) {
  const { error } = await supabase.rpc('decide_transfer', { p_transfer_id: id, p_approve: approve, p_note: note || null });
  if (error) throw error;
}

export async function getAccountsByIds(ids) {
  if (!ids.length) return [];
  return unwrap(await supabase.from('accounts').select('*, profiles!accounts_client_id_fkey(display_name)').in('id', ids));
}

// ----------------------------------------------------------------------------
// LINGOTS D'OR
// ----------------------------------------------------------------------------

export async function getGoldBankQueue() {
  return unwrap(await supabase.from('gold_bank_purchase_requests').select('*, gold_bars(*), profiles!gold_bank_purchase_requests_client_id_fkey(display_name, username)').order('requested_at', { ascending: false }));
}

export async function decideGoldBankPurchase(id, approve, note) {
  const { error } = await supabase.rpc('decide_gold_bank_purchase', { p_request_id: id, p_approve: approve, p_note: note || null });
  if (error) throw error;
}

export async function getGoldMarketQueue() {
  return unwrap(
    await supabase
      .from('gold_market_purchase_requests')
      .select('*, gold_market_listings(*, gold_bars(*)), profiles!gold_market_purchase_requests_buyer_client_id_fkey(display_name, username)')
      .order('requested_at', { ascending: false })
  );
}

export async function decideMarketPurchase(id, approve, note) {
  const { error } = await supabase.rpc('decide_market_purchase', { p_request_id: id, p_approve: approve, p_note: note || null });
  if (error) throw error;
}

// Lingots actuellement en vente sur le marché de revente, quel que soit le
// vendeur (client ou banque) — permet au personnel de voir les lingots mis en
// vente côté client, pas seulement les demandes d'achat en attente.
export async function getAllMarketListings() {
  return unwrap(
    await supabase
      .from('gold_market_listings')
      .select('*, gold_bars(*), profiles!gold_market_listings_seller_client_id_fkey(display_name, username)')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
  );
}

export async function cancelMarketListing(listingId) {
  const { error } = await supabase.rpc('admin_cancel_market_listing', { p_listing_id: listingId });
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// COFFRES-FORTS
// ----------------------------------------------------------------------------

export async function getSafeRequestsQueue() {
  return unwrap(await supabase.from('safe_rental_requests').select('*, profiles!safe_rental_requests_client_id_fkey(display_name, username), safe_deposit_boxes(*)').order('requested_at', { ascending: false }));
}

export async function getAvailableSafeBoxesForAssignment() {
  return unwrap(await supabase.from('safe_deposit_boxes').select('*').eq('status', 'available').order('weekly_fee', { ascending: true }));
}

// Parc complet, visible du personnel (politique RLS `safe_boxes_select`,
// migration 0029). Sert à surveiller les locations en cours et à les résilier.
export async function getSafeBoxesForStaff() {
  return unwrap(await supabase.from('safe_deposit_boxes').select('*, profiles!safe_deposit_boxes_client_id_fkey(display_name, username)').order('code', { ascending: true }));
}

export async function endSafeRental(boxId, note) {
  const { error } = await supabase.rpc('end_safe_rental', { p_box_id: boxId, p_note: note || null });
  if (error) throw error;
}

export async function claimSafeRequest(id, safeBoxId, appointmentAt, appointmentLocation) {
  const { error } = await supabase.rpc('claim_safe_request', {
    p_request_id: id,
    p_safe_box_id: safeBoxId,
    p_appointment_at: appointmentAt,
    p_appointment_location: appointmentLocation,
  });
  if (error) throw error;
}

export async function confirmSafeRental(id) {
  const { error } = await supabase.rpc('confirm_safe_rental', { p_request_id: id });
  if (error) throw error;
}

export async function rejectSafeRequest(id, note) {
  const { error } = await supabase.rpc('reject_safe_request', { p_request_id: id, p_note: note || null });
  if (error) throw error;
}

// Décision simple en une étape (autoriser/refuser) — remplace le flux
// programmer-un-rendez-vous/confirmer pour le cas courant où l'on veut juste
// dire oui ou non tout de suite. boxId facultatif : un coffre disponible est
// choisi automatiquement si omis.
export async function decideSafeRequestSimple(id, approve, boxId, note) {
  const { error } = await supabase.rpc('staff_decide_safe_request', {
    p_request_id: id,
    p_approve: approve,
    p_safe_box_id: boxId || null,
    p_note: note || null,
  });
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// PRÊTS PROFESSIONNELS (réception employé — décision finale réservée à l'admin)
// ----------------------------------------------------------------------------

export async function getLoansQueue() {
  return unwrap(await supabase.from('loans').select('*, profiles!loans_client_id_fkey(display_name, username)').order('requested_at', { ascending: false }));
}

export async function reviewLoan(id, note) {
  const { error } = await supabase.rpc('employee_review_loan', { p_loan_id: id, p_note: note || null });
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// CONSULTING PREMIUM
// ----------------------------------------------------------------------------

export async function getConsultingQueue() {
  return unwrap(await supabase.from('consulting_requests').select('*, profiles!consulting_requests_client_id_fkey(display_name, username)').order('created_at', { ascending: false }));
}

export async function assignConsultingRequest(id, advisorId) {
  const { error } = await supabase.rpc('assign_consulting_request', { p_id: id, p_advisor_id: advisorId });
  if (error) throw error;
}

export async function rejectConsultingRequest(id, note) {
  const { error } = await supabase.rpc('reject_consulting_request', { p_id: id, p_note: note || null });
  if (error) throw error;
}

// Clôture d'un accompagnement mené à son terme (migration 0030). Sans elle, le
// conseiller devait REFUSER la demande pour la sortir de sa file — le client
// lisait alors « Demande refusée » à la fin d'un accompagnement réussi.
export async function closeConsultingRequest(id, note) {
  const { error } = await supabase.rpc('close_consulting_request', { p_id: id, p_note: note || null });
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// CAISSE
// ----------------------------------------------------------------------------

export async function getCashierReports(limit = 30) {
  return unwrap(await supabase.from('cashier_reports').select('*').order('report_date', { ascending: false }).limit(limit));
}

// ----------------------------------------------------------------------------
// FRAUDE
// ----------------------------------------------------------------------------

export async function getFraudAlerts(statusFilter) {
  let q = supabase.from('fraud_alerts').select('*, profiles!fraud_alerts_related_client_id_fkey(display_name, username)').order('created_at', { ascending: false });
  if (statusFilter) q = q.eq('status', statusFilter);
  return unwrap(await q);
}

export async function createManualFraudAlert({ severity, clientId, description }) {
  return unwrap(
    await supabase.rpc('create_fraud_alert', {
      p_origin: 'manual',
      p_rule_key: null,
      p_severity: severity,
      p_client_id: clientId || null,
      p_account_id: null,
      p_transaction_id: null,
      p_description: description,
    })
  );
}

// Passe par une fonction serveur depuis la migration 0031. L'écriture directe
// qui existait ici s'appuyait sur une policy autorisant le personnel à modifier
// N'IMPORTE QUELLE colonne d'une alerte — description et client visé compris.
// Un employé mis en cause par une alerte automatique pouvait donc la réécrire.
// Seuls le statut, le relecteur et la note de traitement sont modifiables.
export async function updateFraudAlertStatus(id, status, note) {
  const { error } = await supabase.rpc('set_fraud_alert_status', {
    p_id: id,
    p_status: status,
    p_note: note || null,
  });
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// SUPPORT (fil de discussion — vue personnel : tous les tickets)
// ----------------------------------------------------------------------------

export async function getAllSupportTickets(statusFilter) {
  // Note : pas de jointure vers le profil du membre du personnel assigné. Une
  // table avec deux clés étrangères vers `profiles` rend l'embed PostgREST
  // ambigu si on ne nomme pas la contrainte exacte, et une contrainte mal
  // nommée fait échouer la requête EN SILENCE (l'écran se vide, sans erreur —
  // c'est exactement le bug corrigé le 19/08 sur dix requêtes). Le nom du
  // membre du personnel est résolu séparément côté écran, où un échec reste
  // sans conséquence sur la liste des tickets.
  let q = supabase
    .from('support_tickets')
    .select('*, profiles!support_tickets_client_id_fkey(display_name, username)')
    .order('updated_at', { ascending: false });
  if (statusFilter) q = q.eq('status', statusFilter);
  return unwrap(await q);
}

// Prise en charge explicite (migration 0030). `assigned_to` n'était renseigné
// qu'en répondant au ticket : deux employés pouvaient travailler dessus en
// parallèle sans le savoir.
export async function claimSupportTicket(ticketId) {
  const { error } = await supabase.rpc('claim_support_ticket', { p_ticket_id: ticketId });
  if (error) throw error;
}

export async function getSupportMessages(ticketId) {
  return unwrap(await supabase.from('support_messages').select('*').eq('ticket_id', ticketId).order('created_at', { ascending: true }));
}

export async function postSupportMessage(ticketId, body) {
  const { error } = await supabase.rpc('post_support_message', { p_ticket_id: ticketId, p_body: body });
  if (error) throw error;
}

export async function resolveSupportTicket(ticketId) {
  const { error } = await supabase.rpc('resolve_support_ticket', { p_ticket_id: ticketId });
  if (error) throw error;
}

// ----------------------------------------------------------------------------
// JOURNAL D'ACTIVITÉ
// ----------------------------------------------------------------------------

// Recherche et filtres côté serveur (migration 0031). L'écran chargeait
// jusqu'ici les N dernières lignes sans aucun moyen de retrouver une action
// précise — « qui a validé ce virement » se cherchait à l'œil.
export async function getAuditLog({ search, action, role, limit = 200 } = {}) {
  return unwrap(
    await supabase.rpc('staff_list_audit_log', {
      p_search: search || null,
      p_action: action || null,
      p_role: role || null,
      p_limit: limit,
    })
  );
}

export async function getAuditActions() {
  return unwrap(await supabase.rpc('list_audit_actions'));
}

// ----------------------------------------------------------------------------
// HISTORIQUE DES TRANSACTIONS (personnel — employé & admin)
// ----------------------------------------------------------------------------

export async function listStaffTransactions({ search, txType, categoryId, limit = 300 } = {}) {
  return unwrap(
    await supabase.rpc('staff_list_transactions', {
      p_search: search || null,
      p_tx_type: txType || null,
      p_category_id: categoryId || null,
      p_limit: limit,
    })
  );
}

export async function listDistinctTxTypes() {
  const rows = await unwrap(await supabase.rpc('list_distinct_tx_types'));
  return rows.map((r) => r.tx_type);
}

// ----------------------------------------------------------------------------
// PARAMÈTRES DU COMPTE (profil + mot de passe — identique au client)
// ----------------------------------------------------------------------------

export async function updateDisplayName(displayName) {
  const user = await requireUser();
  const { error } = await supabase.from('profiles').update({ display_name: displayName }).eq('id', user.id);
  if (error) throw error;
}

export async function updatePhoneNumber(phoneNumber) {
  const user = await requireUser();
  const { error } = await supabase.from('profiles').update({ phone_number: phoneNumber || null }).eq('id', user.id);
  if (error) throw error;
}

// Onglet "Infos" client — lecture seule côté client, éditable ici (employé/admin).
export async function getClientInfo(clientId) {
  const { data, error } = await supabase.rpc('get_client_info', { p_client_id: clientId }).maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertClientInfo(clientId, content) {
  const { error } = await supabase.rpc('upsert_client_info', { p_client_id: clientId, p_content: content || null });
  if (error) throw error;
}

export async function updatePassword(newPassword) {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
  // Déconnexion des AUTRES sessions (scope 'others' : l'appareil courant reste
  // connecté). Sans cela, changer son mot de passe ne délogeait personne : une
  // session ouverte ailleurs — appareil perdu, poste partagé, intrus — gardait
  // un accès parfaitement valide. Non bloquant : le mot de passe est déjà
  // changé, l'échec du nettoyage ne doit pas faire croire à un échec global.
  try {
    await supabase.auth.signOut({ scope: 'others' });
  } catch (_) { /* voir commentaire ci-dessus */ }
}

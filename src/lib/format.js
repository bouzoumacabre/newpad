// ============================================================================
// NEWPAD — Formatage partagé (montants, dates)
// ============================================================================

export function formatMoney(amount) {
  const n = Number(amount || 0);
  return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $';
}

export function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const STATUS_LABELS = {
  pending: 'En attente',
  processing: 'En cours de traitement',
  validated: 'Validé',
  rejected: 'Refusé',
  active: 'Actif',
  closed: 'Clôturé',
  available: 'Disponible',
  reserved: 'Réservé',
  rented: 'Loué',
  in_vault: 'En coffre',
  listed: 'En vente',
  sold: 'Vendu',
  open: 'Ouvert',
  // Statut de ticket réellement posé depuis la migration 0030 (il existait
  // dans l'énumération `ticket_status` depuis l'origine, mais aucune fonction
  // ne l'écrivait jamais). Sans cette entrée, le client aurait lu la valeur
  // brute « in_progress » sur son ticket.
  in_progress: 'Pris en charge',
  resolved: 'Résolu',
  late: 'En retard',
  paid: 'Payée',
  assigned: 'Assigné',
};

const STATUS_BADGE = {
  pending: 'badge-pending',
  processing: 'badge-pending',
  validated: 'badge-success',
  active: 'badge-success',
  available: 'badge-success',
  in_vault: 'badge-success',
  paid: 'badge-success',
  resolved: 'badge-success',
  rejected: 'badge-danger',
  closed: 'badge-neutral',
  late: 'badge-danger',
  reserved: 'badge-pending',
  rented: 'badge-neutral',
  listed: 'badge-pending',
  sold: 'badge-neutral',
  open: 'badge-pending',
  in_progress: 'badge-pending',
  assigned: 'badge-pending',
};

export function statusLabel(status) {
  return STATUS_LABELS[status] || status;
}

export function statusBadge(status) {
  const cls = STATUS_BADGE[status] || 'badge-neutral';
  return `<span class="badge ${cls}">${statusLabel(status)}</span>`;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ----------------------------------------------------------------------------
// TYPES D'OPÉRATION DU LEDGER
// ----------------------------------------------------------------------------
// Centralisé ici (la table vivait auparavant dans transactionsScreen.js, donc
// n'était disponible que pour le personnel) : les écrans client en ont besoin
// aussi, et deux tables parallèles finiraient forcément par diverger.
// Liste de référence : commentaire de la colonne transactions.tx_type
// (migration 0001) + types ajoutés depuis (frais de dossier, pénalité,
// ajustement admin).
const TX_TYPE_LABELS = {
  transfer: 'Virement',
  cash_deposit: 'Dépôt initial',
  fee_management: 'Frais de gestion',
  fee_transfer_commission: 'Commission de virement',
  fee_marketplace_commission: 'Commission marché',
  savings_interest: 'Intérêts épargne',
  gold_purchase_bank: 'Achat lingot (banque)',
  gold_purchase_market: 'Achat lingot (marché)',
  safe_rental: 'Location coffre',
  loan_disbursement: 'Décaissement prêt',
  loan_repayment: 'Remboursement prêt',
  loan_processing_fee: 'Frais de dossier (prêt)',
  loan_penalty: 'Pénalité de retard',
  admin_adjustment: 'Ajustement bancaire',
};

export function txTypeLabel(type) {
  return TX_TYPE_LABELS[type] || type;
}

// ----------------------------------------------------------------------------
// JOURNAL D'ACTIVITÉ — libellés lisibles pour l'action et le détail (jsonb)
// ----------------------------------------------------------------------------

const AUDIT_ACTION_LABELS = {
  claim_transfer: 'Virement pris en charge',
  approve_transfer: 'Virement validé',
  reject_transfer: 'Virement refusé',
  transfer_flagged_needs_admin: 'Virement signalé — autorisation admin requise',
  approve_gold_bank_purchase: 'Achat de lingot (banque) validé',
  reject_gold_bank_purchase: 'Achat de lingot (banque) refusé',
  approve_gold_market_purchase: 'Achat de lingot (marché) validé',
  reject_gold_market_purchase: 'Achat de lingot (marché) refusé',
  claim_safe_request: 'Rendez-vous coffre programmé',
  confirm_safe_rental: 'Location de coffre confirmée',
  reject_safe_request: 'Demande de coffre refusée',
  admin_create_safe_box: 'Coffre créé',
  admin_update_safe_box: 'Coffre modifié',
  employee_review_loan: 'Prêt transmis pour décision finale',
  approve_loan: 'Prêt validé',
  reject_loan: 'Prêt refusé',
  approve_membership: 'Adhésion validée',
  reject_membership: 'Adhésion refusée',
  membership_needs_admin: 'Adhésion signalée — autorisation admin requise',
  resolve_support_ticket: 'Ticket support résolu',
  assign_consulting_request: 'Conseiller attribué',
  reject_consulting_request: 'Demande de consulting refusée',
  edge_create_account: 'Compte créé',
  mint_gold_bar: 'Lingot frappé',
  admin_update_gold_bar: 'Lingot modifié',
  admin_create_market_listing: 'Lingot mis en vente (banque)',
  admin_cancel_market_listing: 'Mise en vente retirée',
  admin_set_visibility_mask: 'Masquage modifié',
  admin_set_account_status: 'Statut de compte modifié',
  admin_set_profile_status: 'Statut de profil modifié',
  admin_adjust_cashier_report: 'Correction de caisse',
};

const AUDIT_DETAIL_KEY_LABELS = {
  client: 'Client',
  applicant: 'Demandeur',
  from: 'De',
  to: 'À',
  buyer: 'Acheteur',
  seller: 'Vendeur',
  advisor: 'Conseiller',
  amount: 'Montant',
  price: 'Prix',
  fee: 'Frais',
  note: 'Note',
  rate: 'Taux',
  term_months: 'Durée (mois)',
  role: 'Rôle',
  username: 'Identifiant',
  gold_bar_id: 'Lingot',
  safe_code: 'Coffre',
  weekly_fee: 'Loyer hebdomadaire',
  appointment_at: 'Rendez-vous',
  subject: 'Sujet',
  initial_deposit: 'Dépôt initial',
  projected_total: 'Solde projeté',
  processing_fee: 'Frais de dossier',
  code: 'Code',
  branch: 'Agence',
  status: 'Statut',
};

export function auditActionLabel(action) {
  return AUDIT_ACTION_LABELS[action] || action;
}

function formatAuditValue(key, value) {
  if (value === null || value === undefined || value === '') return null;
  if (['amount', 'price', 'fee', 'weekly_fee', 'initial_deposit', 'projected_total', 'processing_fee'].includes(key)) {
    return formatMoney(value);
  }
  if (key === 'appointment_at') return formatDateTime(value);
  return String(value);
}

// Rend le champ `details` (jsonb) du journal d'activité sous forme de texte
// lisible "Client : X — Montant : Y $" plutôt que du JSON brut.
export function auditDetailsText(details) {
  if (!details || typeof details !== 'object') return '';
  const parts = [];
  for (const [key, rawValue] of Object.entries(details)) {
    const value = formatAuditValue(key, rawValue);
    if (value === null) continue;
    const label = AUDIT_DETAIL_KEY_LABELS[key] || key;
    parts.push(`${label} : ${value}`);
  }
  return parts.join(' — ');
}

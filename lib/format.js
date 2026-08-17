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

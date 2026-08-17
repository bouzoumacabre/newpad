import { renderAdminShell } from './shell.js';
import { getTransfersQueue, getAccountsByIds, claimTransfer, decideTransfer } from '../../lib/employeeApi.js';
import { formatMoney, formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';

export async function renderAdminTransfers(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'transfers');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const transfers = await getTransfersQueue().catch(() => []);
    const relevant = transfers.filter((t) => t.status === 'pending' || t.status === 'processing');
    const accountIds = [...new Set(relevant.flatMap((t) => [t.sender_account_id, t.recipient_account_id]))];
    const accounts = await getAccountsByIds(accountIds).catch(() => []);
    const accountMap = new Map(accounts.map((a) => [a.id, a]));

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Virements à traiter</h1>
      <div class="card">
        ${
          relevant.length
            ? relevant
                .map((t) => {
                  const sender = accountMap.get(t.sender_account_id);
                  const recipient = accountMap.get(t.recipient_account_id);
                  return `
              <div style="padding:16px 0; border-bottom:1px solid var(--card-border);">
                <div class="flex justify-between items-center" style="margin-bottom:8px;">
                  <div>
                    <div style="font-weight:600;">${sender?.profiles?.display_name || '—'} → ${recipient?.profiles?.display_name || '—'}</div>
                    <div class="muted" style="font-size:12px;">${formatDateTime(t.requested_at)} — ${t.is_internal ? 'Interne' : 'Externe'}</div>
                  </div>
                  ${statusBadge(t.status)}
                </div>
                <div style="font-size:14px; margin-bottom:10px;">
                  Montant : <strong class="gold">${formatMoney(t.amount)}</strong>
                  ${t.motif ? ` — ${escapeHtml(t.motif)}` : ''}
                  ${t.requires_admin_override ? ' — <span class="text-danger">nécessite une autorisation admin (sous le solde minimum)</span>' : ''}
                </div>
                <div class="flex gap-sm">
                  ${
                    t.status === 'pending'
                      ? `<button class="btn btn-secondary claim-btn" data-id="${t.id}">Prendre en charge</button>`
                      : `
                    <button class="btn btn-primary approve-btn" data-id="${t.id}">Valider</button>
                    <button class="btn btn-danger reject-btn" data-id="${t.id}">Refuser</button>
                  `
                  }
                </div>
              </div>
            `;
                })
                .join('')
            : `<p class="muted">Aucun virement en attente.</p>`
        }
      </div>
    `;

    content.querySelectorAll('.claim-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try { await claimTransfer(btn.getAttribute('data-id')); await draw(); }
        catch (err) { alert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.approve-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        try {
          await decideTransfer(btn.getAttribute('data-id'), true, null);
          await draw();
        } catch (err) { alert(err.message || 'Erreur.'); }
      });
    });
    content.querySelectorAll('.reject-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = prompt('Motif du refus (optionnel) :') || null;
        try {
          await decideTransfer(btn.getAttribute('data-id'), false, note);
          await draw();
        } catch (err) { alert(err.message || 'Erreur.'); }
      });
    });
  }

  await draw();
}

import { renderClientShell } from './shell.js';
import { getMyAccounts, getMyTotalBalance, getMyTransactions, getCityNews, getMyLoans } from '../../lib/clientApi.js';
import { formatMoney, formatDateTime, escapeHtml } from '../../lib/format.js';
import { navigate } from '../../lib/router.js';

export async function renderClientDashboard(app, profile) {
  const { content } = await renderClientShell(app, profile, 'dashboard');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const [accounts, totalFromBank, transactions, news, loans] = await Promise.all([
    getMyAccounts().catch(() => []),
    getMyTotalBalance().catch(() => null),
    getMyTransactions(6).catch(() => []),
    getCityNews().catch(() => []),
    getMyLoans().catch(() => []),
  ]);

  // Le « solde total » affiché doit être CELUI QUE LA BANQUE UTILISE, pas une
  // somme recalculée côté navigateur. La règle de solde minimum (qui autorise
  // ou bloque virements et achats) s'appuie sur client_total_balance(), qui
  // exclut les comptes clôturés. Additionner tous les comptes ici — comptes
  // clôturés compris — affichait donc au client un total supérieur à celui de
  // la banque : il pouvait se croire au-dessus du minimum requis et voir son
  // virement refusé sans comprendre pourquoi. Repli sur le calcul local
  // uniquement si l'appel échoue, en appliquant le même filtre.
  const openAccounts = accounts.filter((a) => a.status !== 'closed');
  const total = totalFromBank !== null
    ? Number(totalFromBank)
    : openAccounts.reduce((sum, a) => sum + Number(a.balance), 0);
  const activeLoan = loans.find((l) => l.status === 'active');

  content.innerHTML = `
    <div class="flex justify-between items-center" style="margin-bottom:24px; flex-wrap:wrap; gap:12px;">
      <div>
        <h1 style="margin-bottom:4px;">Bienvenue, ${escapeHtml(profile.display_name)}.</h1>
        <p class="muted" style="margin:0;">Voici un aperçu de votre patrimoine chez Newman Bank.</p>
      </div>
      <button class="btn btn-primary" id="quick-transfer">Nouveau virement</button>
    </div>

    <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); margin-bottom:24px;">
      <div class="card">
        <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.05em;">Solde total</div>
        <div class="font-display gold" style="font-size:28px; margin-top:6px;">${formatMoney(total)}</div>
        <div class="muted" style="font-size:12px; margin-top:4px;">${openAccounts.length} compte${openAccounts.length > 1 ? 's' : ''}${accounts.length > openAccounts.length ? ` (+${accounts.length - openAccounts.length} clôturé${accounts.length - openAccounts.length > 1 ? 's' : ''})` : ''}</div>
      </div>
      <div class="card">
        <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.05em;">Prêt en cours</div>
        <div class="font-display" style="font-size:28px; margin-top:6px;">${activeLoan ? formatMoney(activeLoan.outstanding_balance) : '—'}</div>
        <div class="muted" style="font-size:12px; margin-top:4px;">${activeLoan ? 'Solde restant dû' : 'Aucun prêt actif'}</div>
      </div>
      <div class="card">
        <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.05em;">Identifiant banque</div>
        <div class="font-display" style="font-size:18px; margin-top:10px;">${escapeHtml(profile.username)}</div>
        <div class="muted" style="font-size:12px; margin-top:4px;">Client depuis le ${profile.client_since ? new Date(profile.client_since).toLocaleDateString('fr-FR') : '—'}</div>
      </div>
    </div>

    <div class="grid" style="grid-template-columns: 2fr 1fr; align-items:start;">
      <div class="card">
        <div class="flex justify-between items-center" style="margin-bottom:12px;">
          <h3 style="margin:0;">Dernières opérations</h3>
          <a href="#/client/accounts">Voir tous les comptes →</a>
        </div>
        ${
          transactions.length
            ? `<table><tbody>${transactions
                .map(
                  (t) => `
              <tr>
                <td>
                  <div style="font-weight:600;">${escapeHtml(t.description || t.tx_type)}</div>
                  <div class="muted" style="font-size:12px;">${formatDateTime(t.created_at)}</div>
                </td>
                <td style="text-align:right; font-weight:600;">${formatMoney(t.amount)}</td>
              </tr>
            `
                )
                .join('')}</tbody></table>`
            : `<p class="muted">Aucune opération pour l'instant.</p>`
        }
      </div>
      <div class="card">
        <h3 style="margin-bottom:12px;">Infos de la ville</h3>
        ${
          news.length
            ? news
                .slice(0, 3)
                .map(
                  (n) => `
            <div style="margin-bottom:14px; padding-bottom:14px; border-bottom:1px solid var(--card-border);">
              <div class="muted" style="font-size:11px; text-transform:uppercase; letter-spacing:0.04em;">${escapeHtml(n.content.category)}</div>
              <div style="font-weight:600; font-size:14px; margin:4px 0;">${escapeHtml(n.content.title)}</div>
              <div class="muted" style="font-size:12px;">${escapeHtml(n.content.excerpt)}</div>
            </div>
          `
                )
                .join('')
            : `<p class="muted">Rien à signaler.</p>`
        }
      </div>
    </div>
  `;

  document.getElementById('quick-transfer').addEventListener('click', () => navigate('/client/transfers'));
}

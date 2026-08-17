import { renderIrsShell } from './shell.js';
import { getIrsStats } from '../../lib/irsApi.js';
import { escapeHtml } from '../../lib/format.js';
import { navigate } from '../../lib/router.js';

export async function renderIrsDashboard(app, profile) {
  const { content } = await renderIrsShell(app, profile, 'dashboard');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const stats = await getIrsStats().catch(() => null);

  const cards = [
    { label: 'Clients enregistrés', value: stats?.clients_total ?? '—', path: '/irs/clients' },
    { label: 'Comptes (hors trésorerie)', value: stats?.accounts_total ?? '—', path: '/irs/accounts' },
    { label: 'Transactions visibles', value: stats?.transactions_total ?? '—', path: '/irs/transactions' },
    { label: "Or en circulation (kg)", value: stats?.gold_weight_kg ?? '—', path: '/irs/gold' },
  ];

  content.innerHTML = `
    <h1 style="margin-bottom:6px;">Bienvenue, ${escapeHtml(profile.display_name)}.</h1>
    <p class="muted" style="margin-bottom:24px;">Statistiques agrégées, Hurricane FA — accès en lecture seule.</p>

    <div class="grid" style="grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));">
      ${cards
        .map(
          (s) => `
        <div class="card card-tight stat-card" data-path="${s.path}" style="cursor:pointer;">
          <div class="muted" style="font-size:12px; text-transform:uppercase; letter-spacing:0.04em;">${s.label}</div>
          <div class="font-display gold" style="font-size:28px; margin-top:8px;">${s.value}</div>
        </div>
      `
        )
        .join('')}
    </div>

    <div class="card" style="margin-top:24px;">
      <p class="muted" style="font-size:13px; margin:0;">
        Ces chiffres reflètent uniquement ce qui n'a pas été masqué pour l'interface IRS (voir le masquage géré par l'administration).
        Aucune action de modification n'est disponible depuis ce compte.
      </p>
    </div>
  `;

  content.querySelectorAll('.stat-card').forEach((el) => {
    el.addEventListener('click', () => navigate(el.getAttribute('data-path')));
  });
}

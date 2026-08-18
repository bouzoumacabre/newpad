import { renderIrsShell } from './shell.js';
import { listIrsClients } from '../../lib/irsApi.js';
import { formatDate, escapeHtml } from '../../lib/format.js';

export async function renderIrsClients(app, profile) {
  const { content } = await renderIrsShell(app, profile, 'clients');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw(search) {
    const clients = await listIrsClients(search).catch(() => []);

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Clients</h1>
      <p class="muted" style="margin-bottom:20px;">Registre en lecture seule — nom, identifiant, ancienneté, note de confiance.</p>

      <div class="card" style="margin-bottom:20px;">
        <input type="text" id="search-input" placeholder="Rechercher un client..." value="${escapeHtml(search || '')}" style="max-width:360px;" />
      </div>

      <div class="card">
        ${
          clients.length
            ? `<table>
                <thead><tr><th>Nom</th><th>Identifiant</th><th>Client depuis</th><th style="text-align:right;">Note de confiance</th></tr></thead>
                <tbody>
                  ${clients
                    .map(
                      (c) => `
                    <tr>
                      <td style="font-weight:600;">${escapeHtml(c.display_name)}</td>
                      <td class="muted">${escapeHtml(c.username)}</td>
                      <td class="muted">${c.client_since ? formatDate(c.client_since) : '—'}</td>
                      <td style="text-align:right;">${c.trust_score ?? '—'}</td>
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>`
            : `<p class="muted">Aucun client trouvé.</p>`
        }
      </div>
    `;

    let debounce;
    document.getElementById('search-input').addEventListener('input', (e) => {
      clearTimeout(debounce);
      const v = e.target.value;
      debounce = setTimeout(() => draw(v), 300);
    });
  }

  await draw();
}

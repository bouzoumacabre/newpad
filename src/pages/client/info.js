// ============================================================================
// NEWPAD — Onglet "Infos" côté client : lecture seule. Le contenu est saisi
// et mis à jour exclusivement par l'admin, l'employé ou l'IRS (fiche client
// côté personnel) — voir get_client_info()/upsert_client_info() (migration
// 0014).
// ============================================================================

import { renderClientShell } from './shell.js';
import { getMyInfo } from '../../lib/clientApi.js';
import { formatDateTime, escapeHtml } from '../../lib/format.js';

export async function renderClientInfo(app, profile) {
  const { content } = await renderClientShell(app, profile, 'info');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const info = await getMyInfo().catch(() => null);

  content.innerHTML = `
    <h1 style="margin-bottom:6px;">Infos</h1>
    <p class="muted" style="margin-bottom:20px;">
      Informations et notes que la banque tient à votre sujet — communiquées par un employé, un administrateur ou
      l'IRS. Cet onglet est en lecture seule ; contactez la banque via la messagerie pour toute question.
    </p>

    <div class="card">
      ${
        info && info.content
          ? `
        <div style="white-space:pre-wrap; font-size:14px; margin-bottom:16px;">${escapeHtml(info.content)}</div>
        <div class="muted" style="font-size:12px;">Dernière mise à jour : ${formatDateTime(info.updated_at)}${info.updated_by_name ? ' par ' + escapeHtml(info.updated_by_name) : ''}</div>
      `
          : `<p class="muted">Aucune information particulière pour le moment.</p>`
      }
    </div>
  `;
}

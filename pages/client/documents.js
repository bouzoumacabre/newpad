import { renderClientShell } from './shell.js';
import { getMyDocuments } from '../../lib/clientApi.js';
import { formatDate, escapeHtml } from '../../lib/format.js';

const DOC_TYPE_LABELS = { releve: 'Relevé de compte', rib: 'RIB', contrat: 'Contrat', attestation: 'Attestation', autre: 'Autre' };

export async function renderClientDocuments(app, profile) {
  const { content } = await renderClientShell(app, profile, 'documents');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const documents = await getMyDocuments().catch(() => []);

  content.innerHTML = `
    <h1 style="margin-bottom:6px;">Documents</h1>
    <p class="muted" style="margin-bottom:20px;">Vos relevés, attestations et contrats émis par Newman Bank.</p>

    <div class="card">
      ${
        documents.length
          ? `<table>
              <thead><tr><th>Type</th><th>Titre</th><th>Période</th><th>Date</th></tr></thead>
              <tbody>
                ${documents
                  .map(
                    (d) => `
                  <tr>
                    <td><span class="badge badge-neutral">${DOC_TYPE_LABELS[d.doc_type] || d.doc_type}</span></td>
                    <td style="font-weight:600;">${escapeHtml(d.title)}</td>
                    <td class="muted">${escapeHtml(d.period_label || '—')}</td>
                    <td class="muted">${formatDate(d.created_at)}</td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>`
          : `<p class="muted">Aucun document disponible pour l'instant. Vos relevés et attestations apparaîtront ici au fur et à mesure de leur émission par nos services.</p>`
      }
    </div>
  `;
}

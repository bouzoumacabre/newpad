import { renderClientShell } from './shell.js';
import { getMyDocuments } from '../../lib/clientApi.js';
import { formatDate, escapeHtml } from '../../lib/format.js';
import { loadAll, loadErrorBanner } from '../../lib/loadState.js';

const DOC_TYPE_LABELS = {
  releve: 'Relevé de compte',
  rib: 'RIB',
  contrat: 'Contrat',
  attestation: 'Attestation',
  courrier: 'Courrier',
  autre: 'Autre',
};

export async function renderClientDocuments(app, profile) {
  const { content } = await renderClientShell(app, profile, 'documents');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  let openId = null;

  async function draw() {
    const { data, errors } = await loadAll({ documents: getMyDocuments() });
    const documents = data.documents;

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Documents</h1>
      <p class="muted" style="margin-bottom:20px;">Vos relevés, attestations et courriers émis par Newman Bank.</p>
      ${loadErrorBanner(errors)}

      <div class="card">
        ${
          documents.length
            ? documents
                .map(
                  (d) => `
            <div style="padding:14px 0; border-bottom:1px solid var(--card-border);">
              <div class="flex justify-between items-center" style="gap:10px; flex-wrap:wrap;">
                <div>
                  <div style="font-weight:600;">${escapeHtml(d.title)}</div>
                  <div class="muted" style="font-size:12px;">
                    <span class="badge badge-neutral">${escapeHtml(DOC_TYPE_LABELS[d.doc_type] || d.doc_type || 'Document')}</span>
                    ${d.period_label ? ' — ' + escapeHtml(d.period_label) : ''}
                    — émis le ${formatDate(d.created_at)}
                  </div>
                </div>
                <button class="btn btn-secondary open-doc" data-id="${d.id}" style="padding:5px 12px; font-size:12px;">
                  ${openId === d.id ? 'Replier' : 'Lire'}
                </button>
              </div>
              ${
                openId === d.id
                  ? `<div id="doc-body-${d.id}" style="margin-top:12px; padding:16px; border:1px solid var(--card-border); border-radius: var(--radius-sm); white-space:pre-wrap; font-size:14px; line-height:1.6;">${escapeHtml(d.content || 'Ce document n’a pas de contenu texte.')}</div>
                     <button class="btn btn-ghost print-doc" data-id="${d.id}" style="margin-top:10px; padding:4px 10px; font-size:12px;">Imprimer</button>`
                  : ''
              }
            </div>
          `
                )
                .join('')
            : `<p class="muted">Aucun document disponible pour l’instant. Vos relevés et attestations apparaîtront ici au fur et à mesure de leur émission par nos services.</p>`
        }
      </div>
    `;

    content.querySelectorAll('.open-doc').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        openId = openId === id ? null : id;
        draw();
      });
    });

    // L'impression passe par une fenêtre dédiée plutôt que window.print() sur
    // la page entière : la barre latérale et les cartes de l'interface ne
    // doivent pas se retrouver sur le document imprimé.
    content.querySelectorAll('.print-doc').forEach((btn) => {
      btn.addEventListener('click', () => {
        const doc = documents.find((d) => d.id === btn.getAttribute('data-id'));
        if (!doc) return;
        const w = window.open('', '_blank');
        if (!w) return;
        w.document.write(
          `<html><head><title>${escapeHtml(doc.title)}</title>` +
            `<style>body{font-family:Georgia,serif;max-width:720px;margin:40px auto;padding:0 24px;line-height:1.6;}` +
            `h1{font-size:20px;margin-bottom:4px;}.meta{color:#666;font-size:13px;margin-bottom:28px;}` +
            `.body{white-space:pre-wrap;}</style></head><body>` +
            `<h1>${escapeHtml(doc.title)}</h1>` +
            `<div class="meta">Newman Bank — ${escapeHtml(DOC_TYPE_LABELS[doc.doc_type] || doc.doc_type || 'Document')}` +
            `${doc.period_label ? ' — ' + escapeHtml(doc.period_label) : ''} — ${formatDate(doc.created_at)}</div>` +
            `<div class="body">${escapeHtml(doc.content || '')}</div></body></html>`
        );
        w.document.close();
        w.focus();
        w.print();
      });
    });
  }

  await draw();
}

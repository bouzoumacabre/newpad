// ============================================================================
// NEWPAD — Émission de documents, partagée par les interfaces Employé et Admin.
// ============================================================================
// La table `documents` existait depuis l'origine avec ses policies, mais aucun
// écran ni aucune fonction n'y écrivait : /client/documents était vide par
// construction, et le serait resté. La migration 0034 ouvre l'émission ; cet
// écran en est la porte.
//
// Un document est ici un ACTE TEXTE (attestation, relevé rédigé, courrier),
// lisible et imprimable par le client. Les pièces jointes déposées dans Storage
// attendent la création du bucket (migration 0016, en attente de décision).
// ============================================================================

import { getStaffDocuments, issueDocument, revokeDocument, searchClients } from '../../lib/employeeApi.js';
import { formatDateTime, escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';
import { loadAll, loadErrorBanner, swallow } from '../../lib/loadState.js';

const DOC_TYPES = [
  ['attestation', 'Attestation'],
  ['releve', 'Relevé de compte'],
  ['rib', 'RIB'],
  ['contrat', 'Contrat'],
  ['courrier', 'Courrier'],
  ['autre', 'Autre'],
];

export async function renderStaffDocumentsScreen(content, profile, { canRevoke = false } = {}) {
  content.innerHTML = `<p class="muted">Chargement…</p>`;
  let selectedClient = null;
  let matches = [];

  async function draw() {
    const { data, errors } = await loadAll({ documents: getStaffDocuments(null) });
    const documents = data.documents;

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Documents émis</h1>
      <p class="muted" style="margin-bottom:20px; font-size:13px;">
        Un document émis apparaît immédiatement dans l'espace du client, qui en est notifié. Le texte est définitif :
        pour corriger une erreur, ${canRevoke ? 'retirez le document et réémettez-le' : "demandez à l'administration de le retirer"}.
      </p>
      ${loadErrorBanner(errors)}

      <div class="card" style="margin-bottom:24px;">
        <h3 style="margin-bottom:16px;">Émettre un document</h3>
        <div class="grid" style="grid-template-columns: 1.4fr 1fr 1fr; gap:10px; align-items:end; margin-bottom:12px;">
          <div class="field" style="margin:0;">
            <label for="doc-client">Client (nom ou identifiant)</label>
            <input type="text" id="doc-client" placeholder="Rechercher…" autocomplete="off" />
            <div id="doc-client-match" class="muted" style="font-size:12px; margin-top:4px;">&nbsp;</div>
          </div>
          <div class="field" style="margin:0;">
            <label for="doc-type">Type</label>
            <select id="doc-type">
              ${DOC_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
            </select>
          </div>
          <div class="field" style="margin:0;">
            <label for="doc-period">Période (optionnel)</label>
            <input type="text" id="doc-period" maxlength="60" placeholder="Ex : août 2026" />
          </div>
        </div>
        <div class="field">
          <label for="doc-title">Titre</label>
          <input type="text" id="doc-title" maxlength="200" placeholder="Ex : Attestation de domiciliation bancaire" />
        </div>
        <div class="field">
          <label for="doc-content">Contenu</label>
          <textarea id="doc-content" rows="8" maxlength="20000" placeholder="Rédigez le document tel que le client le lira…"></textarea>
        </div>
        <div id="doc-error" class="text-danger" style="font-size:13px; margin-bottom:12px; display:none;"></div>
        <button id="doc-submit" class="btn btn-primary">Émettre le document</button>
      </div>

      <h3 style="margin-bottom:12px;">Historique (${documents.length})</h3>
      <div class="card" style="overflow-x:auto;">
        ${
          documents.length
            ? `<table>
                <thead><tr><th>Date</th><th>Client</th><th>Type</th><th>Titre</th><th>Période</th><th>Émis par</th>${canRevoke ? '<th></th>' : ''}</tr></thead>
                <tbody>
                  ${documents
                    .map(
                      (d) => `
                    <tr>
                      <td class="muted" style="white-space:nowrap;">${formatDateTime(d.created_at)}</td>
                      <td>${escapeHtml(d.client_name || '—')}</td>
                      <td class="muted">${escapeHtml(d.doc_type || '—')}</td>
                      <td style="font-weight:600;">${escapeHtml(d.title)}</td>
                      <td class="muted">${escapeHtml(d.period_label || '—')}</td>
                      <td class="muted">${escapeHtml(d.issued_by || 'Système')}</td>
                      ${canRevoke ? `<td style="text-align:right;"><button class="btn btn-danger revoke-btn" data-id="${d.id}" data-title="${escapeHtml(d.title)}" style="padding:4px 10px; font-size:12px;">Retirer</button></td>` : ''}
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>`
            : `<p class="muted">Aucun document émis à ce jour.</p>`
        }
      </div>
    `;

    const clientInput = document.getElementById('doc-client');
    const matchEl = document.getElementById('doc-client-match');
    let debounce;
    clientInput.addEventListener('input', () => {
      clearTimeout(debounce);
      selectedClient = null;
      matchEl.innerHTML = '&nbsp;';
      const typed = clientInput.value.trim();
      if (typed.length < 2) return;
      debounce = setTimeout(async () => {
        matches = await searchClients(typed, 5).catch(swallow('searchClients', []));
        if (!matches.length) {
          matchEl.textContent = 'Aucun client ne correspond.';
          return;
        }
        const exact = matches.find(
          (m) => m.username.toLowerCase() === typed.toLowerCase() || m.display_name.toLowerCase() === typed.toLowerCase()
        );
        selectedClient = exact || (matches.length === 1 ? matches[0] : null);
        matchEl.textContent = selectedClient
          ? `Destinataire : ${selectedClient.display_name} (${selectedClient.username})`
          : `${matches.length} correspondances — précisez le nom ou l'identifiant exact.`;
      }, 300);
    });

    document.getElementById('doc-submit').addEventListener('click', async () => {
      const errorEl = document.getElementById('doc-error');
      errorEl.style.display = 'none';
      const title = document.getElementById('doc-title').value.trim();
      const body = document.getElementById('doc-content').value.trim();
      if (!selectedClient) {
        errorEl.textContent = 'Sélectionnez un client destinataire.';
        errorEl.style.display = 'block';
        return;
      }
      if (!title || !body) {
        errorEl.textContent = 'Le titre et le contenu sont requis.';
        errorEl.style.display = 'block';
        return;
      }
      try {
        await issueDocument({
          clientId: selectedClient.id,
          docType: document.getElementById('doc-type').value,
          title,
          content: body,
          periodLabel: document.getElementById('doc-period').value.trim() || null,
        });
        selectedClient = null;
        await draw();
      } catch (err) {
        errorEl.textContent = err.message || "Erreur lors de l'émission.";
        errorEl.style.display = 'block';
      }
    });

    content.querySelectorAll('.revoke-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!(await showConfirm(`Retirer définitivement « ${btn.getAttribute('data-title')} » de l'espace du client ?`))) return;
        const reason = (await showPrompt('Motif du retrait (journalisé) :')) || null;
        btn.disabled = true;
        try { await revokeDocument(btn.getAttribute('data-id'), reason); await draw(); }
        catch (err) { await showAlert(err.message || 'Erreur.'); btn.disabled = false; }
      });
    });
  }

  await draw();
}

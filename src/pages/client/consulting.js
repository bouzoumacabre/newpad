import { renderClientShell } from './shell.js';
import { getMyConsultingRequests, requestConsulting } from '../../lib/clientApi.js';
import { formatDateTime, statusBadge, escapeHtml } from '../../lib/format.js';

export async function renderClientConsulting(app, profile) {
  const { content } = await renderClientShell(app, profile, 'consulting');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const requests = await getMyConsultingRequests().catch(() => []);

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Consulting Premium</h1>
      <p class="muted" style="margin-bottom:20px;">Un accompagnement personnalisé pour la gestion de votre patrimoine, assuré par nos conseillers dédiés.</p>

      <div class="grid" style="grid-template-columns: 1fr 1.3fr; align-items:start;">
        <div class="card">
          <h3 style="margin-bottom:16px;">Demander un accompagnement</h3>
          <div class="field">
            <label>Votre demande</label>
            <textarea id="consulting-message" rows="5" placeholder="Décrivez votre besoin (gestion de patrimoine, stratégie d'investissement, succession...)"></textarea>
          </div>
          <div id="consulting-error" class="text-danger" style="font-size:13px; margin-bottom:12px; display:none;"></div>
          <button id="consulting-submit" class="btn btn-primary" style="width:100%;">Envoyer la demande</button>
        </div>

        <div class="card">
          <h3 style="margin-bottom:12px;">Mes demandes</h3>
          ${
            requests.length
              ? requests
                  .map(
                    (r) => `
              <div style="padding:12px 0; border-bottom:1px solid var(--card-border);">
                <div class="flex justify-between items-center" style="margin-bottom:6px;">
                  <span class="muted" style="font-size:12px;">${formatDateTime(r.created_at)}</span>
                  ${statusBadge(r.status)}
                </div>
                <div style="font-size:14px;">${escapeHtml(r.message)}</div>
                ${r.status === 'rejected' && r.decision_note ? `<div class="muted" style="font-size:12px; margin-top:6px;">Motif : ${escapeHtml(r.decision_note)}</div>` : ''}
              </div>
            `
                  )
                  .join('')
              : `<p class="muted">Aucune demande envoyée.</p>`
          }
        </div>
      </div>
    `;

    document.getElementById('consulting-submit').addEventListener('click', async () => {
      const errorEl = document.getElementById('consulting-error');
      errorEl.style.display = 'none';
      const message = document.getElementById('consulting-message').value.trim();
      if (!message) {
        errorEl.textContent = 'Veuillez décrire votre demande.';
        errorEl.style.display = 'block';
        return;
      }
      try {
        await requestConsulting(message);
        await draw();
      } catch (err) {
        errorEl.textContent = err.message || 'Erreur lors de l\'envoi.';
        errorEl.style.display = 'block';
      }
    });
  }

  await draw();
}

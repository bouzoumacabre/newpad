import { renderAdminShell } from './shell.js';
import { getVisibilityMasks, setVisibilityMask } from '../../lib/adminApi.js';
import { formatDateTime, escapeHtml } from '../../lib/format.js';

const TARGET_TYPES = ['account', 'transaction'];
const INTERFACES = ['client', 'employee', 'admin', 'irs', 'public'];

export async function renderAdminVisibility(app, profile) {
  const { content } = await renderAdminShell(app, profile, 'visibility');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const masks = await getVisibilityMasks().catch(() => []);

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Masquage par interface</h1>
      <p class="muted" style="margin-bottom:20px;">
        Masque un compte ou une transaction précis sur une ou plusieurs interfaces (ex : dissimuler une opération à
        l'IRS). Il n'existe pas de sélecteur convivial pour choisir librement un compte/une transaction — saisissez
        directement son identifiant UUID (visible dans le journal d'activité ou les écrans de traitement).
      </p>

      <div class="card" style="margin-bottom:24px;">
        <h3 style="margin-bottom:16px;">Ajouter / mettre à jour un masquage</h3>
        <div class="grid" style="grid-template-columns: 1fr 2fr; gap:10px;">
          <div class="field" style="margin:0;">
            <label>Type de cible</label>
            <select id="mask-type">
              ${TARGET_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}
            </select>
          </div>
          <div class="field" style="margin:0;">
            <label>Identifiant (UUID)</label>
            <input type="text" id="mask-id" placeholder="00000000-0000-0000-0000-000000000000" />
          </div>
        </div>
        <div class="field">
          <label>Masquer sur les interfaces</label>
          <div class="flex gap-md" style="flex-wrap:wrap;">
            ${INTERFACES.map((i) => `
              <label class="flex items-center gap-sm" style="font-size:13px; font-weight:400;">
                <input type="checkbox" class="mask-iface" value="${i}" /> ${i}
              </label>
            `).join('')}
          </div>
        </div>
        <div class="field">
          <label>Motif</label>
          <input type="text" id="mask-reason" placeholder="Optionnel" />
        </div>
        <div id="mask-error" class="text-danger" style="font-size:13px; margin-bottom:10px; display:none;"></div>
        <button id="mask-submit" class="btn btn-primary">Enregistrer</button>
      </div>

      <h3 style="margin-bottom:12px;">Masquages actifs (${masks.length})</h3>
      <div class="card">
        ${
          masks.length
            ? `<table>
                <thead><tr><th>Type</th><th>Identifiant</th><th>Masqué sur</th><th>Motif</th><th>Créé le</th></tr></thead>
                <tbody>
                  ${masks
                    .map(
                      (m) => `
                    <tr>
                      <td>${escapeHtml(m.target_type)}</td>
                      <td class="muted" style="font-size:12px;">${escapeHtml(m.target_id)}</td>
                      <td>${(m.hidden_from_interfaces || []).map((i) => `<span class="badge badge-neutral" style="margin-right:4px;">${escapeHtml(i)}</span>`).join('') || '—'}</td>
                      <td class="muted" style="font-size:12px;">${escapeHtml(m.reason || '—')}</td>
                      <td class="muted" style="font-size:12px;">${formatDateTime(m.created_at)}</td>
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>`
            : `<p class="muted">Aucun masquage actif.</p>`
        }
      </div>
    `;

    document.getElementById('mask-submit').addEventListener('click', async () => {
      const errorEl = document.getElementById('mask-error');
      errorEl.style.display = 'none';
      const type = document.getElementById('mask-type').value;
      const id = document.getElementById('mask-id').value.trim();
      const reason = document.getElementById('mask-reason').value.trim();
      const hiddenFrom = Array.from(content.querySelectorAll('.mask-iface:checked')).map((el) => el.value);
      if (!id) {
        errorEl.textContent = "Veuillez renseigner l'identifiant UUID de la cible.";
        errorEl.style.display = 'block';
        return;
      }
      try {
        await setVisibilityMask({ type, id, hiddenFrom, reason: reason || null });
        await draw();
      } catch (err) {
        errorEl.textContent = err.message || "Erreur lors de l'enregistrement (vérifiez que l'identifiant est un UUID valide).";
        errorEl.style.display = 'block';
      }
    });
  }

  await draw();
}

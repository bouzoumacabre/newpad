import { renderClientShell } from './shell.js';
import { getBeneficiaries, addBeneficiary, deleteBeneficiary, resolveAccountByIban } from '../../lib/clientApi.js';
import { escapeHtml } from '../../lib/format.js';
import { showAlert, showConfirm, showPrompt } from '../../lib/uiDialogs.js';

export async function renderClientBeneficiaries(app, profile) {
  const { content } = await renderClientShell(app, profile, 'beneficiaries');
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  async function draw() {
    const beneficiaries = await getBeneficiaries().catch(() => []);

    content.innerHTML = `
      <h1 style="margin-bottom:20px;">Bénéficiaires</h1>
      <div class="grid" style="grid-template-columns: 1fr 1.4fr; align-items:start;">
        <div class="card">
          <h3 style="margin-bottom:16px;">Ajouter un bénéficiaire</h3>
          <div class="field">
            <label>Nom / libellé</label>
            <input type="text" id="ben-label" placeholder="Ex: Société Lévy & Fils" />
          </div>
          <div class="field">
            <label>IBAN</label>
            <input type="text" id="ben-iban" placeholder="Ex: BNW26XXXXXXXX" />
            <div id="ben-iban-status" class="muted" style="font-size:12px; margin-top:6px;"></div>
          </div>
          <div id="ben-error" class="text-danger" style="font-size:13px; margin-bottom:12px; display:none;"></div>
          <button id="ben-add" class="btn btn-primary" style="width:100%;">Ajouter</button>
        </div>

        <div class="card">
          <h3 style="margin-bottom:12px;">Mes bénéficiaires (${beneficiaries.length})</h3>
          ${
            beneficiaries.length
              ? `<table>
                  <thead><tr><th>Nom</th><th>IBAN</th><th></th></tr></thead>
                  <tbody>
                    ${beneficiaries
                      .map(
                        (b) => `
                      <tr>
                        <td style="font-weight:600;">${escapeHtml(b.label)}</td>
                        <td class="muted">${escapeHtml(b.beneficiary_iban || '—')}</td>
                        <td style="text-align:right;"><button class="btn btn-ghost ben-delete" data-id="${b.id}" style="color:var(--status-danger); padding:4px 8px;">Supprimer</button></td>
                      </tr>
                    `
                      )
                      .join('')}
                  </tbody>
                </table>`
              : `<p class="muted">Aucun bénéficiaire enregistré.</p>`
          }
        </div>
      </div>
    `;

    const ibanInput = document.getElementById('ben-iban');
    const ibanStatus = document.getElementById('ben-iban-status');
    let debounce;
    ibanInput.addEventListener('input', () => {
      clearTimeout(debounce);
      const val = ibanInput.value.trim();
      if (val.length < 5) { ibanStatus.textContent = ''; return; }
      debounce = setTimeout(async () => {
        ibanStatus.textContent = 'Recherche…';
        try {
          const found = await resolveAccountByIban(val.toUpperCase());
          ibanStatus.textContent = found ? `✓ ${found.owner_display_name}` : 'Aucun compte actif trouvé (vous pouvez tout de même l\'enregistrer).';
          ibanStatus.className = found ? 'text-success' : 'muted';
          ibanStatus.style.fontSize = '12px';
        } catch (_) { ibanStatus.textContent = ''; }
      }, 400);
    });

    document.getElementById('ben-add').addEventListener('click', async () => {
      const errorEl = document.getElementById('ben-error');
      errorEl.style.display = 'none';
      const label = document.getElementById('ben-label').value.trim();
      const iban = ibanInput.value.trim().toUpperCase();
      if (!label || !iban) {
        errorEl.textContent = 'Veuillez renseigner un nom et un IBAN.';
        errorEl.style.display = 'block';
        return;
      }
      try {
        await addBeneficiary({ label, iban });
        await draw();
      } catch (err) {
        errorEl.textContent = err.message || 'Erreur lors de l\'ajout.';
        errorEl.style.display = 'block';
      }
    });

    content.querySelectorAll('.ben-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!await showConfirm('Supprimer ce bénéficiaire ?')) return;
        await deleteBeneficiary(btn.getAttribute('data-id'));
        await draw();
      });
    });
  }

  await draw();
}

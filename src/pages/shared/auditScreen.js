// ============================================================================
// NEWPAD — Journal d'activité, partagé par les interfaces Employé et Admin.
// ============================================================================
// L'admin voit en plus l'historique des connexions et les anomalies de compte,
// tous deux réservés à son rôle côté serveur.
// ============================================================================

import { getAuditLog, getAuditActions } from '../../lib/employeeApi.js';
import { getLoginLog, getAccountAnomalies } from '../../lib/adminApi.js';
import { formatMoney, formatDateTime, escapeHtml, auditActionLabel, auditDetailsText } from '../../lib/format.js';
import { loadAll, loadErrorBanner } from '../../lib/loadState.js';

const ROLES = [
  ['', 'Tous les rôles'],
  ['admin', 'Admin'],
  ['employee', 'Employé'],
  ['client', 'Client'],
  ['irs', 'IRS'],
];

export async function renderAuditScreen(content, profile, { isAdmin = false } = {}) {
  content.innerHTML = `<p class="muted">Chargement…</p>`;

  const filters = { search: '', action: '', role: '' };
  let tab = 'audit';

  async function draw() {
    const tasks = { entries: getAuditLog({ ...filters, limit: 300 }), actions: getAuditActions() };
    if (isAdmin && tab === 'logins') tasks.logins = getLoginLog({ limit: 300 });
    if (isAdmin && tab === 'anomalies') tasks.anomalies = getAccountAnomalies();
    const { data, errors } = await loadAll(tasks);

    content.innerHTML = `
      <h1 style="margin-bottom:6px;">Journal d'activité</h1>
      <p class="muted" style="margin-bottom:16px;">
        Qui a validé, refusé ou modifié quoi, et pour quel client. Le journal est en écriture seule : aucun rôle,
        pas même l'admin, ne peut en supprimer ou en réécrire une ligne.
      </p>
      ${loadErrorBanner(errors)}

      ${
        isAdmin
          ? `<div class="flex gap-sm" style="margin-bottom:16px; flex-wrap:wrap;">
               <button class="btn ${tab === 'audit' ? 'btn-primary' : 'btn-ghost'} tab-btn" data-tab="audit">Actions du personnel</button>
               <button class="btn ${tab === 'logins' ? 'btn-primary' : 'btn-ghost'} tab-btn" data-tab="logins">Tentatives de connexion</button>
               <button class="btn ${tab === 'anomalies' ? 'btn-primary' : 'btn-ghost'} tab-btn" data-tab="anomalies">Anomalies de compte</button>
             </div>`
          : ''
      }

      <div id="tab-content"></div>
    `;

    const panel = document.getElementById('tab-content');

    if (tab === 'audit') {
      const entries = data.entries || [];
      const actions = data.actions || [];
      panel.innerHTML = `
        <div class="card" style="margin-bottom:16px;">
          <div class="grid" style="grid-template-columns: 2fr 1.4fr 1fr; gap:10px; align-items:end;">
            <div class="field" style="margin:0;">
              <label for="audit-search">Rechercher</label>
              <input type="text" id="audit-search" value="${escapeHtml(filters.search)}" placeholder="Nom, identifiant, action, montant…" />
            </div>
            <div class="field" style="margin:0;">
              <label for="audit-action">Action</label>
              <select id="audit-action">
                <option value="">Toutes les actions</option>
                ${actions
                  .map(
                    (a) =>
                      `<option value="${escapeHtml(a.action)}" ${filters.action === a.action ? 'selected' : ''}>${escapeHtml(auditActionLabel(a.action))} (${a.total})</option>`
                  )
                  .join('')}
              </select>
            </div>
            <div class="field" style="margin:0;">
              <label for="audit-role">Rôle de l'auteur</label>
              <select id="audit-role">
                ${ROLES.map(([v, l]) => `<option value="${v}" ${filters.role === v ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
          </div>
        </div>

        <div class="card" style="overflow-x:auto;">
          <p class="muted" style="font-size:12px; margin:0 0 12px;">${entries.length} entrée${entries.length > 1 ? 's' : ''} affichée${entries.length > 1 ? 's' : ''} (300 maximum).</p>
          ${
            entries.length
              ? `<table>
                  <thead><tr><th>Date</th><th>Auteur</th><th>Rôle</th><th>Action</th><th>Détails</th></tr></thead>
                  <tbody>
                    ${entries
                      .map(
                        (e) => `
                      <tr>
                        <td class="muted" style="white-space:nowrap;">${formatDateTime(e.created_at)}</td>
                        <td>${escapeHtml(e.actor_name || 'Système')}</td>
                        <td class="muted">${escapeHtml(e.actor_role || '—')}</td>
                        <td>${escapeHtml(auditActionLabel(e.action))}</td>
                        <td class="muted" style="font-size:13px;">${escapeHtml(auditDetailsText(e.details)) || '—'}</td>
                      </tr>
                    `
                      )
                      .join('')}
                  </tbody>
                </table>`
              : `<p class="muted">Aucune entrée ne correspond à cette recherche.</p>`
          }
        </div>
      `;

      const rerun = () => {
        filters.search = document.getElementById('audit-search').value.trim();
        filters.action = document.getElementById('audit-action').value;
        filters.role = document.getElementById('audit-role').value;
        draw();
      };
      document.getElementById('audit-action').addEventListener('change', rerun);
      document.getElementById('audit-role').addEventListener('change', rerun);
      const searchInput = document.getElementById('audit-search');
      searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') rerun(); });
      searchInput.addEventListener('blur', rerun);
    }

    if (tab === 'logins') {
      const logins = data.logins || [];
      const echecs = logins.filter((l) => !l.success).length;
      panel.innerHTML = `
        <div class="card" style="overflow-x:auto;">
          <p class="muted" style="font-size:12px; margin:0 0 12px;">
            ${logins.length} tentative${logins.length > 1 ? 's' : ''} récente${logins.length > 1 ? 's' : ''}, dont ${echecs} en échec.
            Au-delà du seuil configuré dans Pilotage économique, une alerte de fraude est émise automatiquement.
          </p>
          ${
            logins.length
              ? `<table>
                  <thead><tr><th>Date</th><th>Identifiant saisi</th><th>Compte reconnu</th><th>Résultat</th></tr></thead>
                  <tbody>
                    ${logins
                      .map(
                        (l) => `
                      <tr>
                        <td class="muted" style="white-space:nowrap;">${formatDateTime(l.created_at)}</td>
                        <td style="font-weight:600;">${escapeHtml(l.username_attempted || '—')}</td>
                        <td class="muted">${escapeHtml(l.display_name || 'Identifiant inconnu')}</td>
                        <td>${l.success ? '<span class="badge badge-success">Réussie</span>' : '<span class="badge badge-danger">Échec</span>'}</td>
                      </tr>
                    `
                      )
                      .join('')}
                  </tbody>
                </table>`
              : `<p class="muted">Aucune tentative enregistrée.</p>`
          }
        </div>
      `;
    }

    if (tab === 'anomalies') {
      const anomalies = data.anomalies || [];
      panel.innerHTML = `
        <div class="card" style="overflow-x:auto;">
          <p class="muted" style="font-size:12px; margin:0 0 12px;">
            Comptes dont le solde est négatif, et comptes clôturés alors que leur solde n'était pas nul. Ces derniers sortent
            du patrimoine du client sans qu'aucun mouvement d'argent n'ait été enregistré : depuis le 30/08 la clôture est
            refusée tant que le solde n'est pas ramené à zéro, mais les cas antérieurs restent à arbitrer.
          </p>
          ${
            anomalies.length
              ? `<table>
                  <thead><tr><th>IBAN</th><th>Client</th><th>Statut</th><th style="text-align:right;">Solde</th><th>Anomalie</th></tr></thead>
                  <tbody>
                    ${anomalies
                      .map(
                        (a) => `
                      <tr>
                        <td style="font-weight:600;">${escapeHtml(a.iban || '—')}</td>
                        <td>${escapeHtml(a.client_name || '—')}</td>
                        <td class="muted">${escapeHtml(a.status)}</td>
                        <td style="text-align:right;" class="text-danger">${formatMoney(a.balance)}</td>
                        <td class="muted" style="font-size:13px;">${escapeHtml(a.anomalie || '')}</td>
                      </tr>
                    `
                      )
                      .join('')}
                  </tbody>
                </table>`
              : `<p class="muted">Aucune anomalie détectée.</p>`
          }
        </div>
      `;
    }

    content.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        tab = btn.getAttribute('data-tab');
        draw();
      });
    });
  }

  await draw();
}

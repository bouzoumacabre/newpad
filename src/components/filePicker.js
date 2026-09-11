// ============================================================================
// Sélecteur de documents NewFiles — composant partagé (§17, §76)
// ============================================================================
// C'est la brique qui matérialise le principe d'interconnexion : quand NewWork,
// NewGov, NewDoc, SACEM ou NewInsurance demandent « Ajouter un document », ils
// n'ouvrent PAS un champ de téléversement — ils ouvrent le coffre de
// l'utilisateur, qui choisit ce qu'il autorise. Un second téléversement créerait
// une copie, et une copie survit à la révocation du partage.

import { escapeHtml, formatDate } from '../lib/format.js';
import { appIconSvg } from '../lib/appIcons.js';
import { listFiles, uploadFile, shareFile, categorieLabel, formatTaille } from '../apps/files/api.js';
import { showAlert } from '../lib/uiDialogs.js';

/**
 * Ouvre le sélecteur et renvoie les documents choisis.
 * @param {object} opts
 *   - title        titre du panneau
 *   - multiple     autoriser plusieurs documents (défaut : true)
 *   - categories   restreindre à certaines catégories
 *   - shareWith    { granteeType, granteeId, note, expiresAt } — si fourni, les
 *                  documents choisis sont automatiquement autorisés pour ce
 *                  destinataire, ce qui est le cas d'usage normal : joindre un
 *                  document à une candidature ou à un dossier.
 * @returns {Promise<Array>} documents choisis (vide si annulé)
 */
export function pickFiles(opts = {}) {
  return new Promise((resolve) => {
    const multiple = opts.multiple !== false;
    const choisis = new Set();
    let fichiers = [];

    const hote = document.querySelector('.app-frame') || document.getElementById('app');
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(opts.title || 'Choisir un document')}</strong>
        <button class="btn btn-ghost" data-close style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">
        <p class="muted" style="font-size:12.5px;margin-bottom:12px;">
          Vos documents restent dans NewFiles. Seule une autorisation de
          consultation est accordée, et vous pouvez la retirer à tout moment.
        </p>
        <label class="btn btn-secondary" style="cursor:pointer;display:block;text-align:center;margin-bottom:12px;">
          + Déposer un nouveau document
          <input type="file" data-upload style="display:none;" />
        </label>
        <div data-list class="app-list"></div>
      </div>
      <div style="padding:12px 16px;border-top:1px solid var(--card-border);display:flex;gap:8px;">
        <button class="btn btn-primary" data-ok style="flex:1;">Joindre</button>
        <button class="btn btn-ghost" data-cancel>Annuler</button>
      </div>`;
    hote.appendChild(el);

    function fermer(resultat) {
      el.remove();
      resolve(resultat);
    }

    async function charger() {
      const zone = el.querySelector('[data-list]');
      zone.innerHTML = '<div class="app-empty">Chargement…</div>';
      try {
        const tous = await listFiles();
        // On ne propose que SES documents : partager ce qu'un tiers vous a
        // confié n'est pas à vous de le décider.
        fichiers = tous.filter((f) => f.owner_id === opts.ownerId);
        if (opts.categories && opts.categories.length) {
          fichiers = fichiers.filter((f) => opts.categories.includes(f.category));
        }
      } catch (e) {
        zone.innerHTML = `<div class="app-empty">Coffre inaccessible : ${escapeHtml(String(e.message || e))}</div>`;
        return;
      }
      if (!fichiers.length) {
        zone.innerHTML = '<div class="app-empty">Aucun document. Déposez-en un ci-dessus.</div>';
        return;
      }
      zone.innerHTML = fichiers.map((f) => `
        <label class="app-row" style="cursor:pointer;padding:9px 11px;">
          <input type="${multiple ? 'checkbox' : 'radio'}" name="nf-pick" value="${f.id}"
                 style="width:auto;margin:0;" ${choisis.has(f.id) ? 'checked' : ''} />
          <span class="app-row-icon">${appIconSvg('folder', 16)}</span>
          <span class="app-row-main">
            <strong>${escapeHtml(f.name)}</strong>
            <small>${escapeHtml(categorieLabel(f.category))}${f.size_bytes ? ' · ' + formatTaille(f.size_bytes) : ''} · ${formatDate(f.created_at)}</small>
          </span>
        </label>`).join('');

      zone.querySelectorAll('input[name="nf-pick"]').forEach((c) => {
        c.addEventListener('change', () => {
          if (!multiple) choisis.clear();
          if (c.checked) choisis.add(c.value); else choisis.delete(c.value);
        });
      });
    }

    el.querySelector('[data-upload]').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      e.target.value = '';
      try {
        const id = await uploadFile(f, { category: (opts.categories && opts.categories[0]) || 'other', sourceApp: opts.sourceApp || 'files' });
        choisis.add(id);
        await charger();
      } catch (err) { await showAlert('Dépôt impossible : ' + (err.message || err)); }
    });

    el.querySelector('[data-ok]').addEventListener('click', async () => {
      const retenus = fichiers.filter((f) => choisis.has(f.id));
      if (!retenus.length) { fermer([]); return; }
      if (opts.shareWith && opts.shareWith.granteeId) {
        try {
          for (const f of retenus) {
            await shareFile(f.id, {
              granteeType: opts.shareWith.granteeType || 'profile',
              granteeId: opts.shareWith.granteeId,
              note: opts.shareWith.note || null,
              expiresAt: opts.shareWith.expiresAt || null,
            });
          }
        } catch (e) {
          await showAlert("Les documents n'ont pas pu être autorisés : " + (e.message || e));
          return;
        }
      }
      fermer(retenus);
    });

    el.querySelector('[data-cancel]').addEventListener('click', () => fermer([]));
    el.querySelector('[data-close]').addEventListener('click', () => fermer([]));

    charger();
  });
}

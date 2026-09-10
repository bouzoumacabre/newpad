// ============================================================================
// NewFiles — le coffre documentaire (§16, §17)
// ============================================================================
// Deux vues : mes documents, et ceux qu'on m'a partagés. Le partage n'envoie
// jamais de copie — il accorde une autorisation, révocable et expirable. C'est
// la différence qui compte : une copie envoyée reste lisible pour toujours,
// même après qu'on a retiré sa confiance.

import { renderAppShell } from '../appShell.js';
import { escapeHtml, formatDate } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { appIconSvg } from '../../lib/appIcons.js';
import {
  listFiles, listPermissions, uploadFile, fileUrl, updateFile, deleteFile,
  shareFile, revokeShare, searchRecipients,
  CATEGORIES, categorieLabel, formatTaille,
} from './api.js';

const ICONE_PAR_CATEGORIE = {
  identity: 'work', bank: 'bank', work: 'briefcase', legal: 'government',
  medical: 'medical', vehicle: 'car', property: 'home', insurance: 'shield',
  music: 'music', business: 'directory', other: 'folder',
};

export async function renderFilesApp(root, profile) {
  let vue = 'mine';
  let categorie = 'all';
  let fichiers = [];

  const { body } = await renderAppShell(root, profile, 'files', {
    tabs: [
      { key: 'mine', label: 'Mes documents' },
      { key: 'shared', label: 'Partagés avec moi' },
    ],
    active: vue,
    onTab: (k) => { vue = k; marquerOnglet(); dessiner(); },
    actions: `
      <label class="btn btn-primary" style="cursor:pointer;padding:6px 14px;font-size:13px;">
        + Déposer
        <input type="file" id="nf-upload" style="display:none;" />
      </label>`,
  });

  function marquerOnglet() {
    document.querySelectorAll('.app-tab').forEach((t) => {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === vue);
    });
  }

  // --------------------------------------------------------------------------
  async function charger() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    try {
      fichiers = await listFiles();
    } catch (e) {
      body.innerHTML = `<div class="app-empty">Le coffre n'a pas pu être ouvert : ${escapeHtml(String(e.message || e))}</div>`;
      return;
    }
    dessiner();
  }

  function dessiner() {
    const miens = fichiers.filter((f) => f.owner_id === profile.id);
    const partages = fichiers.filter((f) => f.owner_id !== profile.id);
    let liste = vue === 'mine' ? miens : partages;
    if (categorie !== 'all') liste = liste.filter((f) => f.category === categorie);

    // Seules les catégories réellement présentes sont proposées : une barre de
    // onze filtres dont neuf ne renvoient rien n'aide personne.
    const presentes = [...new Set((vue === 'mine' ? miens : partages).map((f) => f.category))];

    body.innerHTML = `
      <div class="app-toolbar">
        <div class="app-chipset">
          <button class="app-chip ${categorie === 'all' ? 'is-active' : ''}" data-cat="all">Tout (${(vue === 'mine' ? miens : partages).length})</button>
          ${presentes.map((c) => `<button class="app-chip ${categorie === c ? 'is-active' : ''}" data-cat="${c}">${escapeHtml(categorieLabel(c))}</button>`).join('')}
        </div>
      </div>
      ${liste.length ? `<div class="app-list">${liste.map(ligne).join('')}</div>` : `
        <div class="app-empty">
          ${vue === 'mine'
            ? 'Votre coffre est vide. Déposez un document : il sera utilisable par les autres applications sans jamais être dupliqué.'
            : 'Personne ne vous a encore partagé de document.'}
        </div>`}
    `;

    body.querySelectorAll('[data-cat]').forEach((b) => {
      b.addEventListener('click', () => { categorie = b.getAttribute('data-cat'); dessiner(); });
    });
    body.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => ouvrir(b.getAttribute('data-open'))));
    body.querySelectorAll('[data-share]').forEach((b) => b.addEventListener('click', () => panneauPartage(b.getAttribute('data-share'))));
    body.querySelectorAll('[data-rename]').forEach((b) => b.addEventListener('click', () => renommer(b.getAttribute('data-rename'))));
    body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => supprimer(b.getAttribute('data-del'))));
  }

  function ligne(f) {
    const aMoi = f.owner_id === profile.id;
    return `
      <div class="app-row">
        <span class="app-row-icon">${appIconSvg(ICONE_PAR_CATEGORIE[f.category] || 'folder', 18)}</span>
        <span class="app-row-main">
          <strong>${escapeHtml(f.name)}</strong>
          <small>
            ${escapeHtml(categorieLabel(f.category))}
            ${f.size_bytes ? ' · ' + formatTaille(f.size_bytes) : ''}
            · ${formatDate(f.created_at)}
            ${f.description ? ' · ' + escapeHtml(f.description) : ''}
          </small>
        </span>
        <span class="app-row-actions">
          <button class="btn btn-secondary" data-open="${f.id}">Ouvrir</button>
          ${aMoi ? `
            <button class="btn btn-ghost" data-share="${f.id}">Partager</button>
            <button class="btn btn-ghost" data-rename="${f.id}" title="Renommer">✎</button>
            <button class="btn btn-ghost" data-del="${f.id}" title="Supprimer">✕</button>` : ''}
        </span>
      </div>`;
  }

  // --------------------------------------------------------------------------
  async function ouvrir(id) {
    const f = fichiers.find((x) => x.id === id);
    if (!f) return;
    try {
      const url = await fileUrl(f.storage_path);
      // Le navigateur intégré de FiveM bloque silencieusement l'ouverture d'un
      // onglet externe. On tente quand même, et on affiche le lien en repli
      // pour que le joueur puisse le copier — même solution que pour Discord.
      const w = window.open(url, '_blank', 'noopener');
      if (!w) await showAlert('Lien du document (valable 5 minutes) :\n\n' + url);
    } catch (e) {
      await showAlert("Impossible d'ouvrir ce document : " + (e.message || e));
    }
  }

  async function renommer(id) {
    const f = fichiers.find((x) => x.id === id);
    if (!f) return;
    panneau(`
      <div class="field"><label for="nf-name">Nom</label>
        <input id="nf-name" value="${escapeHtml(f.name)}" maxlength="120" /></div>
      <div class="field"><label for="nf-cat">Catégorie</label>
        <select id="nf-cat">${CATEGORIES.map(([v, l]) =>
          `<option value="${v}" ${f.category === v ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select></div>
      <div class="field"><label for="nf-desc">Description</label>
        <input id="nf-desc" value="${escapeHtml(f.description || '')}" maxlength="200" /></div>
      <button class="btn btn-primary" id="nf-save" style="width:100%;">Enregistrer</button>
    `, 'Modifier le document', () => {
      document.getElementById('nf-save').addEventListener('click', async () => {
        try {
          await updateFile(id, {
            name: document.getElementById('nf-name').value,
            category: document.getElementById('nf-cat').value,
            description: document.getElementById('nf-desc').value,
          });
          fermerPanneau();
          await charger();
        } catch (e) { await showAlert('Échec : ' + (e.message || e)); }
      });
    });
  }

  async function supprimer(id) {
    const f = fichiers.find((x) => x.id === id);
    if (!f) return;
    if (!(await showConfirm(`Supprimer « ${f.name} » ? Les partages en cours seront retirés.`))) return;
    try {
      await deleteFile(id);
      await charger();
    } catch (e) { await showAlert('Suppression impossible : ' + (e.message || e)); }
  }

  // --------------------------------------------------------------------------
  // Partage
  // --------------------------------------------------------------------------
  async function panneauPartage(id) {
    const f = fichiers.find((x) => x.id === id);
    if (!f) return;

    panneau(`
      <p class="muted" style="font-size:12.5px;margin-bottom:14px;">
        Le document n'est pas envoyé : la personne reçoit une autorisation de
        consultation, que vous pouvez retirer à tout moment.
      </p>
      <div class="field"><label for="nf-who">Destinataire</label>
        <input id="nf-who" placeholder="Nom ou identifiant" autocomplete="off" />
        <div id="nf-results" class="app-list" style="margin-top:6px;"></div>
      </div>
      <div class="field"><label for="nf-exp">Expire le (facultatif)</label>
        <input id="nf-exp" type="date" /></div>
      <div class="field"><label for="nf-note">Motif (facultatif)</label>
        <input id="nf-note" maxlength="120" placeholder="Ex : candidature vendeur" /></div>
      <hr style="border:0;border-top:1px solid var(--card-border);margin:16px 0;" />
      <strong style="font-size:13px;color:var(--ivory);">Partages en cours</strong>
      <div id="nf-perms" class="app-list" style="margin-top:8px;"></div>
    `, 'Partager « ' + f.name + ' »', () => {
      const champ = document.getElementById('nf-who');
      const zone = document.getElementById('nf-results');
      let minuteur = null;

      champ.addEventListener('input', () => {
        clearTimeout(minuteur);
        // Une requête par frappe saturerait la base pour rien : on attend une
        // pause avant de chercher.
        minuteur = setTimeout(async () => {
          const q = champ.value.trim();
          if (q.length < 2) { zone.innerHTML = ''; return; }
          try {
            const r = await searchRecipients(q);
            zone.innerHTML = r.length
              ? r.map((p) => `
                <div class="app-row" style="padding:7px 10px;cursor:pointer;" data-pick="${p.id}">
                  <span class="app-row-main"><strong>${escapeHtml(p.display_name)}</strong>
                    <small>${escapeHtml(p.username)}</small></span>
                </div>`).join('')
              : '<div class="muted" style="font-size:12.5px;">Aucun résultat.</div>';
            zone.querySelectorAll('[data-pick]').forEach((el) => {
              el.addEventListener('click', async () => {
                const exp = document.getElementById('nf-exp').value;
                try {
                  await shareFile(id, {
                    granteeId: el.getAttribute('data-pick'),
                    expiresAt: exp ? new Date(exp + 'T23:59:59').toISOString() : null,
                    note: document.getElementById('nf-note').value || null,
                  });
                  champ.value = ''; zone.innerHTML = '';
                  await listerPermissions(id);
                } catch (e) { await showAlert('Partage impossible : ' + (e.message || e)); }
              });
            });
          } catch (_) { zone.innerHTML = ''; }
        }, 280);
      });

      listerPermissions(id);
    });
  }

  async function listerPermissions(fileId) {
    const zone = document.getElementById('nf-perms');
    if (!zone) return;
    let perms = [];
    try { perms = await listPermissions(fileId); } catch (_) { /* liste vide */ }
    if (!perms.length) {
      zone.innerHTML = '<div class="muted" style="font-size:12.5px;">Ce document n\'est partagé avec personne.</div>';
      return;
    }
    // Le nom du destinataire n'est pas lisible directement (un joueur ne peut
    // pas parcourir les profils des autres) : on affiche ce qu'on sait, et le
    // motif saisi au partage sert de repère.
    zone.innerHTML = perms.map((p) => `
      <div class="app-row" style="padding:8px 10px;">
        <span class="app-row-main">
          <strong>${p.grantee_type === 'organization' ? 'Organisation' : 'Personne'}</strong>
          <small>
            ${p.note ? escapeHtml(p.note) + ' · ' : ''}
            ${p.expires_at ? 'expire le ' + formatDate(p.expires_at) : 'sans expiration'}
          </small>
        </span>
        <span class="app-row-actions">
          <button class="btn btn-ghost" data-revoke="${p.grantee_type}|${p.grantee_id}">Retirer</button>
        </span>
      </div>`).join('');

    zone.querySelectorAll('[data-revoke]').forEach((b) => {
      b.addEventListener('click', async () => {
        const [type, gid] = b.getAttribute('data-revoke').split('|');
        try {
          await revokeShare(fileId, type, gid);
          await listerPermissions(fileId);
        } catch (e) { await showAlert('Retrait impossible : ' + (e.message || e)); }
      });
    });
  }

  // --------------------------------------------------------------------------
  function panneau(html, titre, apres) {
    fermerPanneau();
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.id = 'nf-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(titre)}</strong>
        <button class="btn btn-ghost" id="nf-close" style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">${html}</div>`;
    document.querySelector('.app-frame').appendChild(el);
    document.getElementById('nf-close').addEventListener('click', fermerPanneau);
    if (apres) apres();
  }

  function fermerPanneau() {
    document.getElementById('nf-panel')?.remove();
  }

  // --------------------------------------------------------------------------
  document.getElementById('nf-upload')?.addEventListener('change', async (e) => {
    const fichier = e.target.files && e.target.files[0];
    if (!fichier) return;
    e.target.value = '';
    body.innerHTML = '<div class="app-empty">Dépôt en cours…</div>';
    try {
      await uploadFile(fichier, { category: 'other' });
      await charger();
    } catch (err) {
      await showAlert('Dépôt impossible : ' + (err.message || err));
      await charger();
    }
  });

  await charger();
}

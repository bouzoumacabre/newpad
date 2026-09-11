// ============================================================================
// NewMail — messagerie interne (§40)
// ============================================================================
// Les pièces jointes sont des documents de NewFiles, pas des fichiers envoyés :
// le destinataire reçoit une autorisation de consultation. Retirer cette
// autorisation depuis le coffre coupe l'accès, y compris sur un message déjà
// reçu. C'est la différence entre confier un document et s'en dessaisir.

import { renderAppShell } from '../appShell.js';
import { escapeHtml, formatDateTime } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { appIconSvg } from '../../lib/appIcons.js';
import { searchProfiles } from '../../lib/newpadApi.js';
import { pickFiles } from '../../components/filePicker.js';
import { fileUrl } from '../files/api.js';
import {
  DOSSIERS, listMail, getMail, sendMail, setFolder, markRead,
  listDrafts, saveDraft, deleteDraft,
} from './api.js';

export async function renderMailApp(root, profile) {
  let dossier = 'inbox';
  let messages = [];

  const { body } = await renderAppShell(root, profile, 'mail', {
    tabs: DOSSIERS.map(([key, label]) => ({ key, label })),
    active: dossier,
    onTab: (k) => { dossier = k; marquerOnglet(); charger(); },
    actions: '<button class="btn btn-primary" id="nm-new" style="padding:6px 14px;font-size:13px;">+ Écrire</button>',
  });

  function marquerOnglet() {
    document.querySelectorAll('.app-tab').forEach((t) => {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === dossier);
    });
  }

  // --------------------------------------------------------------------------
  async function charger() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    try {
      messages = dossier === 'drafts' ? await listDrafts() : await listMail(dossier);
    } catch (e) {
      body.innerHTML = `<div class="app-empty">Messagerie indisponible : ${escapeHtml(String(e.message || e))}</div>`;
      return;
    }
    dessiner();
  }

  function dessiner() {
    if (!messages.length) {
      const vide = {
        inbox: 'Aucun message reçu.',
        sent: "Vous n'avez encore rien envoyé.",
        drafts: 'Aucun brouillon.',
        archive: 'Aucun message archivé.',
        trash: 'La corbeille est vide.',
      }[dossier];
      body.innerHTML = `<div class="app-empty">${escapeHtml(vide)}</div>`;
      return;
    }

    body.innerHTML = `<div class="app-list">${messages.map(
      dossier === 'drafts' ? ligneBrouillon : ligneMessage
    ).join('')}</div>`;

    body.querySelectorAll('[data-open]').forEach((el) => {
      el.addEventListener('click', () => ouvrir(el.getAttribute('data-open')));
    });
    body.querySelectorAll('[data-draft]').forEach((el) => {
      el.addEventListener('click', () => {
        const d = messages.find((m) => m.id === el.getAttribute('data-draft'));
        composer(d);
      });
    });
    body.querySelectorAll('[data-move]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const [id, cible] = el.getAttribute('data-move').split('|');
        try { await setFolder(id, cible); await charger(); }
        catch (err) { await showAlert('Déplacement impossible : ' + (err.message || err)); }
      });
    });
    body.querySelectorAll('[data-drop]').forEach((el) => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await showConfirm('Supprimer ce brouillon ?'))) return;
        try { await deleteDraft(el.getAttribute('data-drop')); await charger(); }
        catch (err) { await showAlert('Suppression impossible : ' + (err.message || err)); }
      });
    });
  }

  function ligneMessage(m) {
    const nonLu = dossier === 'inbox' && !m.is_read;
    // Dans « Envoyés », c'est le destinataire qui compte, pas soi-même.
    const qui = dossier === 'sent' ? (m.destinataires || '—') : m.sender_name;
    return `
      <div class="app-row" style="cursor:pointer;" data-open="${m.id}">
        <span class="app-row-icon" style="${nonLu ? 'color:var(--gold);' : ''}">
          ${appIconSvg('mail', 17)}
        </span>
        <span class="app-row-main">
          <strong style="${nonLu ? '' : 'font-weight:500;'}">${escapeHtml(m.subject)}</strong>
          <small>
            ${escapeHtml(qui || '')} · ${formatDateTime(m.created_at)}
            ${m.nb_pieces ? ' · ' + m.nb_pieces + ' pièce' + (m.nb_pieces > 1 ? 's' : '') + ' jointe' + (m.nb_pieces > 1 ? 's' : '') : ''}
          </small>
        </span>
        ${nonLu ? '<span class="badge badge-pending">non lu</span>' : ''}
        <span class="app-row-actions">
          ${dossier === 'inbox' ? `<button class="btn btn-ghost" data-move="${m.id}|archive" title="Archiver">⌸</button>` : ''}
          ${dossier === 'archive' ? `<button class="btn btn-ghost" data-move="${m.id}|inbox" title="Remettre en réception">↩</button>` : ''}
          ${dossier !== 'trash' ? `<button class="btn btn-ghost" data-move="${m.id}|trash" title="Corbeille">✕</button>`
            : `<button class="btn btn-ghost" data-move="${m.id}|inbox" title="Restaurer">↩</button>`}
        </span>
      </div>`;
  }

  function ligneBrouillon(d) {
    return `
      <div class="app-row" style="cursor:pointer;" data-draft="${d.id}">
        <span class="app-row-icon">${appIconSvg('mail', 17)}</span>
        <span class="app-row-main">
          <strong style="font-weight:500;">${escapeHtml(d.subject || '(sans objet)')}</strong>
          <small>Modifié le ${formatDateTime(d.updated_at)}</small>
        </span>
        <span class="app-row-actions">
          <button class="btn btn-ghost" data-drop="${d.id}" title="Supprimer">✕</button>
        </span>
      </div>`;
  }

  // --------------------------------------------------------------------------
  // Lecture
  // --------------------------------------------------------------------------
  async function ouvrir(id) {
    let m;
    try { m = await getMail(id); } catch (e) { await showAlert(String(e.message || e)); return; }
    if (!m) return;

    if (dossier === 'inbox') markRead(id, true).then(charger).catch(() => {});

    panneau(`
      <div style="margin-bottom:14px;">
        <div class="muted" style="font-size:12px;">
          De <strong style="color:var(--ivory);">${escapeHtml(m.sender_name)}</strong>
          · ${formatDateTime(m.created_at)}
        </div>
        <div class="muted" style="font-size:12px;">
          À ${escapeHtml((m.destinataires || []).map((d) => d.nom).join(', '))}
        </div>
      </div>
      <div style="white-space:pre-wrap;font-size:13.5px;line-height:1.6;color:var(--text);">${escapeHtml(m.body)}</div>
      ${(m.pieces || []).length ? `
        <hr style="border:0;border-top:1px solid var(--card-border);margin:16px 0;" />
        <strong style="font-size:13px;color:var(--ivory);">Pièces jointes</strong>
        <div class="app-list" style="margin-top:8px;">
          ${m.pieces.map((p) => `
            <div class="app-row" style="padding:8px 10px;">
              <span class="app-row-icon">${appIconSvg('folder', 15)}</span>
              <span class="app-row-main">
                <strong>${escapeHtml(p.nom)}</strong>
                ${p.accessible ? '' : '<small class="text-danger">Accès retiré par l&rsquo;expéditeur</small>'}
              </span>
              ${p.accessible
                ? `<span class="app-row-actions"><button class="btn btn-secondary" data-piece="${escapeHtml(p.storage_path)}">Ouvrir</button></span>`
                : ''}
            </div>`).join('')}
        </div>` : ''}
      <hr style="border:0;border-top:1px solid var(--card-border);margin:16px 0;" />
      <button class="btn btn-primary" id="nm-reply" style="width:100%;">Répondre</button>
    `, m.subject, () => {
      document.getElementById('nm-reply').addEventListener('click', () => {
        composer({
          to_profile_id: m.sender_id,
          to_name: m.sender_name,
          subject: m.subject.startsWith('Re : ') ? m.subject : 'Re : ' + m.subject,
          body: '\n\n— — —\n' + m.body,
        });
      });
      document.querySelectorAll('[data-piece]').forEach((b) => {
        b.addEventListener('click', async () => {
          try {
            const url = await fileUrl(b.getAttribute('data-piece'));
            const w = window.open(url, '_blank', 'noopener');
            if (!w) await showAlert('Lien du document (valable 5 minutes) :\n\n' + url);
          } catch (e) { await showAlert("Impossible d'ouvrir ce document : " + (e.message || e)); }
        });
      });
    });
  }

  // --------------------------------------------------------------------------
  // Rédaction
  // --------------------------------------------------------------------------
  function composer(pre = {}) {
    let destinataire = pre.to_profile_id ? { id: pre.to_profile_id, nom: pre.to_name || 'destinataire' } : null;
    let piecesJointes = [];
    let idBrouillon = pre.id || null;

    panneau(`
      <div class="field"><label for="nm-to">Destinataire</label>
        <input id="nm-to" placeholder="Nom ou identifiant" autocomplete="off"
               value="${destinataire ? escapeHtml(destinataire.nom) : ''}" />
        <div id="nm-results" class="app-list" style="margin-top:6px;"></div>
      </div>
      <div class="field"><label for="nm-subject">Objet</label>
        <input id="nm-subject" maxlength="150" value="${escapeHtml(pre.subject || '')}" /></div>
      <div class="field"><label for="nm-body">Message</label>
        <textarea id="nm-body" rows="9" maxlength="10000">${escapeHtml(pre.body || '')}</textarea></div>
      <div class="field">
        <button class="btn btn-secondary" id="nm-attach" style="width:100%;">Joindre un document</button>
        <div id="nm-pieces" class="app-list" style="margin-top:6px;"></div>
        <div class="muted" style="font-size:12px;margin-top:6px;">
          Le document reste dans votre coffre : le destinataire reçoit une autorisation,
          que vous pouvez retirer depuis NewFiles.
        </div>
      </div>
      <div class="flex items-center gap-sm">
        <button class="btn btn-primary" id="nm-send" style="flex:1;">Envoyer</button>
        <button class="btn btn-ghost" id="nm-draft">Brouillon</button>
      </div>
      <div class="muted" id="nm-msg" style="font-size:12.5px;margin-top:10px;"></div>
    `, 'Nouveau message', () => {
      const champ = document.getElementById('nm-to');
      const zone = document.getElementById('nm-results');
      let minuteur = null;

      champ.addEventListener('input', () => {
        destinataire = null;
        clearTimeout(minuteur);
        minuteur = setTimeout(async () => {
          const q = champ.value.trim();
          if (q.length < 2) { zone.innerHTML = ''; return; }
          let r = [];
          try { r = await searchProfiles(q); } catch (_) { /* liste vide */ }
          zone.innerHTML = r.length
            ? r.map((p) => `<div class="app-row" style="padding:7px 10px;cursor:pointer;" data-pick="${p.id}" data-nom="${escapeHtml(p.display_name)}">
                <span class="app-row-main"><strong>${escapeHtml(p.display_name)}</strong>
                  <small>${escapeHtml(p.username)}</small></span></div>`).join('')
            : '<div class="muted" style="font-size:12.5px;">Aucun résultat.</div>';
          zone.querySelectorAll('[data-pick]').forEach((n) => {
            n.addEventListener('click', () => {
              destinataire = { id: n.getAttribute('data-pick'), nom: n.getAttribute('data-nom') };
              champ.value = destinataire.nom;
              zone.innerHTML = '';
            });
          });
        }, 280);
      });

      document.getElementById('nm-attach').addEventListener('click', async () => {
        const choisis = await pickFiles({
          title: 'Joindre depuis NewFiles',
          ownerId: profile.id,
          sourceApp: 'mail',
          // Pas de partage automatique ici : l'autorisation est accordée à
          // l'envoi, quand on sait enfin à qui. L'accorder au moment du choix
          // laisserait un accès ouvert à un message jamais envoyé.
        });
        piecesJointes = piecesJointes.concat(choisis.filter((c) => !piecesJointes.some((p) => p.id === c.id)));
        rendrePieces();
      });

      function rendrePieces() {
        const z = document.getElementById('nm-pieces');
        z.innerHTML = piecesJointes.map((p) => `
          <div class="app-row" style="padding:6px 10px;">
            <span class="app-row-main"><strong>${escapeHtml(p.name)}</strong></span>
            <span class="app-row-actions"><button class="btn btn-ghost" data-rm="${p.id}">✕</button></span>
          </div>`).join('');
        z.querySelectorAll('[data-rm]').forEach((b) => {
          b.addEventListener('click', () => {
            piecesJointes = piecesJointes.filter((p) => p.id !== b.getAttribute('data-rm'));
            rendrePieces();
          });
        });
      }

      document.getElementById('nm-send').addEventListener('click', async () => {
        const msg = document.getElementById('nm-msg');
        if (!destinataire) { msg.textContent = 'Choisissez un destinataire dans la liste.'; return; }
        msg.textContent = 'Envoi…';
        try {
          await sendMail({
            to: [destinataire.id],
            subject: document.getElementById('nm-subject').value,
            body: document.getElementById('nm-body').value,
            fileIds: piecesJointes.map((p) => p.id),
          });
          if (idBrouillon) await deleteDraft(idBrouillon).catch(() => {});
          fermerPanneau();
          dossier = 'sent'; marquerOnglet(); await charger();
        } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
      });

      document.getElementById('nm-draft').addEventListener('click', async () => {
        try {
          idBrouillon = await saveDraft({
            id: idBrouillon,
            toProfileId: destinataire ? destinataire.id : null,
            subject: document.getElementById('nm-subject').value,
            body: document.getElementById('nm-body').value,
          });
          fermerPanneau();
          dossier = 'drafts'; marquerOnglet(); await charger();
        } catch (e) { await showAlert('Brouillon non enregistré : ' + (e.message || e)); }
      });
    });
  }

  // --------------------------------------------------------------------------
  function panneau(html, titre, apres) {
    fermerPanneau();
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.id = 'nm-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(titre)}</strong>
        <button class="btn btn-ghost" id="nm-close" style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">${html}</div>`;
    document.querySelector('.app-frame').appendChild(el);
    document.getElementById('nm-close').addEventListener('click', fermerPanneau);
    if (apres) apres();
  }

  function fermerPanneau() { document.getElementById('nm-panel')?.remove(); }

  document.getElementById('nm-new')?.addEventListener('click', () => composer());

  await charger();
}

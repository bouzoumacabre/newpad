// ============================================================================
// NewWork — emploi et réseau professionnel (§39)
// ============================================================================
// Trois briques déjà posées se rejoignent ici : les entreprises viennent de
// NewPro, les CV de NewFiles, et l'autorisation d'un document à une
// ORGANISATION existait déjà dans le coffre. Postuler ne duplique donc rien —
// le candidat autorise l'entreprise à consulter son CV, et peut retirer cette
// autorisation une fois le recrutement passé.

import { renderAppShell } from '../appShell.js';
import { escapeHtml, formatDate, formatDateTime } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { appIconSvg } from '../../lib/appIcons.js';
import { pickFiles } from '../../components/filePicker.js';
import { myOrganizations, ICONE_PAR_GENRE } from '../organizations/api.js';
import { fileUrl } from '../files/api.js';
import {
  CONTRATS, STATUTS, contratLabel, listOffers, publishOffer, closeOffer,
  apply, myApplications, offerApplications, applicantFiles, decide,
  orgOffers, myWorkProfile, saveWorkProfile,
} from './api.js';

export async function renderWorkApp(root, profile) {
  let onglet = 'offres';
  let recherche = '';
  let mesOrgs = [];

  // Seule la direction d'une entreprise voit l'onglet Recrutement : l'afficher
  // vide à tout le monde donnerait l'impression d'une fonctionnalité cassée.
  try { mesOrgs = (await myOrganizations()).filter((o) => o.member_role !== 'member'); }
  catch (_) { mesOrgs = []; }

  const onglets = [
    { key: 'offres', label: 'Offres' },
    { key: 'candidatures', label: 'Mes candidatures' },
  ];
  if (mesOrgs.length) onglets.push({ key: 'recrutement', label: 'Recrutement' });
  onglets.push({ key: 'profil', label: 'Mon profil' });

  const { body } = await renderAppShell(root, profile, 'work', {
    tabs: onglets,
    active: onglet,
    onTab: (k) => { onglet = k; marquerOnglet(); rendre(); },
  });

  function marquerOnglet() {
    document.querySelectorAll('.app-tab').forEach((t) => {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === onglet);
    });
  }

  function rendre() {
    if (onglet === 'offres') vueOffres();
    else if (onglet === 'candidatures') vueCandidatures();
    else if (onglet === 'recrutement') vueRecrutement();
    else vueProfil();
  }

  // --------------------------------------------------------------------------
  async function vueOffres() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let offres = [];
    try { offres = await listOffers(recherche || null); }
    catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    body.innerHTML = `
      <div class="app-toolbar">
        <input id="nw-q" placeholder="Métier, entreprise, quartier…" value="${escapeHtml(recherche)}"
               style="flex:1;min-width:220px;margin:0;" />
      </div>
      ${offres.length ? `<div class="app-list">${offres.map(ligneOffre).join('')}</div>`
        : '<div class="app-empty">Aucune offre à pourvoir pour le moment.</div>'}
    `;

    const champ = document.getElementById('nw-q');
    let minuteur = null;
    champ.addEventListener('input', () => {
      clearTimeout(minuteur);
      minuteur = setTimeout(() => { recherche = champ.value; vueOffres(); }, 300);
    });

    body.querySelectorAll('[data-apply]').forEach((b) => {
      b.addEventListener('click', () => panneauCandidature(offres.find((o) => o.id === b.getAttribute('data-apply'))));
    });
  }

  function ligneOffre(o) {
    const deja = o.ma_candidature;
    const [libelle, classe] = STATUTS[deja] || [];
    return `
      <div class="app-row" style="align-items:flex-start;">
        <span class="app-row-icon">${appIconSvg(ICONE_PAR_GENRE[o.org_kind] || 'briefcase', 17)}</span>
        <span class="app-row-main">
          <strong>${escapeHtml(o.title)}</strong>
          <small>
            ${escapeHtml(o.organisation)} · ${escapeHtml(contratLabel(o.contract_type))}
            ${o.compensation ? ' · ' + escapeHtml(o.compensation) : ''}
            ${o.location ? ' · ' + escapeHtml(o.location) : ''}
            · ${formatDate(o.created_at)}
          </small>
          <span style="font-size:12.5px;color:var(--text-muted);margin-top:5px;
                       display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">
            ${escapeHtml(o.description)}
          </span>
        </span>
        ${deja ? `<span class="badge ${classe}">${escapeHtml(libelle)}</span>`
          : `<span class="app-row-actions"><button class="btn btn-primary" data-apply="${o.id}">Postuler</button></span>`}
      </div>`;
  }

  function panneauCandidature(o) {
    if (!o) return;
    let documents = [];
    panneau(o.title, `
      <div class="muted" style="font-size:12.5px;margin-bottom:12px;">
        ${escapeHtml(o.organisation)} · ${escapeHtml(contratLabel(o.contract_type))}
        ${o.location ? ' · ' + escapeHtml(o.location) : ''}
      </div>
      <div style="white-space:pre-wrap;font-size:13px;line-height:1.6;margin-bottom:16px;">${escapeHtml(o.description)}</div>
      <div class="field"><label for="nw-msg">Votre message</label>
        <textarea id="nw-msg" rows="5" maxlength="2000" placeholder="Pourquoi vous ?"></textarea></div>
      <div class="field">
        <button class="btn btn-secondary" id="nw-cv" style="width:100%;">Joindre un CV depuis NewFiles</button>
        <div id="nw-docs" class="app-list" style="margin-top:6px;"></div>
        <div class="muted" style="font-size:12px;margin-top:6px;">
          Vos documents restent dans votre coffre. L'entreprise reçoit une autorisation
          de consultation, que vous pourrez retirer une fois le recrutement passé.
        </div>
      </div>
      <button class="btn btn-primary" id="nw-send" style="width:100%;">Envoyer ma candidature</button>
      <div class="muted" id="nw-msg2" style="font-size:12.5px;margin-top:10px;"></div>
    `, () => {
      document.getElementById('nw-cv').addEventListener('click', async () => {
        const choisis = await pickFiles({
          title: 'Joindre depuis NewFiles',
          ownerId: profile.id,
          categories: ['work', 'identity', 'legal', 'other'],
          sourceApp: 'work',
        });
        documents = documents.concat(choisis.filter((c) => !documents.some((d) => d.id === c.id)));
        rendreDocs();
      });

      function rendreDocs() {
        const z = document.getElementById('nw-docs');
        z.innerHTML = documents.map((d) => `
          <div class="app-row" style="padding:6px 10px;">
            <span class="app-row-main"><strong>${escapeHtml(d.name)}</strong></span>
            <span class="app-row-actions"><button class="btn btn-ghost" data-rm="${d.id}">✕</button></span>
          </div>`).join('');
        z.querySelectorAll('[data-rm]').forEach((b) => {
          b.addEventListener('click', () => {
            documents = documents.filter((d) => d.id !== b.getAttribute('data-rm'));
            rendreDocs();
          });
        });
      }

      document.getElementById('nw-send').addEventListener('click', async () => {
        const msg = document.getElementById('nw-msg2');
        msg.textContent = 'Envoi…';
        try {
          await apply(o.id, document.getElementById('nw-msg').value, documents.map((d) => d.id));
          fermerPanneau();
          onglet = 'candidatures'; marquerOnglet(); rendre();
        } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
      });
    });
  }

  // --------------------------------------------------------------------------
  async function vueCandidatures() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let lignes = [];
    try { lignes = await myApplications(); }
    catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    body.innerHTML = lignes.length
      ? `<div class="app-list">${lignes.map((a) => {
          const [libelle, classe] = STATUTS[a.status] || ['—', 'badge-neutral'];
          return `
            <div class="app-row" style="align-items:flex-start;">
              <span class="app-row-icon">${appIconSvg('work', 17)}</span>
              <span class="app-row-main">
                <strong>${escapeHtml(a.titre)}</strong>
                <small>${escapeHtml(a.organisation)} · envoyée le ${formatDate(a.created_at)}</small>
                ${a.decision_note ? `<span style="font-size:12.5px;color:var(--text);margin-top:5px;">« ${escapeHtml(a.decision_note)} »</span>` : ''}
              </span>
              <span class="badge ${classe}">${escapeHtml(libelle)}</span>
            </div>`;
        }).join('')}</div>`
      : '<div class="app-empty">Vous n\'avez pas encore postulé.</div>';
  }

  // --------------------------------------------------------------------------
  async function vueRecrutement() {
    let org = mesOrgs[0];
    body.innerHTML = `
      ${mesOrgs.length > 1 ? `<div class="app-toolbar"><div class="app-chipset">
        ${mesOrgs.map((o) => `<button class="app-chip" data-o="${o.id}">${escapeHtml(o.name)}</button>`).join('')}
      </div></div>` : ''}
      <button class="btn btn-primary" id="nw-new" style="margin-bottom:12px;">+ Publier une offre</button>
      <div id="nw-offers"></div>`;

    body.querySelectorAll('[data-o]').forEach((b) => {
      b.addEventListener('click', () => { org = mesOrgs.find((o) => o.id === b.getAttribute('data-o')); charger(); });
    });
    document.getElementById('nw-new').addEventListener('click', () => panneauOffre(org));

    async function charger() {
      const zone = document.getElementById('nw-offers');
      zone.innerHTML = '<div class="app-empty">Chargement…</div>';
      let offres = [];
      try { offres = await orgOffers(org.id); }
      catch (e) { zone.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

      zone.innerHTML = offres.length
        ? `<div class="app-list">${offres.map((o) => `
            <div class="app-row">
              <span class="app-row-icon">${appIconSvg('briefcase', 17)}</span>
              <span class="app-row-main">
                <strong>${escapeHtml(o.title)}</strong>
                <small>${escapeHtml(contratLabel(o.contract_type))}${o.location ? ' · ' + escapeHtml(o.location) : ''} · ${formatDate(o.created_at)}</small>
              </span>
              ${o.is_open ? '<span class="badge badge-success">ouverte</span>' : '<span class="badge badge-neutral">fermée</span>'}
              <span class="app-row-actions">
                <button class="btn btn-secondary" data-cands="${o.id}">Candidatures</button>
                <button class="btn btn-ghost" data-toggle="${o.id}|${o.is_open ? '0' : '1'}">${o.is_open ? 'Fermer' : 'Rouvrir'}</button>
              </span>
            </div>`).join('')}</div>`
        : '<div class="app-empty">Aucune offre publiée.</div>';

      zone.querySelectorAll('[data-cands]').forEach((b) => {
        b.addEventListener('click', () => panneauCandidatures(b.getAttribute('data-cands')));
      });
      zone.querySelectorAll('[data-toggle]').forEach((b) => {
        b.addEventListener('click', async () => {
          const [id, ouvrir] = b.getAttribute('data-toggle').split('|');
          try { await closeOffer(id, ouvrir === '1'); await charger(); }
          catch (e) { await showAlert('Échec : ' + (e.message || e)); }
        });
      });
    }

    await charger();
  }

  function panneauOffre(org) {
    panneau('Nouvelle offre', `
      <div class="muted" style="font-size:12.5px;margin-bottom:12px;">Pour ${escapeHtml(org.name)}</div>
      <div class="field"><label for="nw-t">Intitulé du poste</label><input id="nw-t" maxlength="120" /></div>
      <div class="field"><label for="nw-d">Description</label><textarea id="nw-d" rows="6" maxlength="4000"></textarea></div>
      <div class="grid" style="grid-template-columns:1fr 1fr;">
        <div class="field"><label for="nw-c">Type</label>
          <select id="nw-c">${CONTRATS.map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('')}</select></div>
        <div class="field"><label for="nw-p">Rémunération</label><input id="nw-p" maxlength="60" placeholder="Ex : 3 500 $ / semaine" /></div>
      </div>
      <div class="field"><label for="nw-l">Lieu</label><input id="nw-l" maxlength="120" /></div>
      <button class="btn btn-primary" id="nw-pub" style="width:100%;">Publier</button>
      <div class="muted" id="nw-pub-msg" style="font-size:12.5px;margin-top:10px;"></div>
    `, () => {
      document.getElementById('nw-pub').addEventListener('click', async () => {
        const msg = document.getElementById('nw-pub-msg');
        msg.textContent = 'Publication…';
        try {
          await publishOffer({
            organizationId: org.id,
            title: document.getElementById('nw-t').value,
            description: document.getElementById('nw-d').value,
            contractType: document.getElementById('nw-c').value,
            compensation: document.getElementById('nw-p').value,
            location: document.getElementById('nw-l').value,
          });
          fermerPanneau();
          vueRecrutement();
        } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
      });
    });
  }

  async function panneauCandidatures(offerId) {
    let lignes = [];
    try { lignes = await offerApplications(offerId); }
    catch (e) { await showAlert(String(e.message || e)); return; }

    panneau('Candidatures (' + lignes.length + ')', lignes.length
      ? `<div class="app-list">${lignes.map((a) => {
          const [libelle, classe] = STATUTS[a.status] || ['—', 'badge-neutral'];
          return `
            <div class="app-row" style="align-items:flex-start;flex-wrap:wrap;">
              <span class="app-row-main">
                <strong>${escapeHtml(a.display_name)}</strong>
                <small>${escapeHtml(a.headline || a.username)} · ${formatDateTime(a.created_at)}
                  ${a.nb_documents ? ' · ' + a.nb_documents + ' document' + (a.nb_documents > 1 ? 's' : '') : ''}</small>
                ${a.message ? `<span style="font-size:12.5px;color:var(--text);margin-top:5px;white-space:pre-wrap;">${escapeHtml(a.message)}</span>` : ''}
              </span>
              <span class="badge ${classe}">${escapeHtml(libelle)}</span>
              <span class="app-row-actions" style="width:100%;margin-top:8px;">
                ${a.nb_documents ? `<button class="btn btn-ghost" data-docs="${a.id}">Documents</button>` : ''}
                <button class="btn btn-ghost" data-st="${a.id}|interview">Entretien</button>
                <button class="btn btn-secondary" data-st="${a.id}|accepted">Accepter</button>
                <button class="btn btn-ghost" data-st="${a.id}|rejected">Refuser</button>
              </span>
            </div>`;
        }).join('')}</div>`
      : '<div class="app-empty">Aucune candidature.</div>', () => {
      document.querySelectorAll('[data-st]').forEach((b) => {
        b.addEventListener('click', async () => {
          const [id, st] = b.getAttribute('data-st').split('|');
          if (st === 'rejected' && !(await showConfirm('Refuser cette candidature ?'))) return;
          try {
            await decide(id, st, null);
            await panneauCandidatures(offerId);
          } catch (e) { await showAlert('Échec : ' + (e.message || e)); }
        });
      });
      document.querySelectorAll('[data-docs]').forEach((b) => {
        b.addEventListener('click', async () => {
          let docs = [];
          try { docs = await applicantFiles(b.getAttribute('data-docs')); }
          catch (e) { await showAlert(String(e.message || e)); return; }
          if (!docs.length) { await showAlert('Le candidat a retiré son autorisation : aucun document accessible.'); return; }
          for (const d of docs) {
            try {
              const url = await fileUrl(d.storage_path);
              const w = window.open(url, '_blank', 'noopener');
              if (!w) await showAlert(d.nom + ' (lien valable 5 minutes) :\n\n' + url);
            } catch (e) { await showAlert("Document inaccessible : " + (e.message || e)); }
          }
        });
      });
    });
  }

  // --------------------------------------------------------------------------
  async function vueProfil() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let p = null;
    try { p = await myWorkProfile(profile.id); } catch (_) { /* profil absent */ }

    body.innerHTML = `
      <p class="muted" style="font-size:12.5px;margin-bottom:14px;">
        Ce profil est visible des entreprises quand vous postulez. Tant que vous ne
        l'enregistrez pas, vous ne figurez pas au réseau professionnel.
      </p>
      <div class="field"><label for="nw-h">Titre</label>
        <input id="nw-h" maxlength="100" value="${escapeHtml(p?.headline || '')}" placeholder="Ex : Mécanicien, 5 ans d'expérience" /></div>
      <div class="field"><label for="nw-a">Présentation</label>
        <textarea id="nw-a" rows="6" maxlength="2000">${escapeHtml(p?.about || '')}</textarea></div>
      <div class="field"><label for="nw-s">Compétences (séparées par des virgules)</label>
        <input id="nw-s" value="${escapeHtml((p?.skills || []).join(', '))}" /></div>
      <div class="field"><label for="nw-o">Disponibilité</label>
        <select id="nw-o">
          <option value="1" ${p?.open_to_work !== false ? 'selected' : ''}>Ouvert aux opportunités</option>
          <option value="0" ${p?.open_to_work === false ? 'selected' : ''}>Pas disponible</option>
        </select></div>
      <button class="btn btn-primary" id="nw-save">Enregistrer</button>
      <span class="muted" id="nw-save-msg" style="font-size:12.5px;margin-left:10px;"></span>
    `;

    document.getElementById('nw-save').addEventListener('click', async () => {
      const msg = document.getElementById('nw-save-msg');
      msg.textContent = 'Enregistrement…';
      try {
        await saveWorkProfile(profile.id, {
          headline: document.getElementById('nw-h').value,
          about: document.getElementById('nw-a').value,
          skills: document.getElementById('nw-s').value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20),
          openToWork: document.getElementById('nw-o').value === '1',
        });
        msg.textContent = 'Enregistré.';
      } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
    });
  }

  // --------------------------------------------------------------------------
  function panneau(titre, html, apres) {
    fermerPanneau();
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.id = 'nw-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(titre)}</strong>
        <button class="btn btn-ghost" id="nw-close" style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">${html}</div>`;
    document.querySelector('.app-frame').appendChild(el);
    document.getElementById('nw-close').addEventListener('click', fermerPanneau);
    if (apres) apres();
  }

  function fermerPanneau() { document.getElementById('nw-panel')?.remove(); }

  rendre();
}

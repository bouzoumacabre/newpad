// ============================================================================
// NewPro — le back-office des entreprises (§38)
// ============================================================================
// Là où NewPage montre la vitrine, NewPro tient la salle des machines :
// effectifs, grades, annonces internes, fiche d'annuaire. Une même entreprise,
// une même table — modifier ses horaires ici change immédiatement ce que voit
// l'annuaire, sans synchronisation ni recopie.

import { renderAppShell } from '../appShell.js';
import { escapeHtml, formatDateTime } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { appIconSvg } from '../../lib/appIcons.js';
import { searchProfiles } from '../../lib/newpadApi.js';
import {
  myOrganizations, getOrganization, listMembers, setMember, removeMember,
  listAnnouncements, postAnnouncement, deleteAnnouncement, updateOrgProfile,
  ICONE_PAR_GENRE, genreLabel,
} from '../organizations/api.js';

export async function renderProApp(root, profile) {
  let miennes = [];
  let courante = null;   // organisation sélectionnée
  let onglet = 'equipe';

  const { body } = await renderAppShell(root, profile, 'pro', {});

  async function charger() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    try { miennes = await myOrganizations(); }
    catch (e) {
      body.innerHTML = `<div class="app-empty">Indisponible : ${escapeHtml(String(e.message || e))}</div>`;
      return;
    }
    if (!miennes.length) {
      body.innerHTML = `
        <div class="app-empty">
          Vous n'appartenez à aucune entreprise.<br />
          Les entreprises sont créées par l'administration du serveur ; demandez à y être rattaché.
        </div>`;
      return;
    }
    if (!courante || !miennes.some((o) => o.id === courante.id)) courante = miennes[0];
    dessiner();
  }

  function dessiner() {
    const dirige = courante.member_role === 'owner' || courante.member_role === 'manager';
    body.innerHTML = `
      ${miennes.length > 1 ? `
        <div class="app-toolbar">
          <div class="app-chipset">
            ${miennes.map((o) => `<button class="app-chip ${o.id === courante.id ? 'is-active' : ''}" data-org="${o.id}">${escapeHtml(o.name)}</button>`).join('')}
          </div>
        </div>` : ''}

      <div class="np-pro-head">
        <span class="np-dir-logo">${courante.logo_url
          ? `<img src="${escapeHtml(courante.logo_url)}" alt="" />`
          : appIconSvg(ICONE_PAR_GENRE[courante.kind] || 'briefcase', 22)}</span>
        <div style="flex:1;min-width:0;">
          <div style="color:var(--ivory);font-family:var(--font-display);font-size:17px;">${escapeHtml(courante.name)}</div>
          <div class="muted" style="font-size:12px;">
            ${escapeHtml(genreLabel(courante.kind))} · ${courante.nb_membres} membre${courante.nb_membres > 1 ? 's' : ''}
            · ${escapeHtml(courante.grade_label || roleLabel(courante.member_role))}
            ${courante.is_published ? '' : ' · <span style="color:var(--status-pending);">hors annuaire</span>'}
          </div>
        </div>
      </div>

      <div class="app-chipset" style="margin-bottom:14px;">
        <button class="app-chip ${onglet === 'equipe' ? 'is-active' : ''}" data-t="equipe">Équipe</button>
        <button class="app-chip ${onglet === 'annonces' ? 'is-active' : ''}" data-t="annonces">Annonces internes</button>
        ${dirige ? `<button class="app-chip ${onglet === 'fiche' ? 'is-active' : ''}" data-t="fiche">Fiche d'annuaire</button>` : ''}
      </div>

      <div id="np-pro-body"></div>
    `;

    body.querySelectorAll('[data-org]').forEach((b) => {
      b.addEventListener('click', () => {
        courante = miennes.find((o) => o.id === b.getAttribute('data-org'));
        dessiner();
      });
    });
    body.querySelectorAll('[data-t]').forEach((b) => {
      b.addEventListener('click', () => { onglet = b.getAttribute('data-t'); dessiner(); });
    });

    if (onglet === 'equipe') vueEquipe(dirige);
    else if (onglet === 'annonces') vueAnnonces(dirige);
    else vueFiche();
  }

  function roleLabel(r) {
    return r === 'owner' ? 'Propriétaire' : (r === 'manager' ? 'Direction' : 'Employé');
  }

  // --------------------------------------------------------------------------
  async function vueEquipe(dirige) {
    const zone = document.getElementById('np-pro-body');
    zone.innerHTML = '<div class="app-empty">Chargement…</div>';
    let membres = [];
    try { membres = await listMembers(courante.id); }
    catch (e) { zone.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    zone.innerHTML = `
      ${dirige ? `
        <div class="field">
          <label for="np-rec">Recruter</label>
          <input id="np-rec" placeholder="Nom ou identifiant" autocomplete="off" />
          <div id="np-rec-res" class="app-list" style="margin-top:6px;"></div>
        </div>` : ''}
      <div class="app-list">
        ${membres.map((m) => `
          <div class="app-row">
            <span class="app-row-icon">${appIconSvg('work', 16)}</span>
            <span class="app-row-main">
              <strong>${escapeHtml(m.display_name)}</strong>
              <small>${escapeHtml(m.grade_label || roleLabel(m.member_role))} · ${escapeHtml(m.username)}</small>
            </span>
            ${dirige && m.profile_id !== profile.id ? `
              <span class="app-row-actions">
                <button class="btn btn-ghost" data-grade="${m.profile_id}|${escapeHtml(m.member_role)}|${escapeHtml(m.grade_label || '')}" title="Modifier le grade">✎</button>
                <button class="btn btn-ghost" data-out="${m.profile_id}" title="Retirer">✕</button>
              </span>` : ''}
          </div>`).join('')}
      </div>`;

    if (dirige) brancherRecrutement();

    zone.querySelectorAll('[data-out]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!(await showConfirm("Retirer cette personne de l'entreprise ?"))) return;
        try { await removeMember(courante.id, b.getAttribute('data-out')); await rafraichir(); }
        catch (e) { await showAlert('Retrait impossible : ' + (e.message || e)); }
      });
    });
    zone.querySelectorAll('[data-grade]').forEach((b) => {
      b.addEventListener('click', () => {
        const [pid, role, grade] = b.getAttribute('data-grade').split('|');
        panneauGrade(pid, role, grade);
      });
    });
  }

  function brancherRecrutement() {
    const champ = document.getElementById('np-rec');
    const zone = document.getElementById('np-rec-res');
    let minuteur = null;
    champ.addEventListener('input', () => {
      clearTimeout(minuteur);
      minuteur = setTimeout(async () => {
        const q = champ.value.trim();
        if (q.length < 2) { zone.innerHTML = ''; return; }
        let r = [];
        try { r = await searchProfiles(q); } catch (_) { /* liste vide */ }
        zone.innerHTML = r.map((p) => `
          <div class="app-row" style="padding:7px 10px;cursor:pointer;" data-pick="${p.id}">
            <span class="app-row-main"><strong>${escapeHtml(p.display_name)}</strong>
              <small>${escapeHtml(p.username)}</small></span>
          </div>`).join('') || '<div class="muted" style="font-size:12.5px;">Aucun résultat.</div>';
        zone.querySelectorAll('[data-pick]').forEach((n) => {
          n.addEventListener('click', async () => {
            try {
              await setMember(courante.id, n.getAttribute('data-pick'), 'member', null);
              champ.value = ''; zone.innerHTML = '';
              await rafraichir();
            } catch (e) { await showAlert('Recrutement impossible : ' + (e.message || e)); }
          });
        });
      }, 280);
    });
  }

  function panneauGrade(profileId, role, grade) {
    panneau('Grade', `
      <div class="field"><label for="np-g-role">Rôle</label>
        <select id="np-g-role">
          <option value="member" ${role === 'member' ? 'selected' : ''}>Employé</option>
          <option value="manager" ${role === 'manager' ? 'selected' : ''}>Direction</option>
          <option value="owner" ${role === 'owner' ? 'selected' : ''}>Propriétaire</option>
        </select>
        <div class="muted" style="font-size:12px;margin-top:4px;">
          La direction peut recruter, publier des annonces et tenir la fiche d'annuaire.
        </div></div>
      <div class="field"><label for="np-g-label">Intitulé du poste</label>
        <input id="np-g-label" maxlength="60" value="${escapeHtml(grade)}" placeholder="Ex : Mécanicien, Chef d'atelier" /></div>
      <button class="btn btn-primary" id="np-g-save" style="width:100%;">Enregistrer</button>
    `, () => {
      document.getElementById('np-g-save').addEventListener('click', async () => {
        try {
          await setMember(courante.id, profileId,
            document.getElementById('np-g-role').value,
            document.getElementById('np-g-label').value);
          fermerPanneau();
          await rafraichir();
        } catch (e) { await showAlert('Échec : ' + (e.message || e)); }
      });
    });
  }

  // --------------------------------------------------------------------------
  async function vueAnnonces(dirige) {
    const zone = document.getElementById('np-pro-body');
    zone.innerHTML = '<div class="app-empty">Chargement…</div>';
    let annonces = [];
    try { annonces = await listAnnouncements(courante.id); }
    catch (e) { zone.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    zone.innerHTML = `
      ${dirige ? '<button class="btn btn-primary" id="np-ann-new" style="margin-bottom:12px;">+ Nouvelle annonce</button>' : ''}
      ${annonces.length ? `<div class="app-list">${annonces.map((a) => `
        <div class="app-row" style="align-items:flex-start;">
          <span class="app-row-icon">${appIconSvg('megaphone', 16)}</span>
          <span class="app-row-main">
            <strong>${escapeHtml(a.title)}</strong>
            <small>${formatDateTime(a.created_at)}</small>
            <span style="white-space:pre-wrap;font-size:13px;color:var(--text);margin-top:6px;">${escapeHtml(a.body)}</span>
          </span>
          ${dirige ? `<span class="app-row-actions"><button class="btn btn-ghost" data-del="${a.id}">✕</button></span>` : ''}
        </div>`).join('')}</div>`
        : '<div class="app-empty">Aucune annonce interne.</div>'}
    `;

    document.getElementById('np-ann-new')?.addEventListener('click', () => {
      panneau('Nouvelle annonce', `
        <div class="field"><label for="np-a-t">Titre</label><input id="np-a-t" maxlength="120" /></div>
        <div class="field"><label for="np-a-b">Message</label><textarea id="np-a-b" rows="7" maxlength="4000"></textarea></div>
        <button class="btn btn-primary" id="np-a-save" style="width:100%;">Publier</button>
        <div class="muted" style="font-size:12px;margin-top:8px;">
          Chaque membre de l'entreprise recevra une notification.
        </div>
      `, () => {
        document.getElementById('np-a-save').addEventListener('click', async () => {
          try {
            await postAnnouncement(courante.id,
              document.getElementById('np-a-t').value,
              document.getElementById('np-a-b').value);
            fermerPanneau();
            vueAnnonces(dirige);
          } catch (e) { await showAlert('Publication impossible : ' + (e.message || e)); }
        });
      });
    });

    zone.querySelectorAll('[data-del]').forEach((b) => {
      b.addEventListener('click', async () => {
        if (!(await showConfirm('Supprimer cette annonce ?'))) return;
        try { await deleteAnnouncement(b.getAttribute('data-del')); vueAnnonces(dirige); }
        catch (e) { await showAlert('Suppression impossible : ' + (e.message || e)); }
      });
    });
  }

  // --------------------------------------------------------------------------
  async function vueFiche() {
    const zone = document.getElementById('np-pro-body');
    zone.innerHTML = '<div class="app-empty">Chargement…</div>';
    let o;
    try { o = await getOrganization(courante.id); }
    catch (e) { zone.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    zone.innerHTML = `
      <p class="muted" style="font-size:12.5px;margin-bottom:14px;">
        Ce que vous écrivez ici est ce que la ville voit dans l'annuaire NewPage.
      </p>
      <div class="field"><label for="np-f-desc">Description</label>
        <textarea id="np-f-desc" rows="3" maxlength="400">${escapeHtml(o.description || '')}</textarea></div>
      <div class="grid" style="grid-template-columns:1fr 1fr;">
        <div class="field"><label for="np-f-loc">Adresse</label>
          <input id="np-f-loc" maxlength="120" value="${escapeHtml(o.location || '')}" /></div>
        <div class="field"><label for="np-f-hours">Horaires</label>
          <input id="np-f-hours" maxlength="120" value="${escapeHtml(o.opening_hours || '')}" placeholder="Ex : 8h — 20h, tous les jours" /></div>
      </div>
      <div class="grid" style="grid-template-columns:1fr 1fr;">
        <div class="field"><label for="np-f-phone">Téléphone</label>
          <input id="np-f-phone" maxlength="30" value="${escapeHtml(o.contact_phone || '')}" /></div>
        <div class="field"><label for="np-f-mail">Contact</label>
          <input id="np-f-mail" maxlength="80" value="${escapeHtml(o.contact_email || '')}" /></div>
      </div>
      <div class="field"><label for="np-f-pub">Annuaire public</label>
        <select id="np-f-pub">
          <option value="1" ${o.is_published ? 'selected' : ''}>Visible dans NewPage</option>
          <option value="0" ${o.is_published ? '' : 'selected'}>Masquée</option>
        </select></div>
      <button class="btn btn-primary" id="np-f-save">Enregistrer</button>
      <span class="muted" id="np-f-msg" style="font-size:12.5px;margin-left:10px;"></span>
    `;

    document.getElementById('np-f-save').addEventListener('click', async () => {
      const msg = document.getElementById('np-f-msg');
      msg.textContent = 'Enregistrement…';
      try {
        await updateOrgProfile(courante.id, {
          description: document.getElementById('np-f-desc').value,
          location: document.getElementById('np-f-loc').value,
          opening_hours: document.getElementById('np-f-hours').value,
          contact_phone: document.getElementById('np-f-phone').value,
          contact_email: document.getElementById('np-f-mail').value,
          is_published: document.getElementById('np-f-pub').value === '1',
        });
        msg.textContent = 'Enregistré. La fiche est à jour dans NewPage.';
        await rafraichirListe();
      } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
    });
  }

  // --------------------------------------------------------------------------
  async function rafraichirListe() {
    try {
      miennes = await myOrganizations();
      const maj = miennes.find((o) => o.id === courante.id);
      if (maj) courante = maj;
    } catch (_) { /* on garde l'état courant */ }
  }

  async function rafraichir() { await rafraichirListe(); dessiner(); }

  function panneau(titre, html, apres) {
    fermerPanneau();
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.id = 'np-pro-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(titre)}</strong>
        <button class="btn btn-ghost" id="np-pro-close" style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">${html}</div>`;
    document.querySelector('.app-frame').appendChild(el);
    document.getElementById('np-pro-close').addEventListener('click', fermerPanneau);
    if (apres) apres();
  }

  function fermerPanneau() { document.getElementById('np-pro-panel')?.remove(); }

  await charger();
}

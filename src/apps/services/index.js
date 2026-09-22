// ============================================================================
// Guichets — NewGov, NewDoc, NewInsurance (et les suivants)
// ============================================================================
// Un seul écran pour les trois. Une mairie, un hôpital et une compagnie
// d'assurance publient des démarches, un usager en ouvre une, joint des pièces
// depuis NewFiles, la conversation s'installe, un agent décide.
//
// Le formulaire de chaque démarche est composé par l'administration elle-même
// et stocké en base : il n'y a donc pas de « formulaire de permis de
// construire » dans ce fichier, seulement de quoi afficher n'importe quel
// formulaire (§7, Principe 1).
//
// Les pièces ne sont jamais recopiées : elles sont autorisées depuis le coffre
// de l'usager, qui peut retirer l'autorisation ensuite (§13).

import { renderAppShell } from '../appShell.js';
import { escapeHtml, formatDateTime } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { supabase } from '../../lib/supabaseClient.js';
import { pickFiles } from '../../components/filePicker.js';
import { myOrganizations } from '../organizations/api.js';

const PAROLES = {
  gov: {
    guichet: 'Démarches', dossier: 'dossier', dossiers: 'Mes dossiers',
    usager: 'Usager', bureau: 'Guichet',
    intro: 'Les démarches ouvertes par les administrations de la ville.',
    categories: ['identity', 'legal', 'property', 'vehicle', 'other'],
  },
  doc: {
    guichet: 'Services', dossier: 'dossier', dossiers: 'Mon suivi',
    usager: 'Patient', bureau: 'Accueil',
    intro: 'Consultations, certificats et suivis proposés par les établissements de santé.',
    categories: ['medical', 'identity', 'insurance', 'other'],
  },
  insurance: {
    guichet: 'Contrats & sinistres', dossier: 'dossier', dossiers: 'Mes dossiers',
    usager: 'Assuré', bureau: 'Gestion',
    intro: 'Souscriptions, déclarations de sinistre et demandes de prise en charge.',
    categories: ['insurance', 'vehicle', 'property', 'identity', 'other'],
  },
  _defaut: {
    guichet: 'Démarches', dossier: 'dossier', dossiers: 'Mes dossiers',
    usager: 'Usager', bureau: 'Guichet',
    intro: 'Les démarches ouvertes par cette organisation.',
    categories: ['other'],
  },
};

const STATUT = {
  submitted: 'Déposé', in_review: 'En cours', info_needed: 'Pièces demandées',
  accepted: 'Accepté', rejected: 'Refusé', closed: 'Clôturé',
};
const CLASSE_STATUT = {
  submitted: 'badge-pending', in_review: 'badge-pending', info_needed: 'badge-danger',
  accepted: 'badge-success', rejected: 'badge-neutral', closed: 'badge-neutral',
};

export async function renderServicesApp(root, profile, slug) {
  const mots = PAROLES[slug] || PAROLES._defaut;
  let vue = 'guichet';
  let mesOrgs = [];
  let orgActive = '';
  let filtreStatut = '';

  if (profile) {
    try { mesOrgs = await myOrganizations(); } catch (_) { mesOrgs = []; }
    orgActive = mesOrgs.length ? mesOrgs[0].id : '';
  }

  const onglets = [{ key: 'guichet', label: mots.guichet }];
  if (profile) onglets.push({ key: 'dossiers', label: mots.dossiers });
  if (mesOrgs.length) onglets.push({ key: 'bureau', label: mots.bureau });

  const { body } = await renderAppShell(root, profile, slug, {
    tabs: onglets,
    active: vue,
    onTab: (k) => { vue = k; marquer(); rendre(); },
  });

  function marquer() {
    document.querySelectorAll('.app-tab').forEach((t) => {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === vue);
    });
  }

  async function rendre() {
    if (vue === 'guichet') return guichet();
    if (vue === 'dossiers') return mesDossiers();
    return bureau();
  }

  // --------------------------------------------------------------------------
  // Les démarches ouvertes
  // --------------------------------------------------------------------------
  async function guichet() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let procedures = [];
    try {
      const { data, error } = await supabase.rpc('service_procedures_list', {
        p_app_slug: slug, p_organization_id: null, p_all: false,
      });
      if (error) throw error;
      procedures = data || [];
    } catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    // Une démarche appartient à une administration : on regroupe par guichet,
    // comme un hall d'accueil regroupe ses comptoirs.
    const guichets = [];
    procedures.forEach((p) => {
      let g = guichets.find((x) => x.id === p.organization_id);
      if (!g) { g = { id: p.organization_id, nom: p.org_name, items: [] }; guichets.push(g); }
      g.items.push(p);
    });

    body.innerHTML = `
      <p class="muted" style="font-size:12.5px;margin:0 0 14px;">${escapeHtml(mots.intro)}</p>
      ${guichets.length ? guichets.map((g) => `
        <section>
          <h3 class="sv-guichet">${escapeHtml(g.nom)}</h3>
          <div class="sv-cards">${g.items.map((p) => `
            <article class="sv-card" data-proc="${p.id}">
              <div class="sv-card-title">${escapeHtml(p.title)}</div>
              <p class="sv-card-desc">${escapeHtml(p.description)}</p>
              <div class="sv-card-foot">
                ${p.requires_files ? '<span class="badge badge-neutral">Pièces requises</span>' : ''}
                ${(p.fields || []).length
                  ? `<span class="muted">${p.fields.length} champ${p.fields.length > 1 ? 's' : ''}</span>` : ''}
              </div>
            </article>`).join('')}</div>
        </section>`).join('')
        : '<div class="app-empty">Aucune démarche ouverte pour le moment.</div>'}
    `;

    body.querySelectorAll('[data-proc]').forEach((c) => {
      c.addEventListener('click', () => {
        const p = procedures.find((x) => x.id === c.getAttribute('data-proc'));
        if (!profile) { showAlert('Créez un compte Newman Bank pour déposer un dossier.'); return; }
        formulaire(p);
      });
    });
  }

  // Le formulaire est construit à partir de la définition en base : chaque
  // champ décrit son libellé, son type et son caractère obligatoire.
  function champHtml(f) {
    const id = 'sv-f-' + f.key;
    const requis = f.required ? ' <span style="color:var(--gold-light);">*</span>' : '';
    if (f.type === 'textarea') {
      return `<div class="field"><label for="${id}">${escapeHtml(f.label || f.key)}${requis}</label>
        <textarea id="${id}" data-key="${escapeHtml(f.key)}" rows="4" maxlength="2000"></textarea></div>`;
    }
    if (f.type === 'select' && Array.isArray(f.options)) {
      return `<div class="field"><label for="${id}">${escapeHtml(f.label || f.key)}${requis}</label>
        <select id="${id}" data-key="${escapeHtml(f.key)}">
          <option value="">—</option>
          ${f.options.map((o) => `<option value="${escapeHtml(String(o))}">${escapeHtml(String(o))}</option>`).join('')}
        </select></div>`;
    }
    const type = ['number', 'date', 'datetime-local'].includes(f.type) ? f.type : 'text';
    return `<div class="field"><label for="${id}">${escapeHtml(f.label || f.key)}${requis}</label>
      <input id="${id}" data-key="${escapeHtml(f.key)}" type="${type}" maxlength="400" /></div>`;
  }

  function formulaire(p) {
    let documents = [];

    panneau(p.title, `
      <p style="font-size:13px;line-height:1.6;margin-bottom:12px;">${escapeHtml(p.description)}</p>
      <div class="muted" style="font-size:12px;margin-bottom:12px;">${escapeHtml(p.org_name)}</div>
      ${(p.fields || []).map(champHtml).join('')}
      <div class="field"><label for="sv-msg">Message</label>
        <textarea id="sv-msg" rows="3" maxlength="4000" placeholder="Précisions à l’attention du guichet"></textarea></div>
      <div class="field">
        <label>Pièces justificatives${p.requires_files ? ' <span style="color:var(--gold-light);">*</span>' : ''}</label>
        <div id="sv-docs" class="app-list" style="margin-bottom:8px;"></div>
        <button class="btn btn-ghost" id="sv-add" style="width:100%;">Joindre depuis NewFiles</button>
      </div>
      <button class="btn btn-primary" id="sv-send" style="width:100%;margin-top:10px;">Déposer le dossier</button>
      <div class="muted" id="sv-msg2" style="font-size:12.5px;margin-top:10px;">
        Vos documents restent dans NewFiles : le guichet reçoit une autorisation
        de consultation, que vous pouvez retirer.
      </div>
    `, () => {
      const zone = document.getElementById('sv-docs');
      function rendreDocs() {
        zone.innerHTML = documents.map((d) => `
          <div class="app-row" style="padding:6px 10px;">
            <span class="app-row-main"><strong>${escapeHtml(d.name)}</strong></span>
            <button class="btn btn-ghost" data-off="${d.id}" style="padding:1px 8px;font-size:11px;">✕</button>
          </div>`).join('');
        zone.querySelectorAll('[data-off]').forEach((b) => {
          b.addEventListener('click', () => {
            documents = documents.filter((d) => d.id !== b.getAttribute('data-off'));
            rendreDocs();
          });
        });
      }

      document.getElementById('sv-add').addEventListener('click', async () => {
        const choisis = await pickFiles({
          title: 'Joindre depuis NewFiles',
          ownerId: profile.id,
          categories: mots.categories,
          sourceApp: slug,
        });
        documents = documents.concat(choisis.filter((c) => !documents.some((d) => d.id === c.id)));
        rendreDocs();
      });

      document.getElementById('sv-send').addEventListener('click', async () => {
        const msg = document.getElementById('sv-msg2');
        const reponses = {};
        document.querySelectorAll('#sv-panel [data-key]').forEach((el) => {
          const v = el.value.trim();
          if (v) reponses[el.getAttribute('data-key')] = v;
        });
        msg.textContent = 'Dépôt…';
        try {
          const { data, error } = await supabase.rpc('service_open_case', {
            p_procedure_id: p.id,
            p_answers: reponses,
            p_message: document.getElementById('sv-msg').value,
            p_file_ids: documents.map((d) => d.id),
          });
          if (error) throw error;
          fermerPanneau();
          vue = 'dossiers'; marquer(); await rendre();
          dossier(data);
        } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
      });
    });
  }

  // --------------------------------------------------------------------------
  // Mes dossiers
  // --------------------------------------------------------------------------
  async function mesDossiers() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let lignes = [];
    try {
      const { data, error } = await supabase.rpc('service_my_cases', { p_app_slug: slug });
      if (error) throw error;
      lignes = data || [];
    } catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    body.innerHTML = lignes.length ? `<div class="app-list">${lignes.map((c) => `
      <div class="app-row" data-case="${c.id}" style="cursor:pointer;">
        <span class="app-row-main">
          <strong>${escapeHtml(c.procedure_title)}</strong>
          <small>${escapeHtml(c.reference)} · ${escapeHtml(c.org_name)} · ${formatDateTime(c.updated_at)}</small>
        </span>
        <span class="badge ${CLASSE_STATUT[c.status] || 'badge-neutral'}">${STATUT[c.status] || c.status}</span>
      </div>`).join('')}</div>`
      : `<div class="app-empty">Aucun ${escapeHtml(mots.dossier)} en cours.</div>`;

    body.querySelectorAll('[data-case]').forEach((r) => {
      r.addEventListener('click', () => dossier(r.getAttribute('data-case')));
    });
  }

  // --------------------------------------------------------------------------
  // Le dossier — vue commune usager / agent
  // --------------------------------------------------------------------------
  async function dossier(id) {
    let d; let fil = []; let pieces = [];
    try {
      const [c, t, f] = await Promise.all([
        supabase.rpc('service_case', { p_case_id: id }),
        supabase.rpc('service_case_thread', { p_case_id: id }),
        supabase.rpc('service_case_documents', { p_case_id: id }),
      ]);
      if (c.error) throw c.error;
      d = c.data; fil = t.data || []; pieces = f.data || [];
    } catch (e) { await showAlert(String(e.message || e)); return; }

    const clos = ['accepted', 'rejected', 'closed'].includes(d.status);
    const champs = (d.fields || []).filter((f) => (d.answers || {})[f.key]);

    panneau(d.reference, `
      <div class="sv-fiche-head">
        <strong>${escapeHtml(d.procedure_title)}</strong>
        <span class="badge ${CLASSE_STATUT[d.status] || 'badge-neutral'}">${STATUT[d.status] || d.status}</span>
      </div>
      <div class="muted" style="font-size:12px;margin-bottom:12px;">
        ${escapeHtml(d.org_name)} · ${mots.usager} : ${escapeHtml(d.applicant_name)}
        ${d.assignee_name ? ' · suivi par ' + escapeHtml(d.assignee_name) : ''}
        · ${formatDateTime(d.created_at)}
      </div>

      ${champs.length ? `<dl class="sv-answers">${champs.map((f) =>
        `<div><dt>${escapeHtml(f.label || f.key)}</dt>
             <dd>${escapeHtml(String(d.answers[f.key]))}</dd></div>`).join('')}</dl>` : ''}

      ${d.decision_note ? `<div class="np-note" style="margin:10px 0;">${escapeHtml(d.decision_note)}</div>` : ''}

      ${pieces.length ? `
        <h4 class="sv-sous-titre">Pièces (${pieces.length})</h4>
        <div class="app-list">${pieces.map((p) => `
          <div class="app-row" style="padding:6px 10px;">
            <span class="app-row-main"><strong>${escapeHtml(p.name)}</strong>
              <small>${escapeHtml(p.added_by_name)} · ${formatDateTime(p.created_at)}</small></span>
          </div>`).join('')}</div>` : ''}

      <h4 class="sv-sous-titre">Échanges</h4>
      <div class="sv-fil">${fil.length ? fil.map((m) => `
        <div class="sv-msg ${m.is_internal ? 'is-internal' : ''} ${m.author_id === (profile && profile.id) ? 'is-mine' : ''}">
          <div class="sv-msg-head">${escapeHtml(m.author_name)}
            ${m.is_internal ? '<span class="badge badge-neutral">Note interne</span>' : ''}
            <span class="muted">${formatDateTime(m.created_at)}</span></div>
          <div class="sv-msg-body">${escapeHtml(m.body)}</div>
        </div>`).join('') : '<div class="muted" style="font-size:12.5px;">Aucun échange.</div>'}</div>

      ${!clos || d.is_agent ? `
        <div class="field" style="margin-top:12px;"><label for="sv-rep">Répondre</label>
          <textarea id="sv-rep" rows="3" maxlength="4000"></textarea></div>
        ${d.is_agent ? `<label class="sv-check">
          <input type="checkbox" id="sv-int" /> Note interne (invisible pour le ${mots.usager.toLowerCase()})
        </label>` : ''}
        <button class="btn btn-primary" id="sv-post" style="width:100%;">Envoyer</button>` : ''}

      ${d.is_agent && !clos ? `
        <h4 class="sv-sous-titre">Traitement</h4>
        <div class="field"><label for="sv-note">Motif de la décision (facultatif)</label>
          <input id="sv-note" maxlength="2000" /></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-ghost" data-st="in_review" style="flex:1;">Prendre en charge</button>
          <button class="btn btn-ghost" data-st="info_needed" style="flex:1;">Demander des pièces</button>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">
          <button class="btn btn-primary" data-st="accepted" style="flex:1;">Accepter</button>
          <button class="btn btn-ghost" data-st="rejected" style="flex:1;">Refuser</button>
        </div>` : ''}
    `, () => {
      document.getElementById('sv-post')?.addEventListener('click', async () => {
        const zone = document.getElementById('sv-rep');
        if (!zone.value.trim()) return;
        try {
          const { error } = await supabase.rpc('service_post_case_message', {
            p_case_id: id, p_body: zone.value,
            p_internal: !!document.getElementById('sv-int')?.checked,
            p_file_ids: null,
          });
          if (error) throw error;
          fermerPanneau(); dossier(id);
        } catch (e) { await showAlert(String(e.message || e)); }
      });

      document.querySelectorAll('#sv-panel [data-st]').forEach((b) => {
        b.addEventListener('click', async () => {
          const statut = b.getAttribute('data-st');
          if (['accepted', 'rejected'].includes(statut)
              && !(await showConfirm('Cette décision clôt le dossier. Confirmer ?'))) return;
          try {
            const { error } = await supabase.rpc('service_set_case_status', {
              p_case_id: id, p_status: statut,
              p_note: document.getElementById('sv-note')?.value || null,
              p_assign_me: true,
            });
            if (error) throw error;
            fermerPanneau();
            if (vue === 'bureau') bureau(); else mesDossiers();
          } catch (e) { await showAlert(String(e.message || e)); }
        });
      });
    });
  }

  // --------------------------------------------------------------------------
  // Le bureau (côté administration)
  // --------------------------------------------------------------------------
  async function bureau() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let dossiers = []; let procedures = [];
    try {
      const [c, p] = await Promise.all([
        supabase.rpc('service_org_cases', {
          p_app_slug: slug, p_organization_id: orgActive, p_status: filtreStatut || null,
        }),
        supabase.rpc('service_procedures_list', {
          p_app_slug: slug, p_organization_id: orgActive, p_all: true,
        }),
      ]);
      if (c.error) throw c.error;
      dossiers = c.data || []; procedures = p.data || [];
    } catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(String(e.message || e))}</div>`; return; }

    body.innerHTML = `
      <div class="app-toolbar">
        ${mesOrgs.length > 1 ? `<select id="sv-org" style="margin:0;max-width:210px;">
          ${mesOrgs.map((o) => `<option value="${o.id}" ${o.id === orgActive ? 'selected' : ''}>
            ${escapeHtml(o.name)}</option>`).join('')}</select>` : ''}
        <select id="sv-filtre" style="margin:0;max-width:170px;">
          <option value="">Tous les dossiers</option>
          ${Object.entries(STATUT).map(([v, l]) =>
            `<option value="${v}" ${v === filtreStatut ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="btn btn-primary" id="sv-new" style="padding:6px 14px;font-size:13px;">+ Démarche</button>
      </div>

      <h3 class="sv-guichet">Dossiers reçus (${dossiers.length})</h3>
      ${dossiers.length ? `<div class="app-list">${dossiers.map((c) => `
        <div class="app-row" data-case="${c.id}" style="cursor:pointer;">
          <span class="app-row-main">
            <strong>${escapeHtml(c.applicant_name)} — ${escapeHtml(c.procedure_title)}</strong>
            <small>${escapeHtml(c.reference)} · ${formatDateTime(c.updated_at)}
              ${c.assignee_name ? ' · ' + escapeHtml(c.assignee_name) : ''}</small>
          </span>
          <span class="badge ${CLASSE_STATUT[c.status] || 'badge-neutral'}">${STATUT[c.status] || c.status}</span>
        </div>`).join('')}</div>`
        : '<div class="muted" style="font-size:12.5px;">Aucun dossier.</div>'}

      <h3 class="sv-guichet">Démarches publiées (${procedures.length})</h3>
      ${procedures.length ? `<div class="app-list">${procedures.map((p) => `
        <div class="app-row">
          <span class="app-row-main" data-edit="${p.id}" style="cursor:pointer;">
            <strong>${escapeHtml(p.title)}</strong>
            <small>${(p.fields || []).length} champ${(p.fields || []).length > 1 ? 's' : ''}
              ${p.requires_files ? ' · pièces requises' : ''}
              ${Number(p.open_cases) > 0 ? ' · ' + p.open_cases + ' en cours' : ''}</small>
          </span>
          <button class="btn btn-ghost" data-open="${p.id}" data-on="${p.is_open ? '1' : '0'}"
                  style="padding:3px 9px;font-size:12px;">${p.is_open ? 'Fermer' : 'Rouvrir'}</button>
          <span class="badge ${p.is_open ? 'badge-success' : 'badge-neutral'}">${p.is_open ? 'Ouverte' : 'Fermée'}</span>
        </div>`).join('')}</div>`
        : '<div class="muted" style="font-size:12.5px;">Aucune démarche publiée.</div>'}
    `;

    document.getElementById('sv-org')?.addEventListener('change', (e) => { orgActive = e.target.value; bureau(); });
    document.getElementById('sv-filtre').addEventListener('change', (e) => { filtreStatut = e.target.value; bureau(); });
    document.getElementById('sv-new').addEventListener('click', () => editeurDemarche(null));
    body.querySelectorAll('[data-case]').forEach((r) => {
      r.addEventListener('click', () => dossier(r.getAttribute('data-case')));
    });
    body.querySelectorAll('[data-edit]').forEach((r) => {
      r.addEventListener('click', () => {
        editeurDemarche(procedures.find((p) => p.id === r.getAttribute('data-edit')));
      });
    });
    body.querySelectorAll('[data-open]').forEach((b) => {
      b.addEventListener('click', async () => {
        try {
          const { error } = await supabase.rpc('service_set_procedure_open', {
            p_id: b.getAttribute('data-open'), p_open: b.getAttribute('data-on') !== '1',
          });
          if (error) throw error;
          bureau();
        } catch (e) { await showAlert(String(e.message || e)); }
      });
    });
  }

  // Le composeur de formulaire : une ligne par champ, « clé | libellé | type | * ».
  // Volontairement textuel — un constructeur visuel serait plus joli et bien
  // plus lourd à faire tenir dans la tablette.
  function editeurDemarche(existante) {
    const p = existante || {};
    const lignes = (p.fields || []).map((f) =>
      `${f.key} | ${f.label || f.key} | ${f.type || 'text'}${f.required ? ' | *' : ''}`).join('\n');

    panneau(existante ? 'Modifier la démarche' : 'Nouvelle démarche', `
      <div class="field"><label for="sv-t">Intitulé</label>
        <input id="sv-t" maxlength="120" value="${escapeHtml(p.title || '')}" /></div>
      <div class="field"><label for="sv-d">Description</label>
        <textarea id="sv-d" rows="4" maxlength="4000">${escapeHtml(p.description || '')}</textarea></div>
      <div class="field"><label for="sv-champs">Champs du formulaire</label>
        <textarea id="sv-champs" rows="6" placeholder="adresse | Adresse du terrain | text | *">${escapeHtml(lignes)}</textarea>
        <small class="muted" style="font-size:11.5px;">
          Une ligne par champ : <code>clé | libellé | type | *</code>.
          Types : text, textarea, number, date. Le <code>*</code> rend le champ obligatoire.
        </small></div>
      <label class="sv-check">
        <input type="checkbox" id="sv-req" ${p.requires_files ? 'checked' : ''} />
        Exiger au moins une pièce justificative
      </label>
      <button class="btn btn-primary" id="sv-save" style="width:100%;">
        ${existante ? 'Enregistrer' : 'Publier la démarche'}</button>
      <div class="muted" id="sv-msg3" style="font-size:12.5px;margin-top:10px;"></div>
    `, () => {
      document.getElementById('sv-save').addEventListener('click', async () => {
        const msg = document.getElementById('sv-msg3');
        const champs = [];
        document.getElementById('sv-champs').value.split('\n').forEach((ligne) => {
          const parts = ligne.split('|').map((s) => s.trim());
          if (!parts[0]) return;
          const cle = parts[0].toLowerCase().replace(/[^a-z0-9_]/g, '_');
          if (!cle) return;
          champs.push({
            key: cle,
            label: parts[1] || parts[0],
            type: parts[2] || 'text',
            required: (parts[3] || '') === '*',
          });
        });
        msg.textContent = 'Enregistrement…';
        try {
          const { error } = await supabase.rpc('service_upsert_procedure', {
            p_app_slug: slug,
            p_organization_id: p.organization_id || orgActive,
            p_title: document.getElementById('sv-t').value,
            p_description: document.getElementById('sv-d').value,
            p_id: existante ? p.id : null,
            p_fields: champs,
            p_requires_files: document.getElementById('sv-req').checked,
            p_sort_order: 10,
          });
          if (error) throw error;
          fermerPanneau(); bureau();
        } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
      });
    });
  }

  // --------------------------------------------------------------------------
  function panneau(titre, html, apres) {
    fermerPanneau();
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.id = 'sv-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(titre)}</strong>
        <button class="btn btn-ghost" id="sv-close" style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">${html}</div>`;
    document.querySelector('.app-frame').appendChild(el);
    document.getElementById('sv-close').addEventListener('click', fermerPanneau);
    if (apres) apres();
  }

  function fermerPanneau() { document.getElementById('sv-panel')?.remove(); }

  await rendre();
}

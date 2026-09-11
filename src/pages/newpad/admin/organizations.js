// ============================================================================
// NEWPAD — administration des organisations
// ============================================================================
// Les entreprises de la ville ne se créent pas toutes seules : c'est une
// décision de jeu, pas un formulaire ouvert à tous. L'administration les crée
// et désigne leur propriétaire ; la direction tient ensuite sa fiche et son
// effectif depuis NewPro, sans repasser par ici.

import { navigate } from '../../../lib/router.js';
import { escapeHtml } from '../../../lib/format.js';
import { showAlert } from '../../../lib/uiDialogs.js';
import { appIconSvg } from '../../../lib/appIcons.js';
import { isNewpadAdmin, searchProfiles } from '../../../lib/newpadApi.js';
import { supabase } from '../../../lib/supabaseClient.js';
import {
  upsertOrganization, listMembers, GENRES, ICONE_PAR_GENRE, genreLabel,
} from '../../../apps/organizations/api.js';

export async function renderNewpadOrganizations(root, profile) {
  if (!(await isNewpadAdmin())) { navigate('/'); return; }

  let orgs = [];
  let selection = null;

  root.innerHTML = `
    <div class="npadmin">
      <header class="npadmin-top">
        <div>
          <div class="font-display" style="font-size:20px;color:var(--ivory);">Organisations</div>
          <div class="muted" style="font-size:12.5px;">Entreprises, gouvernement, médias, labels</div>
        </div>
        <div class="flex items-center gap-sm">
          <button class="btn btn-primary" id="no-new">+ Nouvelle organisation</button>
          <button class="btn btn-ghost" id="no-console">◀ Console</button>
        </div>
      </header>
      <div class="npadmin-body">
        <section class="card"><div id="no-list"></div></section>
        <section class="card"><div id="no-form"></div></section>
      </div>
    </div>`;

  document.getElementById('no-console').addEventListener('click', () => navigate('/newpad/admin'));
  document.getElementById('no-new').addEventListener('click', () => { selection = 'nouvelle'; formulaire(); });

  async function charger() {
    // L'administrateur lit toutes les organisations, publiées ou non : sa
    // policy le lui permet, c'est justement elle qui rend cet écran possible.
    const { data, error } = await supabase
      .from('organizations')
      .select('id, slug, name, kind, description, logo_url, owner_id, contact_email, contact_phone, location, status, is_published')
      .order('name');
    if (error) {
      document.getElementById('no-list').innerHTML =
        `<div class="app-empty">${escapeHtml(error.message)}</div>`;
      return;
    }
    orgs = data || [];
    liste();
  }

  function liste() {
    document.getElementById('no-list').innerHTML = orgs.length
      ? `<div class="app-list">${orgs.map((o) => `
          <div class="app-row" style="cursor:pointer;" data-pick="${o.id}">
            <span class="app-row-icon">${o.logo_url
              ? `<img src="${escapeHtml(o.logo_url)}" alt="" />`
              : appIconSvg(ICONE_PAR_GENRE[o.kind] || 'directory', 17)}</span>
            <span class="app-row-main">
              <strong>${escapeHtml(o.name)}</strong>
              <small>${escapeHtml(genreLabel(o.kind))}${o.location ? ' · ' + escapeHtml(o.location) : ''}</small>
            </span>
            ${o.status !== 'active' ? '<span class="badge badge-neutral">' + escapeHtml(o.status) + '</span>' : ''}
            ${o.is_published ? '' : '<span class="badge badge-pending">hors annuaire</span>'}
          </div>`).join('')}</div>`
      : '<div class="app-empty">Aucune organisation. Créez la première.</div>';

    document.querySelectorAll('[data-pick]').forEach((el) => {
      el.addEventListener('click', () => {
        selection = orgs.find((o) => o.id === el.getAttribute('data-pick'));
        formulaire();
      });
    });
  }

  function formulaire() {
    const f = document.getElementById('no-form');
    if (!selection) {
      f.innerHTML = '<p class="muted" style="font-size:13px;">Sélectionnez une organisation, ou créez-en une.</p>';
      return;
    }
    const nouvelle = selection === 'nouvelle';
    const o = nouvelle
      ? { name: '', slug: '', kind: 'company', description: '', location: '',
          contact_phone: '', contact_email: '', status: 'active', owner_id: null }
      : selection;
    let proprietaire = null;

    f.innerHTML = `
      <div class="font-display" style="font-size:17px;color:var(--ivory);margin-bottom:14px;">
        ${nouvelle ? 'Nouvelle organisation' : escapeHtml(o.name)}
      </div>
      <div class="field"><label for="no-name">Nom</label>
        <input id="no-name" maxlength="80" value="${escapeHtml(o.name)}" /></div>
      <div class="grid" style="grid-template-columns:1fr 1fr;">
        <div class="field"><label for="no-slug">Identifiant</label>
          <input id="no-slug" value="${escapeHtml(o.slug)}" /></div>
        <div class="field"><label for="no-kind">Genre</label>
          <select id="no-kind">${GENRES.map(([v, l]) =>
            `<option value="${v}" ${o.kind === v ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label for="no-desc">Description</label>
        <textarea id="no-desc" rows="2" maxlength="400">${escapeHtml(o.description || '')}</textarea></div>
      <div class="grid" style="grid-template-columns:1fr 1fr;">
        <div class="field"><label for="no-loc">Adresse</label>
          <input id="no-loc" maxlength="120" value="${escapeHtml(o.location || '')}" /></div>
        <div class="field"><label for="no-status">Statut</label>
          <select id="no-status">
            <option value="active" ${o.status === 'active' ? 'selected' : ''}>Active</option>
            <option value="suspended" ${o.status === 'suspended' ? 'selected' : ''}>Suspendue</option>
            <option value="closed" ${o.status === 'closed' ? 'selected' : ''}>Fermée</option>
          </select></div>
      </div>
      <div class="field"><label for="no-owner">Propriétaire${nouvelle ? '' : ' (laisser vide pour ne pas changer)'}</label>
        <input id="no-owner" placeholder="Nom ou identifiant" autocomplete="off" />
        <div id="no-owner-res" class="app-list" style="margin-top:6px;"></div>
        <div class="muted" id="no-owner-sel" style="font-size:12px;margin-top:4px;"></div>
      </div>
      <button class="btn btn-primary" id="no-save">${nouvelle ? 'Créer' : 'Enregistrer'}</button>
      <button class="btn btn-ghost" id="no-cancel">Annuler</button>
      <div class="muted" id="no-msg" style="font-size:12.5px;margin-top:10px;"></div>
      ${nouvelle ? '' : '<div id="no-members" style="margin-top:18px;"></div>'}
    `;

    if (nouvelle) {
      document.getElementById('no-name').addEventListener('input', (e) => {
        const slug = document.getElementById('no-slug');
        if (slug.dataset.touche) return;
        slug.value = e.target.value.toLowerCase().normalize('NFD')
          .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '').slice(0, 50);
      });
      document.getElementById('no-slug').addEventListener('input', (e) => { e.target.dataset.touche = '1'; });
    }

    const champ = document.getElementById('no-owner');
    const zone = document.getElementById('no-owner-res');
    let minuteur = null;
    champ.addEventListener('input', () => {
      clearTimeout(minuteur);
      minuteur = setTimeout(async () => {
        const q = champ.value.trim();
        if (q.length < 2) { zone.innerHTML = ''; return; }
        let r = [];
        try { r = await searchProfiles(q); } catch (_) { /* liste vide */ }
        zone.innerHTML = r.map((p) => `
          <div class="app-row" style="padding:7px 10px;cursor:pointer;" data-own="${p.id}" data-nom="${escapeHtml(p.display_name)}">
            <span class="app-row-main"><strong>${escapeHtml(p.display_name)}</strong>
              <small>${escapeHtml(p.username)}</small></span></div>`).join('')
          || '<div class="muted" style="font-size:12.5px;">Aucun résultat.</div>';
        zone.querySelectorAll('[data-own]').forEach((n) => {
          n.addEventListener('click', () => {
            proprietaire = n.getAttribute('data-own');
            document.getElementById('no-owner-sel').textContent = 'Propriétaire : ' + n.getAttribute('data-nom');
            champ.value = ''; zone.innerHTML = '';
          });
        });
      }, 280);
    });

    document.getElementById('no-cancel').addEventListener('click', () => { selection = null; formulaire(); });

    document.getElementById('no-save').addEventListener('click', async () => {
      const msg = document.getElementById('no-msg');
      msg.textContent = 'Enregistrement…';
      try {
        const id = await upsertOrganization({
          id: nouvelle ? null : o.id,
          name: document.getElementById('no-name').value,
          slug: document.getElementById('no-slug').value,
          kind: document.getElementById('no-kind').value,
          description: document.getElementById('no-desc').value,
          location: document.getElementById('no-loc').value,
          status: document.getElementById('no-status').value,
          owner_id: proprietaire,
        });
        await charger();
        selection = orgs.find((x) => x.id === id) || null;
        formulaire();
        const m = document.getElementById('no-msg');
        if (m) m.textContent = 'Enregistré.';
      } catch (e) { msg.textContent = 'Échec : ' + (e.message || e); }
    });

    if (!nouvelle) effectif(o.id);
  }

  async function effectif(orgId) {
    const zone = document.getElementById('no-members');
    if (!zone) return;
    let membres = [];
    try { membres = await listMembers(orgId); } catch (_) { /* liste vide */ }
    zone.innerHTML = `
      <strong style="font-size:13px;color:var(--ivory);">Effectif (${membres.length})</strong>
      <div class="muted" style="font-size:12px;margin:4px 0 8px;">
        Le recrutement se fait depuis NewPro, par la direction de l'organisation.
      </div>
      <div class="app-list">
        ${membres.map((m) => `
          <div class="app-row" style="padding:7px 10px;">
            <span class="app-row-main"><strong>${escapeHtml(m.display_name)}</strong>
              <small>${escapeHtml(m.grade_label || m.member_role)}</small></span>
          </div>`).join('') || '<div class="muted" style="font-size:12.5px;">Personne pour le moment.</div>'}
      </div>`;
  }

  await charger();
  formulaire();
}

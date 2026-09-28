// ============================================================================
// NewLeague — les compétitions de la ville
// ============================================================================
// Un organisateur (un joueur ou une organisation, §12) ouvre une compétition,
// les capitaines inscrivent leur équipe, l'organisateur programme les
// rencontres et saisit les scores. Le classement est calculé par la base à
// partir des résultats (0058) : il n'est jamais stocké, donc jamais faux.
//
// §90 : la dotation est un texte. Newpad ne verse rien.

import { renderAppShell } from '../appShell.js';
import { escapeHtml, formatDateTime } from '../../lib/format.js';
import { showAlert, showConfirm } from '../../lib/uiDialogs.js';
import { supabase } from '../../lib/supabaseClient.js';
import { myOrganizations } from '../organizations/api.js';

const STATUT = {
  open: ['Inscriptions ouvertes', 'badge-success'],
  running: ['En cours', 'badge-pending'],
  finished: ['Terminée', 'badge-neutral'],
  cancelled: ['Annulée', 'badge-danger'],
};
const EQUIPE = {
  pending: ['En attente', 'badge-pending'],
  accepted: ['Inscrite', 'badge-success'],
  rejected: ['Refusée', 'badge-danger'],
  withdrawn: ['Retirée', 'badge-neutral'],
};
const badge = (table, cle) => {
  const [txt, cls] = table[cle] || [cle, 'badge-neutral'];
  return `<span class="badge ${cls}">${escapeHtml(txt)}</span>`;
};

async function rpc(nom, args) {
  const { data, error } = await supabase.rpc(nom, args);
  if (error) throw error;
  return data;
}
const message = (e) => String(e.message || e);

export async function renderLeagueApp(root, profile) {
  let vue = 'all';

  const { body } = await renderAppShell(root, profile, 'league', {
    tabs: [{ key: 'all', label: 'Compétitions' }, { key: 'mine', label: 'Les miennes' }],
    active: vue,
    onTab: (k) => { vue = k; marquer(); liste(); },
    actions: '<button class="btn btn-primary" id="nl-new" style="padding:6px 14px;font-size:13px;">+ Organiser</button>',
  });

  function marquer() {
    document.querySelectorAll('.app-tab').forEach((t) => {
      t.classList.toggle('is-active', t.getAttribute('data-tab') === vue);
    });
  }

  // --------------------------------------------------------------------------
  async function liste() {
    body.innerHTML = '<div class="app-empty">Chargement…</div>';
    let lignes;
    try { lignes = (await rpc('league_list', { p_scope: vue })) || []; }
    catch (e) { body.innerHTML = `<div class="app-empty">${escapeHtml(message(e))}</div>`; return; }

    body.innerHTML = lignes.length ? `<div class="app-list">${lignes.map((c) => `
      <div class="app-row" data-comp="${c.id}" style="cursor:pointer;">
        <span class="app-row-main">
          <strong>${escapeHtml(c.name)}</strong>
          <small>${escapeHtml(c.discipline)} · ${escapeHtml(c.organizer)} · ${c.nb_teams}${
            c.max_teams ? ' / ' + c.max_teams : ''} équipe${Number(c.nb_teams) > 1 ? 's' : ''}${
            c.prize_info ? ' · ' + escapeHtml(c.prize_info) : ''}</small>
        </span>
        ${c.can_manage ? '<span class="badge badge-neutral">Organisateur</span>' : ''}
        ${c.my_team_status ? badge(EQUIPE, c.my_team_status) : ''}
        ${badge(STATUT, c.status)}
      </div>`).join('')}</div>`
      : `<div class="app-empty">${vue === 'mine'
        ? 'Vous n’organisez ni ne disputez aucune compétition.'
        : 'Aucune compétition pour l’instant. Organisez la première !'}</div>`;

    body.querySelectorAll('[data-comp]').forEach((r) => {
      r.addEventListener('click', () => fiche(r.getAttribute('data-comp')));
    });
  }

  // --------------------------------------------------------------------------
  async function fiche(id) {
    let c;
    try { c = await rpc('league_detail', { p_id: id }); }
    catch (e) { await showAlert(message(e)); return; }

    const acceptees = c.teams.filter((t) => t.status === 'accepted');
    const enAttente = c.teams.filter((t) => t.status === 'pending');
    const moi = c.my_team;
    const peutSInscrire = c.status === 'open' && !c.can_manage
      && !(moi && ['pending', 'accepted'].includes(moi.status));

    panneau(c.name, `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
        ${badge(STATUT, c.status)}
        <span class="badge badge-neutral">${escapeHtml(c.discipline)}</span>
        ${c.prize_info ? `<span class="badge badge-neutral">${escapeHtml(c.prize_info)}</span>` : ''}
      </div>
      <div class="muted" style="font-size:12.5px;margin-bottom:8px;">Organisée par ${escapeHtml(c.organizer)} ·
        ${acceptees.length}${c.max_teams ? ' / ' + c.max_teams : ''} équipe${acceptees.length > 1 ? 's' : ''}</div>
      ${c.description ? `<p style="font-size:13px;line-height:1.6;white-space:pre-wrap;margin-bottom:14px;">${escapeHtml(c.description)}</p>` : ''}

      ${moi ? `<div class="app-row" style="margin-bottom:14px;">
          <span class="app-row-main"><strong>Votre équipe : ${escapeHtml(moi.name)}</strong>
            ${moi.roster ? `<small>${escapeHtml(moi.roster)}</small>` : ''}</span>
          ${badge(EQUIPE, moi.status)}
          ${c.status === 'open' && ['pending', 'accepted'].includes(moi.status)
            ? `<span class="app-row-actions"><button class="btn btn-ghost" id="nl-withdraw">Retirer</button></span>` : ''}
        </div>` : ''}

      ${peutSInscrire ? `
        <h4 class="nl-h">Inscrire mon équipe</h4>
        <div class="field"><label for="nl-tn">Nom de l’équipe</label><input id="nl-tn" maxlength="40" /></div>
        <div class="field"><label for="nl-tr">Joueurs (facultatif)</label>
          <textarea id="nl-tr" rows="2" maxlength="1000" placeholder="Un nom par ligne ou séparés par des virgules"></textarea></div>
        <button class="btn btn-primary" id="nl-reg" style="width:100%;margin-bottom:16px;">Envoyer l’inscription</button>` : ''}

      <h4 class="nl-h">Classement</h4>
      ${c.standings.length ? `<table class="nl-table">
        <thead><tr><th>#</th><th>Équipe</th><th title="Joués">J</th><th title="Gagnés">G</th><th title="Nuls">N</th>
          <th title="Perdus">P</th><th title="Différence">+/−</th><th>Pts</th></tr></thead>
        <tbody>${c.standings.map((s, i) => `<tr>
          <td class="gold">${i + 1}</td><td>${escapeHtml(s.name)}</td><td>${s.j}</td><td>${s.g}</td><td>${s.n}</td>
          <td>${s.p}</td><td>${s.diff > 0 ? '+' : ''}${s.diff}</td><td><strong>${s.pts}</strong></td></tr>`).join('')}
        </tbody></table>`
        : '<div class="muted" style="font-size:12.5px;margin-bottom:14px;">Aucune équipe inscrite pour l’instant.</div>'}

      <h4 class="nl-h">Rencontres</h4>
      ${c.matches.length ? `<div class="app-list" style="margin-bottom:14px;">${c.matches.map((m) => `
        <div class="app-row">
          <span class="app-row-main">
            <strong>${escapeHtml(m.home)} ${m.status === 'played'
              ? `<span class="gold">${m.home_score} – ${m.away_score}</span>` : 'vs'} ${escapeHtml(m.away)}</strong>
            <small>${[m.round ? escapeHtml(m.round) : '', m.scheduled_at ? formatDateTime(m.scheduled_at) : 'Date à fixer']
              .filter(Boolean).join(' · ')}</small>
          </span>
          ${c.can_manage ? `<span class="app-row-actions">
            <button class="btn btn-ghost" data-score="${m.id}">${m.status === 'played' ? 'Corriger' : 'Score'}</button>
            <button class="btn btn-ghost" data-suppr="${m.id}" title="Supprimer">✕</button></span>` : ''}
        </div>`).join('')}</div>`
        : '<div class="muted" style="font-size:12.5px;margin-bottom:14px;">Aucune rencontre programmée.</div>'}

      ${c.can_manage ? `
        <div class="nl-orga">
          <h4 class="nl-h">Organisation</h4>
          ${enAttente.length ? `<div class="app-list" style="margin-bottom:12px;">${enAttente.map((t) => `
            <div class="app-row">
              <span class="app-row-main"><strong>${escapeHtml(t.name)}</strong>
                <small>Capitaine : ${escapeHtml(t.captain)}${t.roster ? ' · ' + escapeHtml(t.roster) : ''}</small></span>
              <span class="app-row-actions">
                <button class="btn btn-primary" data-accept="${t.id}">Accepter</button>
                <button class="btn btn-ghost" data-reject="${t.id}">Refuser</button></span>
            </div>`).join('')}</div>` : ''}

          ${acceptees.length >= 2 ? `
            <div style="display:flex;gap:8px;">
              <div class="field" style="flex:1;"><label for="nl-mh">Domicile</label>
                <select id="nl-mh">${acceptees.map((t) => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}</select></div>
              <div class="field" style="flex:1;"><label for="nl-ma">Extérieur</label>
                <select id="nl-ma">${acceptees.map((t, i) => `<option value="${t.id}" ${i === 1 ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}</select></div>
            </div>
            <div style="display:flex;gap:8px;">
              <div class="field" style="flex:1;"><label for="nl-md">Date (facultatif)</label><input id="nl-md" type="datetime-local" /></div>
              <div class="field" style="flex:1;"><label for="nl-mr">Journée / tour</label><input id="nl-mr" maxlength="40" placeholder="J1, Demi-finale…" /></div>
            </div>
            <button class="btn btn-secondary" id="nl-addm" style="width:100%;margin-bottom:12px;">Programmer la rencontre</button>`
            : '<div class="muted" style="font-size:12.5px;margin-bottom:12px;">Acceptez au moins deux équipes pour programmer des rencontres.</div>'}

          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <button class="btn btn-ghost" id="nl-edit" style="flex:1;">Modifier</button>
            ${c.status === 'open' ? '<button class="btn btn-ghost" data-status="running" style="flex:1;">Clore les inscriptions</button>' : ''}
            ${c.status === 'running' ? '<button class="btn btn-ghost" data-status="finished" style="flex:1;">Terminer</button>' : ''}
            ${['open', 'running'].includes(c.status) ? '<button class="btn btn-ghost" data-status="cancelled" style="flex:1;">Annuler</button>' : ''}
            ${['finished', 'cancelled'].includes(c.status) ? '<button class="btn btn-ghost" data-status="open" style="flex:1;">Rouvrir</button>' : ''}
          </div>
        </div>` : ''}
    `, () => {
      const action = async (fn) => {
        try { await fn(); fermerPanneau(); fiche(id); liste(); }
        catch (e) { await showAlert(message(e)); }
      };

      document.getElementById('nl-reg')?.addEventListener('click', () => action(() => rpc('league_register', {
        p_competition_id: id,
        p_team_name: document.getElementById('nl-tn').value,
        p_roster: document.getElementById('nl-tr').value,
      })));
      document.getElementById('nl-withdraw')?.addEventListener('click', async () => {
        if (!(await showConfirm('Retirer votre équipe de la compétition ?'))) return;
        action(() => rpc('league_withdraw', { p_team_id: moi.id }));
      });

      document.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', () =>
        action(() => rpc('league_decide_team', { p_team_id: b.getAttribute('data-accept'), p_accept: true }))));
      document.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', () =>
        action(() => rpc('league_decide_team', { p_team_id: b.getAttribute('data-reject'), p_accept: false }))));

      document.getElementById('nl-addm')?.addEventListener('click', () => {
        const date = document.getElementById('nl-md').value;
        action(() => rpc('league_add_match', {
          p_competition_id: id,
          p_home_team_id: document.getElementById('nl-mh').value,
          p_away_team_id: document.getElementById('nl-ma').value,
          p_scheduled_at: date ? new Date(date).toISOString() : null,
          p_round_label: document.getElementById('nl-mr').value,
        }));
      });

      document.querySelectorAll('[data-score]').forEach((b) => b.addEventListener('click', () => {
        const m = c.matches.find((x) => x.id === b.getAttribute('data-score'));
        saisirScore(m, () => { fiche(id); liste(); });
      }));
      document.querySelectorAll('[data-suppr]').forEach((b) => b.addEventListener('click', async () => {
        if (!(await showConfirm('Supprimer cette rencontre ? Son résultat sortira du classement.'))) return;
        action(() => rpc('league_cancel_match', { p_match_id: b.getAttribute('data-suppr') }));
      }));

      document.getElementById('nl-edit')?.addEventListener('click', () => composer(c));
      document.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', async () => {
        const s = b.getAttribute('data-status');
        if (s === 'cancelled' && !(await showConfirm('Annuler la compétition ? Les équipes en seront averties.'))) return;
        action(() => rpc('league_set_status', { p_id: id, p_status: s }));
      }));
    });
  }

  function saisirScore(m, apres) {
    panneau(`${m.home} – ${m.away}`, `
      <div style="display:flex;gap:10px;align-items:flex-end;">
        <div class="field" style="flex:1;"><label for="nl-sh">${escapeHtml(m.home)}</label>
          <input id="nl-sh" type="number" min="0" max="999" step="1" value="${m.home_score ?? ''}" /></div>
        <div class="field" style="flex:1;"><label for="nl-sa">${escapeHtml(m.away)}</label>
          <input id="nl-sa" type="number" min="0" max="999" step="1" value="${m.away_score ?? ''}" /></div>
      </div>
      <button class="btn btn-primary" id="nl-sok" style="width:100%;">Enregistrer le score</button>
      ${m.status === 'played' ? '<button class="btn btn-ghost" id="nl-sclear" style="width:100%;margin-top:8px;">Effacer le résultat</button>' : ''}
      <div class="muted" id="nl-smsg" style="font-size:12.5px;margin-top:10px;"></div>
    `, () => {
      const envoyer = async (h, a) => {
        try {
          await rpc('league_set_result', { p_match_id: m.id, p_home_score: h, p_away_score: a });
          fermerPanneau(); apres();
        } catch (e) { document.getElementById('nl-smsg').textContent = 'Échec : ' + message(e); }
      };
      document.getElementById('nl-sok').addEventListener('click', () => {
        const h = document.getElementById('nl-sh').value;
        const a = document.getElementById('nl-sa').value;
        if (h === '' || a === '') { document.getElementById('nl-smsg').textContent = 'Saisissez les deux scores.'; return; }
        envoyer(Number(h), Number(a));
      });
      document.getElementById('nl-sclear')?.addEventListener('click', () => envoyer(null, null));
    });
  }

  // --------------------------------------------------------------------------
  async function composer(existant) {
    let orgs = [];
    try { orgs = await myOrganizations(); } catch (_) { orgs = []; }
    const c = existant || {};

    panneau(existant ? 'Modifier la compétition' : 'Organiser une compétition', `
      <div class="field"><label for="nl-n">Nom</label>
        <input id="nl-n" maxlength="80" value="${escapeHtml(c.name || '')}" placeholder="Coupe de Los Santos" /></div>
      <div style="display:flex;gap:10px;">
        <div class="field" style="flex:1;"><label for="nl-d">Discipline</label>
          <input id="nl-d" maxlength="40" value="${escapeHtml(c.discipline || '')}" placeholder="Football, course, boxe…" /></div>
        <div class="field" style="flex:1;"><label for="nl-m">Équipes max (facultatif)</label>
          <input id="nl-m" type="number" min="2" max="64" step="1" value="${c.max_teams ?? ''}" /></div>
      </div>
      <div class="field"><label for="nl-desc">Règlement, lieu, calendrier</label>
        <textarea id="nl-desc" rows="5" maxlength="4000">${escapeHtml(c.description || '')}</textarea></div>
      <div class="field"><label for="nl-p">Dotation (facultatif)</label>
        <input id="nl-p" maxlength="120" value="${escapeHtml(c.prize_info || '')}" placeholder="Trophée + 50 000 $" /></div>
      ${orgs.length ? `<div class="field"><label for="nl-o">Au nom de</label>
        <select id="nl-o"><option value="">Moi-même</option>${orgs.map((o) =>
          `<option value="${o.id}" ${o.id === c.organization_id ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('')}</select></div>` : ''}
      <button class="btn btn-primary" id="nl-save" style="width:100%;">${existant ? 'Enregistrer' : 'Ouvrir les inscriptions'}</button>
      <div class="muted" id="nl-msg" style="font-size:12.5px;margin-top:10px;">
        La dotation est indicative : Newpad ne verse rien, un prix se paie par virement Newman Bank.
      </div>
    `, () => {
      document.getElementById('nl-save').addEventListener('click', async () => {
        const msg = document.getElementById('nl-msg');
        const max = document.getElementById('nl-m').value;
        msg.textContent = 'Enregistrement…';
        try {
          const nouvelId = await rpc('league_save', {
            p_name: document.getElementById('nl-n').value,
            p_discipline: document.getElementById('nl-d').value,
            p_description: document.getElementById('nl-desc').value,
            p_id: existant ? c.id : null,
            p_prize_info: document.getElementById('nl-p').value,
            p_max_teams: max === '' ? null : Number(max),
            p_organization_id: document.getElementById('nl-o')?.value || null,
          });
          fermerPanneau(); liste(); fiche(nouvelId);
        } catch (e) { msg.textContent = 'Échec : ' + message(e); }
      });
    });
  }

  // --------------------------------------------------------------------------
  function panneau(titre, html, apres) {
    fermerPanneau();
    const el = document.createElement('aside');
    el.className = 'app-panel';
    el.id = 'nl-panel';
    el.innerHTML = `
      <div class="app-panel-head">
        <strong>${escapeHtml(titre)}</strong>
        <button class="btn btn-ghost" id="nl-close" style="padding:2px 9px;">✕</button>
      </div>
      <div class="app-panel-body">${html}</div>
      <style>
        .nl-h { font-size: 13px; color: var(--ivory); margin: 4px 0 8px; }
        .nl-table { margin-bottom: 14px; font-size: 12.5px; }
        .nl-table th, .nl-table td { padding: 6px 8px; font-size: 12.5px; }
        .nl-orga { border-top: 1px solid var(--card-border); padding-top: 12px; margin-top: 4px; }
      </style>`;
    document.querySelector('.app-frame').appendChild(el);
    document.getElementById('nl-close').addEventListener('click', fermerPanneau);
    if (apres) apres();
  }

  function fermerPanneau() { document.getElementById('nl-panel')?.remove(); }

  document.getElementById('nl-new')?.addEventListener('click', () => composer(null));

  await liste();
}

// ============================================================================
// NEWPAD — Coquille commune (sidebar catégorisée repliable + topbar +
// notifications) partagée par les 4 interfaces internes (Client/Employé/
// Admin/IRS). Chaque écran appelle renderShell() puis remplit le conteneur
// `.content` retourné avec son propre contenu.
// ============================================================================

import logoUrl from '../assets/logo.svg';
import { supabase } from './supabaseClient.js';
import { navigate } from './router.js';
import { getMyNotifications, markNotificationsRead, markAllNotificationsRead, subscribeToMyNotifications } from './notifications.js';
import { attachExternalLinkCopy } from './externalLink.js';
import { getSystemFlags } from './systemSettings.js';
import { escapeHtml } from './format.js';

function initials(name) {
  return (name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "à l'instant";
  if (mins < 60) return `il y a ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  return `il y a ${days} j`;
}

function renderNavItem(item, activeKey) {
  const active = item.key === activeKey;
  // Lien externe (ex: Discord) — nouvel onglet, ne passe jamais par le
  // routeur interne basé sur le hash. `data-copy` déclenche en plus une copie
  // du lien dans le presse-papiers (voir attachExternalLinkCopy) : dans le
  // navigateur intégré de FiveM (CEF), l'ouverture d'un nouvel onglet externe
  // est bloquée silencieusement — la copie donne un moyen de repli pour que
  // le joueur puisse coller le lien ailleurs (Discord, navigateur du jeu...).
  if (item.external) {
    return `
      <a class="sidebar-link" href="${item.path}" target="_blank" rel="noopener noreferrer" data-copy="${item.path}">
        <span class="icon">${item.icon || '•'}</span>
        <span>${item.label}</span>
      </a>
    `;
  }
  return `
    <a class="sidebar-link ${active ? 'sidebar-link-active' : ''}" href="#${item.path}">
      <span class="icon">${item.icon || '•'}</span>
      <span>${item.label}</span>
    </a>
  `;
}

/**
 * @param {HTMLElement} app
 * @param {object} profile
 * @param {string} roleLabel
 * @param {Array} sections - mix of top-level items ({key,label,path,icon}) and
 *   categories ({category, items:[...]})
 * @param {string} activeKey
 * @param {object} [opts] - { footerItems: [...], banner: string }
 * @returns {{content: HTMLElement}}
 */
export function renderShell(app, profile, roleLabel, sections, activeKey, opts = {}) {
  const navHtml = sections
    .map((s) => {
      if (s.category) {
        const hasActive = s.items.some((i) => i.key === activeKey);
        return `
          <details class="sidebar-category" ${hasActive ? 'open' : 'open'}>
            <summary>${s.category}</summary>
            <div class="sidebar-category-items">
              ${s.items.map((i) => renderNavItem(i, activeKey)).join('')}
            </div>
          </details>
        `;
      }
      return `<div class="sidebar-top-item">${renderNavItem(s, activeKey)}</div>`;
    })
    .join('');

  const footerHtml = (opts.footerItems || [])
    .map((i) => renderNavItem(i, activeKey))
    .join('');

  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar-brand">
          <img src="${logoUrl}" width="30" height="30" alt="" />
          <div>
            <div class="font-display" style="font-size:14px;">NEWMAN BANK</div>
            <div class="muted" style="font-size:10px;">BNW-VLT-1924</div>
          </div>
        </div>
        <nav class="sidebar-nav">${navHtml}</nav>
        <div class="sidebar-footer">
          ${footerHtml}
          <button id="logout-btn" class="btn btn-ghost" style="width:100%; justify-content:flex-start; margin-top:6px;">↩ Déconnexion</button>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <div class="flex items-center gap-md">
            <button id="mobile-menu-btn" class="btn btn-ghost" style="display:none;" aria-label="Menu">☰</button>
            <div class="font-display" style="font-size:16px;">${roleLabel}</div>
          </div>
          <div class="flex items-center gap-md" style="position:relative;">
            <button id="notif-bell" class="notif-bell" aria-label="Notifications">
              🔔
              <span id="notif-badge" class="notif-badge" style="display:none;">0</span>
            </button>
            <div class="flex items-center gap-sm">
              <div class="avatar">${initials(profile.display_name)}</div>
              <span style="font-size:14px;">${profile.display_name}</span>
            </div>
            <div id="notif-panel" class="notif-panel">
              <div class="notif-panel-header">
                <strong style="font-size:13px;">Notifications</strong>
                <button id="notif-mark-all" class="btn btn-ghost" style="padding:4px 8px; font-size:12px;">Tout marquer lu</button>
              </div>
              <div id="notif-list"></div>
            </div>
          </div>
        </header>
        ${opts.banner ? `<div class="readonly-banner">${opts.banner}</div>` : ''}
        <div id="system-banners"></div>
        <main class="content" id="content"></main>
      </div>
    </div>
  `;

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await supabase.auth.signOut();
  });

  const mobileBtn = document.getElementById('mobile-menu-btn');
  const sidebar = document.getElementById('sidebar');
  if (window.innerWidth <= 900) {
    mobileBtn.style.display = 'inline-flex';
    mobileBtn.addEventListener('click', () => sidebar.classList.toggle('open'));
  }

  setupNotifications(profile);
  setupSystemBanners(profile);
  attachExternalLinkCopy(app);

  return { content: document.getElementById('content') };
}

// Bannière d'annonce (visible par tout le monde quand activée depuis
// /admin/system) + notice de mode maintenance. Le rôle admin ne voit qu'une
// notice discrète (jamais bloquante) pour ne jamais se retrouver enfermé hors
// de l'écran qui permet justement de désactiver la maintenance.
async function setupSystemBanners(profile) {
  const host = document.getElementById('system-banners');
  if (!host) return;
  try {
    const flags = await getSystemFlags();
    const parts = [];
    if (flags.bannerEnabled && flags.bannerMessage) {
      parts.push(`<div class="readonly-banner" style="background: rgba(201,162,39,0.12); border-color: var(--gold);">📣 ${escapeHtml(flags.bannerMessage)}</div>`);
    }
    if (flags.maintenanceEnabled) {
      parts.push(
        profile.role === 'admin'
          ? `<div class="readonly-banner">🛠 Mode maintenance activé (visible par les autres rôles) — désactivable depuis Configuration système.</div>`
          : `<div class="readonly-banner">🛠 La banque effectue actuellement une opération de maintenance. Certaines fonctionnalités peuvent être temporairement indisponibles ou ralenties.</div>`
      );
    }
    host.innerHTML = parts.join('');
  } catch (_) { /* silencieux — l'app reste utilisable sans ces bannières */ }
}

// notify_all_staff() envoie le même lien (généralement '/employee/...') à la
// fois aux employés et aux admins (sauf notifications admin_only). Un admin
// qui clique dessus se faisait auparavant rediriger vers son propre tableau
// de bord par guardedRoleRender (rôle attendu 'employee' != 'admin' réel).
// On adapte donc le préfixe du lien au rôle réel de l'utilisateur connecté.
function remapLinkForRole(link, role) {
  if (role === 'admin' && link.startsWith('/employee/')) {
    return '/admin/' + link.slice('/employee/'.length);
  }
  return link;
}

async function setupNotifications(profile) {
  const bell = document.getElementById('notif-bell');
  const panel = document.getElementById('notif-panel');
  const badge = document.getElementById('notif-badge');
  const list = document.getElementById('notif-list');
  const markAllBtn = document.getElementById('notif-mark-all');

  async function refresh() {
    let items = [];
    try {
      items = await getMyNotifications(20);
    } catch (_) { /* silencieux — l'écran reste utilisable sans notifications */ }
    const unread = items.filter((n) => !n.is_read).length;
    badge.style.display = unread > 0 ? 'flex' : 'none';
    badge.textContent = unread > 9 ? '9+' : String(unread);
    list.innerHTML = items.length
      ? items
          .map(
            (n) => `
        <div class="notif-item ${n.is_read ? '' : 'unread'}" data-id="${n.id}" data-link="${n.link || ''}">
          <div class="notif-item-title">${n.title}</div>
          ${n.body ? `<div class="notif-item-body">${n.body}</div>` : ''}
          <div class="notif-item-time">${timeAgo(n.created_at)}</div>
        </div>
      `
          )
          .join('')
      : '<div class="notif-empty">Aucune notification.</div>';

    list.querySelectorAll('.notif-item').forEach((el) => {
      el.addEventListener('click', async () => {
        const id = el.getAttribute('data-id');
        const link = el.getAttribute('data-link');
        try { await markNotificationsRead([id]); } catch (_) {}
        panel.classList.remove('open');
        if (link) navigate(remapLinkForRole(link, profile.role));
        else refresh();
      });
    });
  }

  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) refresh();
  });
  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== bell) panel.classList.remove('open');
  });
  markAllBtn.addEventListener('click', async () => {
    try { await markAllNotificationsRead(); await refresh(); } catch (_) {}
  });

  await refresh();
  subscribeToMyNotifications(profile.id, () => refresh());
}

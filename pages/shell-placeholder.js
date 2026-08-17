import logoUrl from '../assets/logo.svg';
import { supabase } from '../lib/supabaseClient.js';

// Coquille temporaire commune aux 4 interfaces internes — sert de socle
// (sidebar + topbar + cloche notifications) que les phases 3 à 6 remplacent
// écran par écran par le contenu réel de chaque rôle.
export function renderRoleShellPlaceholder(app, profile, roleLabel) {
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="sidebar-brand">
          <img src="${logoUrl}" width="30" height="30" alt="" />
          <div>
            <div class="font-display" style="font-size:14px;">NEWMAN BANK</div>
            <div class="muted" style="font-size:10px;">BNW-VLT-1924</div>
          </div>
        </div>
        <nav class="sidebar-nav">
          <div class="sidebar-item sidebar-item-active">Accueil</div>
        </nav>
        <div class="sidebar-footer">
          <button id="logout-btn" class="btn btn-ghost" style="width:100%;">Déconnexion</button>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <div class="font-display" style="font-size:16px;">${roleLabel}</div>
          <div class="flex items-center gap-md">
            <button class="btn btn-ghost" aria-label="Notifications">🔔</button>
            <div class="flex items-center gap-sm">
              <div style="width:32px;height:32px;border-radius:50%;background:var(--gold-gradient);"></div>
              <span>${profile.display_name}</span>
            </div>
          </div>
        </header>
        <main class="content">
          <div class="card" style="max-width:560px;">
            <h2>Bienvenue, ${profile.display_name}.</h2>
            <p class="muted">
              L'interface ${roleLabel} complète est en cours de construction (phases suivantes du projet).
              L'authentification, le routing par rôle et la garde d'accès sont déjà opérationnels —
              vous êtes bien connecté(e) en tant que <strong class="gold">${profile.role}</strong>.
            </p>
          </div>
        </main>
      </div>
    </div>
    <style>
      .shell { display:flex; min-height:100vh; }
      .sidebar { width: var(--sidebar-width); background: var(--bg-950); border-right:1px solid var(--card-border); display:flex; flex-direction:column; padding:20px 16px; }
      .sidebar-brand { display:flex; align-items:center; gap:10px; padding: 0 8px 20px; }
      .sidebar-nav { flex:1; }
      .sidebar-item { padding:10px 12px; border-radius:var(--radius-sm); font-size:14px; color:var(--text-muted); cursor:pointer; }
      .sidebar-item-active { background: rgba(201,162,39,0.1); color: var(--gold-light); }
      .main { flex:1; display:flex; flex-direction:column; }
      .topbar { height: var(--topbar-height); display:flex; align-items:center; justify-content:space-between; padding:0 24px; border-bottom:1px solid var(--card-border); }
      .content { padding:24px; flex:1; }
    </style>
  `;

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await supabase.auth.signOut();
  });
}

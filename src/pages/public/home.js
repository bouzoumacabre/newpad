import logoUrl from '../../assets/logo.svg';
import { supabase } from '../../lib/supabaseClient.js';
import { DISCORD_INVITE_URL } from '../../lib/constants.js';

// Contenu de secours si la base n'est pas encore joignable (mode démo hors-ligne) —
// une fois Supabase connecté, tout provient de la table `site_content` (pilotée
// depuis Admin > Contenu du site), rien n'est figé en dur en conditions réelles.
const FALLBACK = {
  hero: { title_line1: "L'excellence bancaire", title_line2: 'au service de votre patrimoine.', subtitle: 'Newman Bank, votre banque privée à Los Santos depuis 1924.', cta_primary: 'Demander à devenir client', cta_secondary: 'Déjà client ? Se connecter' },
  key_stats: { stats: [{ label: 'Actifs sous gestion', value: '482 M$' }, { label: 'Clients privés', value: '428' }, { label: 'Succursales', value: '3' }, { label: 'Satisfaction', value: '98%' }] },
  service_catalog: [
    { title: 'Gestion de patrimoine', description: 'Solutions sur-mesure pour protéger et faire fructifier votre richesse.' },
    { title: 'Financement professionnel', description: 'Des prêts adaptés à vos ambitions et à vos projets entrepreneuriaux.' },
    { title: 'Réserve de valeur', description: "Achat de lingots d'or, coffres-forts sécurisés et dépôts en toute confiance." },
    { title: 'Service discret & privilégié', description: 'Un accompagnement personnalisé, dans la plus grande confidentialité.' },
  ],
  city_news: [
    { category: 'Économie', title: 'Le marché immobilier en pleine expansion à Los Santos', excerpt: 'Les prix continuent leur progression dans les quartiers d\'affaires.', date: '2026-08-10' },
    { category: 'Événement', title: 'Sommet économique annuel : les acteurs majeurs réunis à Los Santos', excerpt: 'Un rendez-vous incontournable pour les grandes fortunes de la ville.', date: '2026-08-05' },
    { category: 'Finance', title: 'Taux directeur : la banque centrale maintient sa position', excerpt: "Aucun changement attendu avant la fin de l'année.", date: '2026-07-28' },
  ],
  top10: [
    { rank: 1, name: 'Abraham Newman', net_worth: '128 M$', sector: 'Banque & finance' },
    { rank: 2, name: 'Dov Lévy', net_worth: '94 M$', sector: 'Immobilier' },
    { rank: 3, name: 'Meïer Taïeb', net_worth: '81 M$', sector: 'Négoce' },
  ],
  quote: [
    { author: 'Abraham Newman', text: 'La discrétion est la première forme de richesse.' },
  ],
  testimonial: [
    { author: 'Meïer Taïeb', role: 'Client depuis 2019', text: "Un service d'une discrétion et d'un professionnalisme rares." },
  ],
};

const FETCH_TIMEOUT_MS = 4000;

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

async function loadContent() {
  try {
    const query = supabase.from('site_content').select('*').eq('area', 'public').eq('is_active', true).order('sort_order');
    const { data, error } = await Promise.race([query, timeout(FETCH_TIMEOUT_MS)]);
    if (error || !data || data.length === 0) throw error || new Error('empty');
    const grouped = {};
    for (const row of data) {
      if (!grouped[row.section_key]) grouped[row.section_key] = [];
      grouped[row.section_key].push(row.content);
    }
    return {
      hero: grouped.hero?.[0] || FALLBACK.hero,
      key_stats: grouped.key_stats?.[0] || FALLBACK.key_stats,
      service_catalog: grouped.service_catalog || FALLBACK.service_catalog,
      city_news: grouped.city_news || FALLBACK.city_news,
      top10: grouped.top10 || FALLBACK.top10,
      quote: grouped.quote || FALLBACK.quote,
      testimonial: grouped.testimonial || FALLBACK.testimonial,
    };
  } catch (_) {
    return FALLBACK;
  }
}

export async function renderPublicHome(app) {
  app.innerHTML = `<div class="flex justify-between items-center" style="padding:24px;"><span class="muted">Chargement…</span></div>`;
  const c = await loadContent();

  app.innerHTML = `
    <div class="public-home">
      <header class="public-header">
        <div class="public-header-inner">
          <div class="flex items-center gap-sm">
            <img src="${logoUrl}" width="32" height="32" alt="Newman Bank" />
            <div>
              <div class="font-display" style="font-size:16px;">NEWMAN BANK</div>
              <div class="muted" style="font-size:10px;letter-spacing:0.08em;">BNW-VLT-1924</div>
            </div>
          </div>
          <nav class="public-nav">
            <a href="#/" data-scroll-top="1">Accueil</a>
            <a href="#services" data-scroll-to="services">Services</a>
            <a href="#news" data-scroll-to="news">Actualités</a>
            <a href="${DISCORD_INVITE_URL}" target="_blank" rel="noopener noreferrer">Discord</a>
            <a href="#/login">Se connecter</a>
          </nav>
          <a href="#/signup" class="btn btn-primary">Espace client</a>
        </div>
      </header>

      <section class="hero">
        <div class="hero-content">
          <h1 class="font-display hero-title">${c.hero.title_line1}<br/>${c.hero.title_line2}</h1>
          <p class="muted hero-subtitle">${c.hero.subtitle}</p>
          <div class="flex gap-md" style="margin-top:24px;">
            <a href="#/signup" class="btn btn-primary">${c.hero.cta_primary}</a>
          </div>
          <p style="margin-top:16px;"><a href="#/login" class="muted">${c.hero.cta_secondary}</a></p>
        </div>
      </section>

      <section class="stats">
        ${c.key_stats.stats.map(s => `
          <div class="stat-tile">
            <div class="font-display stat-value">${s.value}</div>
            <div class="muted stat-label">${s.label}</div>
          </div>
        `).join('')}
      </section>

      <section id="services" class="section">
        <h2 class="font-display section-title">Nos services d'exception</h2>
        <div class="services-grid">
          ${c.service_catalog.map(s => `
            <div class="card service-card">
              <h3 class="gold" style="font-size:16px;">${s.title}</h3>
              <p class="muted" style="font-size:13px;">${s.description}</p>
            </div>
          `).join('')}
        </div>
      </section>

      <section class="section">
        <h2 class="font-display section-title">Classement des grandes fortunes</h2>
        <div class="card">
          <table>
            <thead><tr><th>#</th><th>Nom</th><th>Secteur</th><th>Fortune estimée</th></tr></thead>
            <tbody>
              ${c.top10.map(t => `<tr><td class="gold">${t.rank}</td><td>${t.name}</td><td class="muted">${t.sector}</td><td>${t.net_worth}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${c.quote.map(q => `<blockquote class="quote">« ${q.text} »<footer class="muted">— ${q.author}</footer></blockquote>`).join('')}
      </section>

      <section id="news" class="section">
        <h2 class="font-display section-title">Actualités &amp; informations de la ville</h2>
        <div class="news-grid">
          ${c.city_news.map(n => `
            <div class="card news-card">
              <span class="badge badge-neutral">${n.category}</span>
              <h3 style="font-size:15px;margin-top:10px;">${n.title}</h3>
              <p class="muted" style="font-size:13px;">${n.excerpt}</p>
              <div class="muted" style="font-size:11px;">${n.date}</div>
            </div>
          `).join('')}
        </div>
      </section>

      ${c.testimonial.length ? `
      <section class="section">
        <h2 class="font-display section-title">Ils nous font confiance</h2>
        ${c.testimonial.map(t => `<blockquote class="quote">« ${t.text} »<footer class="muted">— ${t.author}, ${t.role}</footer></blockquote>`).join('')}
      </section>` : ''}

      <footer class="public-footer">
        <div class="flex items-center gap-sm">
          <img src="${logoUrl}" width="24" height="24" alt="" />
          <span class="muted" style="font-size:13px;">Newman Bank — BNW-VLT-1924 — © 2026</span>
        </div>
      </footer>
    </div>

    <style>
      .public-header { position:sticky; top:0; z-index:10; backdrop-filter: blur(8px); background: rgba(5,10,22,0.85); border-bottom:1px solid var(--card-border); }
      .public-header-inner { max-width:1100px; margin:0 auto; display:flex; align-items:center; justify-content:space-between; padding:14px 24px; gap:24px; }
      .public-nav { display:flex; gap:24px; font-size:14px; }
      .public-nav a { color: var(--text-muted); }
      .public-nav a:hover { color: var(--gold-light); }
      .hero { max-width:1100px; margin: 0 auto; padding: 80px 24px 60px; }
      .hero-title { font-size:42px; line-height:1.15; max-width:640px; }
      .hero-subtitle { font-size:16px; max-width:520px; margin-top:12px; }
      .stats { max-width:1100px; margin:0 auto; padding:0 24px 60px; display:grid; grid-template-columns:repeat(4,1fr); gap:16px; }
      .stat-tile { background: var(--card-bg); border:1px solid var(--card-border); border-radius: var(--radius-md); padding:20px; text-align:center; }
      .stat-value { font-size:26px; }
      .stat-label { font-size:12px; margin-top:4px; }
      .section { max-width:1100px; margin:0 auto; padding: 40px 24px; }
      .section-title { font-size:24px; margin-bottom:24px; text-align:center; }
      .services-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; }
      .news-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
      .quote { border-left:2px solid var(--gold); padding:12px 20px; margin:20px 0; font-family:var(--font-display); font-style:italic; color:var(--ivory); }
      .quote footer { font-family:var(--font-body); font-style:normal; font-size:12px; margin-top:6px; }
      .public-footer { max-width:1100px; margin:0 auto; padding:32px 24px 60px; border-top:1px solid var(--card-border); }
      @media (max-width: 900px) {
        .stats, .services-grid, .news-grid { grid-template-columns: repeat(2,1fr); }
        .public-nav { display:none; }
      }
    </style>
  `;

  // Le routeur de l'application intercepte tout changement de hash — un lien
  // du type href="#services" était donc traité comme une route inconnue et
  // renvoyait vers l'accueil (rechargement complet) au lieu de défiler
  // jusqu'à la section. On empêche le changement de hash et on défile
  // manuellement pour ces liens d'ancrage internes à la page.
  app.querySelectorAll('[data-scroll-to]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(el.getAttribute('data-scroll-to'));
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  app.querySelectorAll('[data-scroll-top]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

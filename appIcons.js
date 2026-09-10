// ============================================================================
// Jeu d'icônes Newpad — SVG en ligne
// ============================================================================
// Aucune police d'icônes, aucune dépendance externe : le navigateur intégré de
// FiveM télécharge déjà l'application entière, il n'a pas à aller chercher un
// fichier de plus sur un CDN qu'il peut ne pas atteindre. Chaque icône est un
// tracé unique, dessiné sur une grille de 24, sans remplissage : elle prend la
// couleur d'accent de son application (`currentColor`) et reste nette à
// n'importe quelle taille.
//
// `icon_key` en base pointe vers l'une de ces clés. Une icône téléversée par
// l'admin (`icon_url`) a la priorité ; ce jeu est la valeur de repli et la
// livrée par défaut de toute nouvelle application.

const P = {
  bank: '<path d="M3 10 12 4l9 6"/><path d="M5 10v8m4-8v8m6-8v8m4-8v8"/><path d="M3 20h18"/>',
  news: '<path d="M4 5h12v14H4z"/><path d="M16 9h4v8a2 2 0 0 1-4 0z"/><path d="M7 8h6M7 11h6M7 14h4"/>',
  video: '<rect x="3" y="6" width="14" height="12" rx="2"/><path d="M17 10l4-2v8l-4-2z"/><path d="M8 10.5v3l3-1.5z"/>',
  directory: '<path d="M4 4h11v16H4z"/><path d="M15 9h5v11h-5"/><path d="M7 8h5M7 11h5M7 14h3"/>',
  market: '<path d="M4 8h16l-1.2 11.2a1 1 0 0 1-1 .8H6.2a1 1 0 0 1-1-.8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M3 12h18"/>',
  work: '<circle cx="12" cy="8" r="3"/><path d="M5 20a7 7 0 0 1 14 0"/><path d="M17 4h4M19 2v4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  social: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="10" r="2.4"/><path d="M3 19a6 6 0 0 1 12 0"/><path d="M15.5 19a4.5 4.5 0 0 1 5.5-4.4"/>',
  trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v1a3 3 0 0 0 3 3"/><path d="M17 6h3v1a3 3 0 0 1-3 3"/><path d="M10 14h4l.6 4H9.4z"/><path d="M8 20h8"/>',
  mask: '<path d="M3 8c3-2 15-2 18 0 0 6-3 10-9 12C6 18 3 14 3 8z"/><path d="M8.5 11h2M13.5 11h2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8 14h3v3H8z"/>',
  government: '<path d="M12 3l9 5H3z"/><path d="M6 8v9m4-9v9m4-9v9m4-9v9"/><path d="M3 21h18"/>',
  megaphone: '<path d="M4 10v4a1 1 0 0 0 1 1h3l7 4V5l-7 4H5a1 1 0 0 0-1 1z"/><path d="M18 9a4 4 0 0 1 0 6"/>',
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/><path d="M10 20v-5h4v5"/>',
  car: '<path d="M4 16v-3l2-5h12l2 5v3"/><path d="M3 16h18v3h-3v-3M6 19H3v-3"/><path d="M7 12h10"/>',
  gem: '<path d="M6 4h12l3 5-9 11L3 9z"/><path d="M3 9h18M9 4l-3 5 6 11 6-11-3-5"/>',
  medical: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M9 6V4h6v2"/><path d="M12 10v6M9 13h6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  music: '<path d="M9 18V6l11-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>',
  ai: '<path d="M12 3l2.2 4.8L19 10l-4.8 2.2L12 17l-2.2-4.8L5 10l4.8-2.2z"/><path d="M18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9z"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8.5-8 9.5C7.5 20.5 4 17 4 12V6z"/><path d="M9 12l2 2 4-4"/>',
  plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
};

export const ICON_KEYS = Object.keys(P);

export function appIconSvg(key, size = 34) {
  const d = P[key] || P.grid;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
    stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true" focusable="false">${d}</svg>`;
}

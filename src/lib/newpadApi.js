// ============================================================================
// Accès au noyau Newpad : registre d'applications et organisations
// ============================================================================
import { supabase } from './supabaseClient.js';

// ----------------------------------------------------------------------------
// Registre des applications
// ----------------------------------------------------------------------------

// L'écran d'accueil est reconstruit à chaque navigation. Sans cache, revenir
// d'une application vers la tablette repartirait systématiquement sur un
// aller-retour réseau avant d'afficher la moindre icône — visible en jeu, où la
// latence est déjà celle du serveur FiveM. Le cache est invalidé par le canal
// temps réel dès qu'un administrateur modifie le registre, donc il ne peut pas
// afficher durablement une version périmée.
let cache = null;
let cacheAt = 0;
const CACHE_MS = 60000;

export function invalidateAppCache() {
  cache = null;
  cacheAt = 0;
}

export async function listApps({ force = false } = {}) {
  if (!force && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  const { data, error } = await supabase
    .from('app_registry')
    .select('id, slug, name, short_name, description, icon_key, icon_url, logo_url, accent_color, route, admin_route, page, position, is_enabled, is_system_app, status, visibility, access_level, owner_organization_id')
    .order('page', { ascending: true })
    .order('position', { ascending: true });
  if (error) throw error;
  cache = data || [];
  cacheAt = Date.now();
  return cache;
}

// Applications réellement affichées sur la tablette. L'admin voit aussi les
// applications désactivées dans son interface d'administration, mais sa propre
// tablette reste celle de tout le monde : une icône désactivée n'y figure pas,
// sinon il ne peut pas constater l'effet de ce qu'il vient de faire.
export async function listLauncherApps(options) {
  const apps = await listApps(options);
  return apps.filter((a) => a.is_enabled);
}

export async function findAppBySlug(slug) {
  const apps = await listApps();
  return apps.find((a) => a.slug === slug) || null;
}

export async function findAppByRoute(route) {
  const apps = await listApps();
  const cible = String(route || '').replace(/\/+$/, '') || '/';
  return apps.find((a) => a.route.replace(/\/+$/, '') === cible) || null;
}

let canalRegistre = null;

// Un changement d'icône, de nom ou de position doit apparaître sur la tablette
// de chaque joueur connecté sans rechargement (§9).
export function subscribeAppRegistry(onChange) {
  if (canalRegistre) return canalRegistre;
  canalRegistre = supabase
    .channel('newpad-app-registry')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_registry' }, () => {
      invalidateAppCache();
      try { onChange && onChange(); } catch (e) { console.error('[newpad] rafraîchissement registre', e); }
    })
    .subscribe();
  return canalRegistre;
}

export function unsubscribeAppRegistry() {
  if (!canalRegistre) return;
  try { supabase.removeChannel(canalRegistre); } catch (_) { /* déjà fermé */ }
  canalRegistre = null;
}

// ----------------------------------------------------------------------------
// Administration du registre (§8, §10)
// ----------------------------------------------------------------------------

// L'autorité sur « ai-je le droit d'ouvrir cette application ». Le lanceur
// devine pour dessiner un cadenas ; cette réponse-ci décide.
export async function canOpenApp(slug) {
  const { data, error } = await supabase.rpc('can_open_app', { p_slug: slug });
  if (error) return false;
  return data === true;
}

export async function isNewpadAdmin() {
  const { data, error } = await supabase.rpc('is_newpad_admin');
  if (error) return false;
  return data === true;
}

export async function upsertApp(app) {
  const { data, error } = await supabase.rpc('newpad_upsert_app', {
    p_id: app.id || null,
    p_slug: app.slug,
    p_name: app.name,
    p_route: app.route,
    p_short_name: app.short_name || null,
    p_description: app.description || null,
    p_icon_key: app.icon_key || null,
    p_icon_url: app.icon_url || null,
    p_logo_url: app.logo_url || null,
    p_accent_color: app.accent_color || null,
    p_page: app.page || 1,
    p_position: app.position ?? null,
    p_owner_organization_id: app.owner_organization_id || null,
    p_is_enabled: app.is_enabled !== false,
    p_status: app.status || 'soon',
    p_visibility: app.visibility || 'public',
    p_admin_route: app.admin_route || null,
    p_access_level: app.access_level || 'client',
  });
  if (error) throw error;
  invalidateAppCache();
  return data;
}

export async function setAppLayout(items) {
  const { error } = await supabase.rpc('newpad_set_layout', { p_items: items });
  if (error) throw error;
  invalidateAppCache();
}

export async function deleteApp(id) {
  const { error } = await supabase.rpc('newpad_delete_app', { p_id: id });
  if (error) throw error;
  invalidateAppCache();
}

// ----------------------------------------------------------------------------
// Autorisations nominatives (applications restreintes — NewDark)
// ----------------------------------------------------------------------------

export async function listAppAccess(appId) {
  const { data, error } = await supabase.rpc('newpad_list_app_access', { p_app_id: appId });
  if (error) throw error;
  return data || [];
}

export async function grantAppAccess(appId, profileId, note = null, expiresAt = null) {
  const { error } = await supabase.rpc('newpad_grant_app_access', {
    p_app_id: appId, p_profile_id: profileId, p_note: note, p_expires_at: expiresAt,
  });
  if (error) throw error;
}

export async function revokeAppAccess(appId, profileId) {
  const { error } = await supabase.rpc('newpad_revoke_app_access', {
    p_app_id: appId, p_profile_id: profileId,
  });
  if (error) throw error;
}

// Recherche de profil partagée. La fonction serveur est née pour NewFiles mais
// ne lui est pas propre : elle cherche un destinataire, et renvoie au plus dix
// résultats. En écrire une seconde, identique, pour l'administration serait la
// garantie que les deux divergent.
export async function searchProfiles(query) {
  const { data, error } = await supabase.rpc('newfiles_search_recipients', { p_query: query });
  if (error) throw error;
  return data || [];
}

// ----------------------------------------------------------------------------
// Icônes et logos (Supabase Storage, §9)
// ----------------------------------------------------------------------------

const BUCKET = 'newpad-app-icons';
const TYPES_ACCEPTES = ['image/png', 'image/webp', 'image/svg+xml', 'image/jpeg'];
const TAILLE_MAX = 2 * 1024 * 1024;

export async function uploadAppImage(file, slug, kind = 'icon') {
  if (!file) throw new Error('Aucun fichier sélectionné');
  if (!TYPES_ACCEPTES.includes(file.type)) {
    throw new Error('Format non accepté. Utilisez PNG, WebP, SVG ou JPEG.');
  }
  if (file.size > TAILLE_MAX) {
    throw new Error('Fichier trop lourd (2 Mo maximum).');
  }
  const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  // Le nom porte un horodatage : réutiliser le même chemin ferait servir
  // l'ancienne image tant que le cache du CDN n'a pas expiré, et l'admin
  // croirait que son remplacement n'a pas fonctionné.
  const chemin = `${kind}/${slug}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(BUCKET).upload(chemin, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(chemin);
  return data.publicUrl;
}

// ----------------------------------------------------------------------------
// Organisations (§12)
// ----------------------------------------------------------------------------

export async function listOrganizations() {
  const { data, error } = await supabase
    .from('organizations')
    .select('id, slug, name, kind, description, logo_url, owner_id, contact_email, contact_phone, location, status')
    .order('name');
  if (error) throw error;
  return data || [];
}

export async function listMyOrganizations() {
  const { data: session } = await supabase.auth.getSession();
  const uid = session?.session?.user?.id;
  if (!uid) return [];
  const { data, error } = await supabase
    .from('organization_members')
    .select('member_role, grade_label, organizations(id, slug, name, kind, logo_url, status)')
    .eq('profile_id', uid);
  if (error) throw error;
  return data || [];
}

export async function upsertOrganization(org) {
  const { data, error } = await supabase.rpc('newpad_upsert_organization', {
    p_id: org.id || null,
    p_name: org.name,
    p_slug: org.slug,
    p_kind: org.kind || 'company',
    p_description: org.description || null,
    p_logo_url: org.logo_url || null,
    p_owner_id: org.owner_id || null,
    p_contact_email: org.contact_email || null,
    p_contact_phone: org.contact_phone || null,
    p_location: org.location || null,
    p_status: org.status || 'active',
  });
  if (error) throw error;
  return data;
}

// ============================================================================
// Socle d'engagement — vues, réactions, commentaires (§14, §15)
// ============================================================================
// Partagé par News24, NewTube, NewLife, NewEvent et NewMarket, et lu tel quel
// par SACEM. Les applications ne comptent rien elles-mêmes : elles déclarent
// un couple (type d'entité, identifiant) et laissent le socle s'en charger.

import { supabase } from './supabaseClient.js';

// Une vue est déclarée une seule fois par entité et par session. Sans ce garde,
// revenir en arrière puis rouvrir un article le ferait grimper au classement
// sans qu'une personne de plus l'ait lu.
const vuesDeclarees = new Set();

export async function trackView(appSlug, entityType, entityId, metadata = {}) {
  const cle = entityType + ':' + entityId;
  if (vuesDeclarees.has(cle)) return;
  vuesDeclarees.add(cle);
  try {
    await supabase.rpc('track_event', {
      p_app_slug: appSlug, p_entity_type: entityType, p_entity_id: entityId,
      p_event_type: 'view', p_metadata: metadata,
    });
  } catch (_) {
    // Une audience non comptée n'est pas une raison de casser l'écran.
    vuesDeclarees.delete(cle);
  }
}

// Un événement passif quelconque (impression, clic) — l'équivalent de
// `trackView` sans la déduplication : un encart vu deux fois compte deux fois.
export async function trackEvent(appSlug, entityType, entityId, eventType, metadata = {}) {
  try {
    await supabase.rpc('track_event', {
      p_app_slug: appSlug, p_entity_type: entityType, p_entity_id: entityId,
      p_event_type: eventType, p_metadata: metadata,
    });
  } catch (_) { /* une mesure perdue ne casse pas un écran */ }
}

export async function react(entityType, entityId, reaction = 'like') {
  const { data, error } = await supabase.rpc('react', {
    p_entity_type: entityType, p_entity_id: entityId, p_reaction: reaction,
  });
  if (error) throw error;
  return data === true;
}

export async function postComment(entityType, entityId, body) {
  const { data, error } = await supabase.rpc('post_comment', {
    p_entity_type: entityType, p_entity_id: entityId, p_body: body,
  });
  if (error) throw error;
  return data;
}

export async function deleteComment(id) {
  const { error } = await supabase.rpc('delete_comment', { p_id: id });
  if (error) throw error;
}

export async function listComments(entityType, entityId) {
  const { data, error } = await supabase.rpc('list_comments', {
    p_entity_type: entityType, p_entity_id: entityId,
  });
  if (error) throw error;
  return data || [];
}

// Les chiffres de plusieurs entités en un seul appel : une liste de vingt
// articles ne doit pas déclencher vingt requêtes.
export async function contentStats(entityType, entityIds) {
  if (!entityIds || !entityIds.length) return {};
  const { data, error } = await supabase.rpc('content_stats', {
    p_entity_type: entityType, p_entity_ids: entityIds,
  });
  if (error) return {};
  const parId = {};
  (data || []).forEach((l) => { parId[l.entity_id] = l; });
  return parId;
}

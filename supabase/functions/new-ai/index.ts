// ============================================================================
// NEWPAD — Edge Function : NEW AI, l'assistant de la tablette
// ============================================================================
// Appelle l'API Claude avec la clé ANTHROPIC_API_KEY, posée dans les secrets
// des Edge Functions — jamais dans le navigateur.
//
// Ordre des contrôles :
//   1. le jeton de l'utilisateur (sans session, rien) ;
//   2. `ai_consume()` en base, AVEC ce jeton : droit d'ouvrir l'application
//      et quota du jour, décompté avant l'appel (0060) ;
//   3. l'appel à Claude.
//
// Aucune conversation n'est stockée : le navigateur renvoie l'historique à
// chaque message, borné ci-dessous.
//
// Secrets : ANTHROPIC_API_KEY (obligatoire), AI_MODEL (facultatif).
// ============================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
const MODEL = Deno.env.get('AI_MODEL') || 'claude-opus-5';

const MAX_MESSAGES = 20;
const MAX_CHARS = 4000;

const SYSTEM = `Tu es NEW AI, l'assistant intégré à Newpad, la tablette des habitants de Los Santos sur le serveur de jeu de rôle Hurricane FA.

Tu réponds en français, de façon brève et utile : quelques phrases, sauf si on te demande davantage. Texte simple, sans Markdown.

Tu restes dans l'univers du jeu : tu parles de Los Santos comme d'une vraie ville, et tu n'évoques pas le fait qu'il s'agit d'un jeu sauf si le joueur le fait lui-même.

Newpad regroupe notamment : Newman Bank (la banque), NewFiles (documents), NewMail, NewPage, NewPro, NewWork (emploi), News24, NewTube, NewLife, NewMarket, NewEvent, NewLeague (compétitions), NewGov, NewDoc, NewInsurance, les vitrines Dynasty, Concess Luxury et Vangelico, NewAds et SACEM. Tu peux expliquer à quoi elles servent et orienter le joueur.

Tu n'as accès à aucune donnée ni à aucun compte : tu ne peux ni consulter un solde, ni faire un virement, ni agir dans une application. Quand on te le demande, dis-le simplement et indique l'application à utiliser.`;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// L'historique vient du navigateur : on n'en garde que la forme attendue.
function validerMessages(brut: unknown): Anthropic.MessageParam[] | null {
  if (!Array.isArray(brut) || brut.length === 0) return null;
  const messages = brut.slice(-MAX_MESSAGES);
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
    if (typeof m.content !== 'string' || !m.content.trim() || m.content.length > MAX_CHARS) return null;
  }
  // Le découpage peut commencer sur une réponse : la conversation doit
  // toujours s'ouvrir sur le joueur, et se terminer sur lui.
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') return null;
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Non authentifié' }, 401);

  if (!ANTHROPIC_API_KEY) {
    return json({ error: 'NEW AI n’est pas encore activée.' }, 503);
  }

  let corps: { messages?: unknown };
  try { corps = await req.json(); } catch (_) { return json({ error: 'Requête invalide' }, 400); }
  const messages = validerMessages(corps.messages);
  if (!messages) return json({ error: 'Conversation invalide' }, 400);

  // Client Supabase AU NOM de l'utilisateur : auth.uid() vaut le joueur dans
  // ai_consume(), le quota ne peut donc être décompté que sur son propre compte.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: restant, error: quotaErr } = await supabase.rpc('ai_consume');
  if (quotaErr) return json({ error: quotaErr.message }, 403);

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 2048,
      // Discussion en jeu : la réactivité compte plus que la profondeur.
      output_config: { effort: 'low' },
      // Un refus des classifieurs de sécurité est rejoué côté serveur sur le
      // modèle de repli recommandé, au lieu de laisser le joueur sans réponse.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages,
    });

    if (response.stop_reason === 'refusal') {
      return json({ text: 'Je ne peux pas répondre à cette demande.', remaining: restant });
    }
    const texte = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return json({ text: texte || '…', remaining: restant });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return json({ error: 'NEW AI est très sollicitée, réessayez dans un instant.' }, 429);
    }
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('[new-ai] clé API refusée');
      return json({ error: 'NEW AI est momentanément indisponible.' }, 503);
    }
    if (err instanceof Anthropic.APIError) {
      console.error('[new-ai] erreur API', err.status, err.message);
      return json({ error: 'NEW AI est momentanément indisponible.' }, 502);
    }
    console.error('[new-ai] erreur', err);
    return json({ error: 'NEW AI est momentanément indisponible.' }, 500);
  }
});

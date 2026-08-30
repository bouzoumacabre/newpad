// ============================================================================
// NEWPAD — Edge Function : confirmation de réinitialisation de mot de passe
// ============================================================================
// Vérifie le code à 6 chiffres reçu par Discord (haché, comparé en base) puis
// met à jour le mot de passe via l'API Admin Supabase — seule façon d'écrire
// dans auth.users. Un code n'est utilisable qu'une fois, expire après 15
// minutes, et se verrouille après 5 tentatives erronées (protection contre
// le brute-force d'un code à 6 chiffres).
// ============================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

async function sha256Hex(text: string) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const INVALID_MSG = 'Code invalide ou expiré.';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Méthode non autorisée' }, 405);
  }

  try {
    const body = await req.json().catch(() => null);
    const username = body?.username ? String(body.username).trim().toLowerCase() : '';
    const code = body?.code ? String(body.code).trim() : '';
    const newPassword = body?.newPassword ? String(body.newPassword) : '';

    if (!username || !code || !newPassword) return json({ error: 'Champs manquants' }, 400);
    if (newPassword.length < 8) return json({ error: 'Le mot de passe doit contenir au moins 8 caractères' }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: profile } = await admin.from('profiles').select('id, role').eq('username', username).maybeSingle();
    if (!profile) return json({ error: INVALID_MSG }, 400);

    const { data: reset } = await admin
      .from('password_reset_codes')
      .select('*')
      .eq('profile_id', profile.id)
      .is('used_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!reset || new Date(reset.expires_at).getTime() < Date.now()) {
      return json({ error: INVALID_MSG }, 400);
    }
    if (reset.attempts >= 5) {
      return json({ error: 'Trop de tentatives — redemandez un nouveau code.' }, 400);
    }

    const codeHash = await sha256Hex(code);
    if (codeHash !== reset.code_hash) {
      await admin.from('password_reset_codes').update({ attempts: reset.attempts + 1 }).eq('id', reset.id);
      return json({ error: INVALID_MSG }, 400);
    }

    const { error: updateErr } = await admin.auth.admin.updateUserById(profile.id, { password: newPassword });
    if (updateErr) {
      return json({ error: updateErr.message || 'Échec de la mise à jour du mot de passe' }, 500);
    }

    await admin.from('password_reset_codes').update({ used_at: new Date().toISOString() }).eq('id', reset.id);

    // Déconnexion de toutes les sessions ouvertes sur ce compte.
    // Sans cela, changer son mot de passe ne chassait personne : les jetons de
    // rafraîchissement déjà émis restaient valides. Or le cas d'usage principal
    // d'une réinitialisation est le compte compromis — le propriétaire
    // reprenait la main pendant que l'intrus conservait son accès intact.
    // Échec non bloquant : le mot de passe est déjà changé, on ne va pas
    // annuler l'opération parce que le nettoyage des sessions a raté.
    try {
      await admin.rpc('revoke_user_sessions', { p_user_id: profile.id });
    } catch (_) { /* voir commentaire ci-dessus */ }

    await admin.from('audit_log').insert({
      actor_id: profile.id,
      actor_role: profile.role,
      action: 'password_reset_confirmed',
      target_type: 'profiles',
      target_id: profile.id,
      details: { via: 'discord' },
    });

    return json({ success: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Erreur interne' }, 500);
  }
});

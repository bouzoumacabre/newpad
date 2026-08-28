// ============================================================================
// NEWPAD — Edge Function : création de compte (guichet / employé / admin / IRS)
// ============================================================================
// Seule fonction de tout le backend qui utilise la clé service_role — jamais
// exposée côté client. Elle crée un utilisateur Supabase Auth (ce qui
// déclenche automatiquement handle_new_auth_user et crée la ligne `profiles`
// correspondante), ce qu'aucune fonction SECURITY DEFINER Postgres ne peut
// faire (auth.users n'est pas modifiable en SQL applicatif standard).
//
// Autorisations :
//   - Un compte "client" peut être créé par n'importe quel membre du
//     personnel (employé ou admin) — cas guichet.
//   - Un compte "employee" / "admin" / "irs" ne peut être créé que par un
//     admin.
// Toute création est journalisée dans audit_log.
//
// CORS : le site tourne sur GitHub Pages, donc tout appel navigateur vers
// cette fonction est une requête cross-origin — sans en-têtes CORS explicites
// (et sans gérer le préflight OPTIONS), le navigateur bloque la requête avant
// même qu'elle n'atteigne le serveur, ce qui remonte côté client comme
// "Failed to send a request to the Edge Function" (aucun détail exploitable).
// ============================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const ALLOWED_ROLES = ['client', 'employee', 'admin', 'irs'];
const USERNAME_RE = /^[a-z0-9_.]{3,32}$/;

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

Deno.serve(async (req: Request) => {
  // Préflight CORS — le navigateur l'envoie avant tout POST cross-origin.
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Méthode non autorisée' }, 405);
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return json({ error: 'Non authentifié' }, 401);
    const token = authHeader.replace(/^Bearer\s+/i, '');

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Identifie l'appelant à partir de son JWT.
    const { data: callerAuth, error: callerErr } = await admin.auth.getUser(token);
    if (callerErr || !callerAuth?.user) return json({ error: 'Session invalide' }, 401);
    const callerId = callerAuth.user.id;

    const { data: callerProfile, error: profErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', callerId)
      .single();
    if (profErr || !callerProfile) return json({ error: 'Profil introuvable' }, 403);
    if (!['employee', 'admin'].includes(callerProfile.role)) {
      return json({ error: 'Réservé au personnel' }, 403);
    }

    const body = await req.json().catch(() => null);
    if (!body) return json({ error: 'Corps de requête invalide' }, 400);

    const { username, password, displayName, role, employeeTitle, discordId, phoneNumber } = body;

    if (!username || !password || !displayName || !role) {
      return json({ error: 'Champs manquants (identifiant, mot de passe, nom affiché, rôle)' }, 400);
    }
    if (String(password).length < 8) {
      return json({ error: 'Le mot de passe doit contenir au moins 8 caractères' }, 400);
    }
    if (!ALLOWED_ROLES.includes(role)) {
      return json({ error: 'Rôle invalide' }, 400);
    }
    // Seul l'admin peut créer du personnel (employé/admin/IRS) ; l'employé
    // ne peut créer que des comptes client (cas guichet).
    if (role !== 'client' && callerProfile.role !== 'admin') {
      return json({ error: "Seul l'admin peut créer un compte employé, admin ou IRS" }, 403);
    }

    const cleanUsername = String(username).trim().toLowerCase();
    if (!USERNAME_RE.test(cleanUsername)) {
      return json({ error: 'Identifiant invalide (3-32 caractères : lettres minuscules, chiffres, "." ou "_")' }, 400);
    }

    const { data: existing } = await admin
      .from('profiles')
      .select('id')
      .eq('username', cleanUsername)
      .maybeSingle();
    if (existing) return json({ error: 'Cet identifiant est déjà utilisé' }, 409);

    const email = `${cleanUsername}@newpad.local`;

    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      // Le rôle passe par app_metadata, PAS par user_metadata.
      // Raison de sécurité (correctif 0019) : `user_metadata` est intégralement
      // contrôlé par l'appelant de /auth/v1/signup, qui est un endpoint PUBLIC.
      // Tant que le trigger handle_new_auth_user y lisait le rôle, n'importe
      // qui pouvait s'inscrire en demandant `role: "admin"` et obtenir les
      // pleins pouvoirs sur la banque. `app_metadata` n'est écrivable que par
      // l'API admin avec la clé service_role — c'est-à-dire uniquement ici.
      app_metadata: {
        role,
      },
      user_metadata: {
        username: cleanUsername,
        display_name: displayName,
        // Conservé pendant la transition pour que cette fonction reste
        // compatible avec l'ancien trigger tant que la migration 0019 n'est pas
        // appliquée. Ignoré par le nouveau trigger, qui ne lit plus que
        // app_metadata.
        role,
        discord_id: discordId ? String(discordId).trim() : null,
        phone_number: phoneNumber ? String(phoneNumber).trim() : null,
      },
    });
    if (createErr || !created?.user) {
      return json({ error: createErr?.message || 'Échec de la création du compte' }, 500);
    }

    const newId = created.user.id;

    if (role === 'employee' || role === 'admin') {
      await admin.from('profiles').update({ employee_title: employeeTitle || null }).eq('id', newId);
    }

    await admin.from('audit_log').insert({
      actor_id: callerId,
      actor_role: callerProfile.role,
      action: 'edge_create_account',
      target_type: 'profiles',
      target_id: newId,
      details: { role, username: cleanUsername },
    });

    return json({ id: newId, username: cleanUsername }, 201);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Erreur interne' }, 500);
  }
});

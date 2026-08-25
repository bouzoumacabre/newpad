import { createClient } from '@supabase/supabase-js';

// Renseignés au moment du déploiement (voir README — Supabase > Project Settings > API).
// En local, créer un fichier .env.local avec VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // eslint-disable-next-line no-console
  console.warn(
    '[Newpad] Variables VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY manquantes. ' +
    'Le site fonctionne en mode dégradé (aucune connexion à la base).'
  );
}

export const supabase = createClient(SUPABASE_URL || 'https://placeholder.supabase.co', SUPABASE_ANON_KEY || 'placeholder', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  realtime: {
    params: { eventsPerSecond: 5 },
  },
});

// L'identifiant saisi par l'utilisateur ne contient jamais "@" : on le
// transforme en e-mail synthétique interne à Supabase Auth. Voir README.
export function usernameToSyntheticEmail(username) {
  return `${username.trim().toLowerCase()}@newpad.local`;
}

export async function signInWithUsername(username, password) {
  const email = usernameToSyntheticEmail(username);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  // Journalise la tentative (succès/échec) pour la détection de fraude — best effort.
  try {
    await supabase.rpc('record_login_attempt', { p_username: username.trim().toLowerCase(), p_success: !error });
  } catch (_) { /* non bloquant */ }
  if (error) throw error;
  return data;
}

// `honeypot` : champ piège invisible côté formulaire (voir signup.js). Un
// humain ne le remplit jamais ; si non vide, le trigger `handle_new_auth_user`
// rejette la création du compte côté serveur (voir migration
// `honeypot_signup_guard`) — remplace le CAPTCHA Cloudflare Turnstile, devenu
// incompatible avec le navigateur intégré de FiveM (CEF).
export async function signUpProspect({ username, password, displayName, discordId, phoneNumber, honeypot }) {
  // L'ID Discord est obligatoire depuis 5sexies bis : c'est le seul moyen de
  // récupération de mot de passe (voir /forgot-password), donc un compte créé
  // sans lui serait irrécupérable en cas d'oubli. Vérifié ici en plus du
  // `required` côté formulaire, au cas où cette fonction serait appelée
  // autrement.
  if (!discordId || !discordId.trim()) {
    throw new Error("L'ID Discord est obligatoire à l'inscription (nécessaire pour la réinitialisation de mot de passe).");
  }
  // Numéro de téléphone obligatoire depuis le 3ème lot de correctifs : pour
  // que la banque puisse joindre directement ses clients.
  if (!phoneNumber || !phoneNumber.trim()) {
    throw new Error("Le numéro de téléphone est obligatoire à l'inscription (pour être joignable par la banque).");
  }
  const email = usernameToSyntheticEmail(username);
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        username: username.trim().toLowerCase(),
        display_name: displayName,
        role: 'prospect',
        discord_id: discordId ? discordId.trim() : null,
        phone_number: phoneNumber ? phoneNumber.trim() : null,
        honeypot: honeypot || '',
      },
    },
  });
  if (error) throw error;
  return data;
}

// ----------------------------------------------------------------------------
// MOT DE PASSE OUBLIÉ — via Discord (Edge Functions dédiées, aucune session
// requise : ces deux appels sont volontairement accessibles sans être connecté)
// ----------------------------------------------------------------------------

async function invokePublicFunction(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let message = error.message;
    try {
      const errBody = await error.context?.json?.();
      if (errBody?.error) message = errBody.error;
    } catch (_) { /* pas de corps JSON exploitable */ }
    throw new Error(message);
  }
  return data;
}

export async function requestPasswordReset(username) {
  return invokePublicFunction('request-password-reset', { username: username.trim().toLowerCase() });
}

export async function confirmPasswordReset({ username, code, newPassword }) {
  return invokePublicFunction('confirm-password-reset', {
    username: username.trim().toLowerCase(),
    code: code.trim(),
    newPassword,
  });
}

export async function getCurrentProfile() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase.from('profiles').select('*').eq('id', user.id).single();
  if (error) throw error;
  return data;
}

// ============================================================================
// NEWPAD — Edge Function : demande de réinitialisation de mot de passe (Discord)
// ============================================================================
// Flux : le visiteur envoie son identifiant → si un profil existe avec un ID
// Discord enregistré, un code à 6 chiffres est généré, haché (SHA-256) et
// stocké 15 minutes (table password_reset_codes), puis envoyé en message
// privé Discord via le bot (DISCORD_BOT_TOKEN, secret Supabase — jamais
// exposé côté client, configuré uniquement dans les secrets du projet).
//
// Réponse volontairement identique dans tous les cas (identifiant inconnu,
// pas d'ID Discord, ou envoi réussi) pour ne jamais confirmer l'existence
// d'un compte à un visiteur non authentifié (anti-énumération).
//
// Prérequis Discord : le bot doit partager un serveur avec le destinataire
// (Hurricane FA) pour pouvoir lui envoyer un message privé — c'est une
// restriction imposée par Discord lui-même, pas par ce code.
// ============================================================================

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const DISCORD_BOT_TOKEN = Deno.env.get('DISCORD_BOT_TOKEN');

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

const GENERIC_MESSAGE =
  "Si un compte existe avec cet identifiant et un ID Discord enregistré, un code de réinitialisation vient d'être envoyé par message privé Discord.";

async function sha256Hex(text: string) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Code à 6 chiffres tiré d'une source cryptographique.
//
// La version précédente utilisait Math.random(), qui n'est PAS cryptographique :
// le générateur de V8 (xorshift128+) a un état interne reconstituable à partir
// de quelques sorties consécutives. Un attaquant possédant son propre compte
// pouvait donc demander des codes pour lui-même, observer les valeurs reçues
// par Discord, retrouver l'état du générateur, et prédire le code émis juste
// après pour le compte d'une victime — court-circuitant entièrement la limite
// de 5 tentatives, qui ne protège que contre la force brute.
//
// Le rejet des valeurs au-delà du plus grand multiple de 900000 évite le biais
// de modulo : sans lui, les premiers codes de la plage sortiraient légèrement
// plus souvent que les autres.
function generateSecureCode(): string {
  const RANGE = 900_000; // 100000..999999
  const MAX = Math.floor(0xffffffff / RANGE) * RANGE;
  const buf = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= MAX);
  return String(100_000 + (value % RANGE));
}

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
    if (!username) return json({ error: 'Identifiant requis' }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: profile } = await admin
      .from('profiles')
      .select('id, discord_id')
      .eq('username', username)
      .maybeSingle();

    // Identifiant inconnu ou pas d'ID Discord enregistré : même réponse que le succès.
    if (!profile || !profile.discord_id) {
      return json({ message: GENERIC_MESSAGE });
    }

    // Anti-spam : pas plus d'une demande toutes les 60 secondes par profil.
    const { data: recent } = await admin
      .from('password_reset_codes')
      .select('created_at')
      .eq('profile_id', profile.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recent && Date.now() - new Date(recent.created_at).getTime() < 60_000) {
      return json({ message: GENERIC_MESSAGE });
    }

    const code = generateSecureCode();
    const codeHash = await sha256Hex(code);
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

    // Tout code précédent encore ouvert est invalidé : sans cela, plusieurs
    // codes valides coexistaient pour un même compte (jusqu'à une quinzaine sur
    // la fenêtre de 15 minutes), multipliant d'autant les chances d'un tirage
    // au hasard réussi. Un seul code vivant à la fois.
    await admin
      .from('password_reset_codes')
      .update({ used_at: new Date().toISOString() })
      .eq('profile_id', profile.id)
      .is('used_at', null);

    await admin.from('password_reset_codes').insert({
      profile_id: profile.id,
      code_hash: codeHash,
      expires_at: expiresAt,
    });

    if (DISCORD_BOT_TOKEN) {
      try {
        const dmChannel = await fetch('https://discord.com/api/v10/users/@me/channels', {
          method: 'POST',
          headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipient_id: profile.discord_id }),
        }).then((r) => r.json());

        if (dmChannel?.id) {
          await fetch(`https://discord.com/api/v10/channels/${dmChannel.id}/messages`, {
            method: 'POST',
            headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              content:
                `🏦 **Newman Bank** — Code de réinitialisation de mot de passe : **${code}**\n` +
                `Valable 15 minutes. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.`,
            }),
          });
        }
      } catch (_) {
        // On ne remonte jamais un échec d'envoi Discord au client (anti-énumération) —
        // le code reste en base et le visiteur peut retenter une demande.
      }
    }

    return json({ message: GENERIC_MESSAGE });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'Erreur interne' }, 500);
  }
});

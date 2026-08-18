-- ============================================================================
-- NEWPAD — Migration 0009 : réinitialisation de mot de passe via Discord
-- ============================================================================
-- Table de support pour le flux "mot de passe oublié" : un code à 6 chiffres
-- est généré, haché (SHA-256, calculé côté Edge Function) et stocké ici avec
-- une expiration de 15 minutes, puis envoyé en message privé Discord au
-- titulaire du compte (profiles.discord_id, ajouté en 0008). Aucune policy
-- RLS n'est définie : la table n'est accessible que via les deux Edge
-- Functions dédiées (request-password-reset / confirm-password-reset), qui
-- utilisent la clé service_role et contournent RLS par nature — c'est le
-- comportement "deny by default" voulu pour anon/authenticated.
-- ============================================================================

create table if not exists password_reset_codes (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table password_reset_codes is 'Codes de réinitialisation de mot de passe envoyés par DM Discord — accès exclusivement via les Edge Functions dédiées (service_role), jamais directement par un client.';

alter table password_reset_codes enable row level security;

create index if not exists password_reset_codes_profile_id_idx on password_reset_codes (profile_id, created_at desc);

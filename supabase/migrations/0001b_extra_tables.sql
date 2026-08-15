-- ============================================================================
-- NEWPAD — Migration 0001b : tables complémentaires
-- ============================================================================

create table documents (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references profiles(id) on delete cascade,
  doc_type text not null check (doc_type in ('releve','rib','contrat','attestation','autre')),
  title text not null,
  period_label text,
  storage_path text, -- chemin dans le bucket Supabase Storage "documents"
  generated_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

create index idx_documents_client on documents(client_id, created_at desc);

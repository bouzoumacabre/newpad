-- ============================================================================
-- NEWPAD — Migration 0007 : fonctions d'appui pour l'interface Client
-- ============================================================================
-- Un client ne peut lire, via RLS, que ses propres comptes (accounts_select).
-- Pour émettre un virement vers un tiers, il doit pouvoir résoudre un IBAN
-- fourni par un bénéficiaire vers un identifiant de compte, sans que RLS ne
-- l'y autorise directement (et sans exposer le solde ni d'autres données du
-- compte destinataire) — d'où cette fonction dédiée, à la manière des
-- fonctions irs_* : SECURITY DEFINER, lecture minimale, aucune capacité
-- d'écriture.
-- ============================================================================

create or replace function resolve_account_by_iban(p_iban text)
returns table(account_id uuid, owner_display_name text, account_type text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'Non authentifié'; end if;
  return query
  select a.id, p.display_name, a.account_type
  from accounts a
  join profiles p on p.id = a.client_id
  where a.iban = p_iban and a.status = 'active' and a.is_bank_treasury = false;
end;
$$;

revoke execute on function resolve_account_by_iban(text) from public, anon;
grant execute on function resolve_account_by_iban(text) to authenticated;

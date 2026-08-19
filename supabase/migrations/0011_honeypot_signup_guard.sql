-- ============================================================================
-- NEWPAD — Remplacement du CAPTCHA Cloudflare Turnstile par un honeypot
-- ============================================================================
-- Turnstile s'est révélé structurellement incompatible avec le navigateur
-- intégré de FiveM (CEF) : Cloudflare détecte le moteur CEF lui-même comme
-- suspect (erreur générique 600xxx, "bot behavior detected"), ce qui bloquait
-- tous les joueurs se connectant depuis le jeu. Remplacé par un champ piège
-- invisible ("honeypot") : les bots qui remplissent aveuglément tous les
-- champs d'un formulaire le renseignent, les humains ne le voient jamais.
-- Vérifié ici, côté serveur, dans le trigger qui s'exécute à la création de
-- tout nouveau compte — un bot ne peut pas le contourner en appelant l'API
-- Supabase directement sans passer par le frontend.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if coalesce(new.raw_user_meta_data->>'honeypot', '') != '' then
    raise exception 'Inscription refusée';
  end if;

  insert into profiles (id, username, role, display_name, discord_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    coalesce((new.raw_user_meta_data->>'role')::user_role, 'prospect'),
    coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)),
    nullif(new.raw_user_meta_data->>'discord_id', '')
  );
  return new;
end;
$function$;

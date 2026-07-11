-- Phase 2 items 12-13: finish legacy cleanup and expose only sanitized player data.

-- Legacy columns players.league_id and news_posts.league_id still carry FKs to
-- the dead leagues table (live-DB check 2026-07-11). Drop the constraints; the
-- columns stay (unused by code) so no data is touched.
ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_league_id_fkey;
ALTER TABLE public.news_posts DROP CONSTRAINT IF EXISTS news_posts_league_id_fkey;

DO $$
DECLARE
  fk RECORD;
BEGIN
  FOR fk IN
    SELECT conrelid::regclass AS source_table, conname
    FROM pg_constraint
    WHERE contype = 'f' AND confrelid = 'public.leagues'::regclass
  LOOP
    RAISE EXCEPTION 'Cannot drop public.leagues: FK % on % still targets it', fk.conname, fk.source_table;
  END LOOP;
END $$;

DROP TABLE public.leagues;
DROP TABLE public.admins;
DROP TABLE public.skins;

DO $$
DECLARE
  default_location UUID;
BEGIN
  SELECT id INTO default_location FROM public.locations WHERE slug = 'gbig';
  IF default_location IS NULL AND EXISTS (SELECT 1 FROM public.push_subscriptions WHERE location_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill push_subscriptions.location_id: location slug gbig is missing';
  END IF;
  UPDATE public.push_subscriptions SET location_id = default_location WHERE location_id IS NULL;
END $$;

ALTER TABLE public.push_subscriptions ALTER COLUMN location_id SET NOT NULL;

-- follows and messages remain ecosystem-wide by design. Their existing RLS policies
-- authorize by the authenticated user's linked player identity, not location.

DROP VIEW IF EXISTS public.player_public;
CREATE VIEW public.player_public
WITH (security_invoker = false, security_barrier = true)
AS
SELECT
  p.id,
  p.name,
  p.first_name,
  p.last_name,
  p.avatar_url,
  p.location_id,
  l.name AS location_name
FROM public.players p
JOIN public.locations l ON l.id = p.location_id;

REVOKE ALL ON public.player_public FROM PUBLIC, anon;
GRANT SELECT ON public.player_public TO authenticated;

COMMENT ON VIEW public.player_public IS
  'Sanitized ecosystem-wide player directory. Intentionally excludes contact, handicap, auth, and league_password fields.';

COMMENT ON COLUMN public.players.league_password IS
  'Phase-2 audited legacy login credential. Retained because login/account flows depend on it; readable only through same-location player RLS and writable only through guarded admin RPCs.';

CREATE OR REPLACE FUNCTION public.guard_player_profile_updates()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.player_write', true) = 'on'
     OR current_setting('app.roster_write', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.team_id IS DISTINCT FROM OLD.team_id
     OR NEW.handicap IS DISTINCT FROM OLD.handicap
     OR NEW.handicap_locked IS DISTINCT FROM OLD.handicap_locked
     OR NEW.in_skins IS DISTINCT FROM OLD.in_skins
     OR NEW.is_sub IS DISTINCT FROM OLD.is_sub
     -- league_password: a player may change their OWN password (PlayerProfile
     -- password form updates it directly); anyone else goes through admin RPCs.
     OR (NEW.league_password IS DISTINCT FROM OLD.league_password
         AND (OLD.user_id IS NULL OR OLD.user_id IS DISTINCT FROM auth.uid())) THEN
    RAISE EXCEPTION 'Protected player fields must be changed by an admin RPC';
  END IF;
  RETURN NEW;
END;
$$;

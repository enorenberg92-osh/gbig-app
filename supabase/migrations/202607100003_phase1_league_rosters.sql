-- Phase 1 / apply third: canonical league foreign keys and dated team rosters.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE public.events ADD COLUMN IF NOT EXISTS league_id UUID;
ALTER TABLE public.teams  ADD COLUMN IF NOT EXISTS league_id UUID;

-- SUPABASE_SCHEMA.md is stale and some installations may still point these
-- columns at legacy public.leagues. Remove only those legacy FK constraints.
DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  IF to_regclass('public.leagues') IS NOT NULL THEN
    FOR constraint_row IN
      SELECT conrelid::regclass AS table_name, conname
        FROM pg_constraint
       WHERE contype = 'f'
         AND conrelid IN ('public.events'::regclass, 'public.teams'::regclass)
         AND confrelid = 'public.leagues'::regclass
    LOOP
      EXECUTE format(
        'ALTER TABLE %s DROP CONSTRAINT %I',
        constraint_row.table_name,
        constraint_row.conname
      );
    END LOOP;
  END IF;
END $$;

-- Preserve IDs already pointing at canonical league_config. Otherwise choose
-- the location's working league, then an active league, then its newest config.
UPDATE public.events e
   SET league_id = (
    SELECT lc.id
      FROM public.league_config lc
     WHERE lc.location_id = e.location_id
     ORDER BY
       (lc.id = e.league_id) DESC,
       COALESCE(lc.is_working, false) DESC,
       COALESCE(lc.is_active, false) DESC,
       lc.start_date DESC NULLS LAST,
       lc.id
     LIMIT 1
  )
 WHERE e.league_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.league_config lc WHERE lc.id = e.league_id);

UPDATE public.teams t
   SET league_id = (
    SELECT lc.id
      FROM public.league_config lc
     WHERE lc.location_id = t.location_id
     ORDER BY
       (lc.id = t.league_id) DESC,
       COALESCE(lc.is_working, false) DESC,
       COALESCE(lc.is_active, false) DESC,
       lc.start_date DESC NULLS LAST,
       lc.id
     LIMIT 1
  )
 WHERE t.league_id IS NULL
    OR NOT EXISTS (SELECT 1 FROM public.league_config lc WHERE lc.id = t.league_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.events WHERE league_id IS NULL) THEN
    RAISE EXCEPTION 'Every event location needs a league_config row before Phase 1 can continue';
  END IF;
  IF EXISTS (SELECT 1 FROM public.teams WHERE league_id IS NULL) THEN
    RAISE EXCEPTION 'Every team location needs a league_config row before Phase 1 can continue';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.events
     WHERE week_number IS NOT NULL
     GROUP BY location_id, league_id, week_number
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate event week_number values exist within a league; reconcile them before Phase 1';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.events
     WHERE status = 'open'
     GROUP BY location_id, league_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'More than one open event exists in a league; reconcile before Phase 1';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.league_config
     WHERE is_working
     GROUP BY location_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'More than one working league exists at a location; reconcile before Phase 1';
  END IF;
END $$;

ALTER TABLE public.events ALTER COLUMN league_id SET NOT NULL;
ALTER TABLE public.teams  ALTER COLUMN league_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.events'::regclass
       AND conname = 'events_league_config_fk'
  ) THEN
    ALTER TABLE public.events
      ADD CONSTRAINT events_league_config_fk
      FOREIGN KEY (league_id) REFERENCES public.league_config(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.teams'::regclass
       AND conname = 'teams_league_config_fk'
  ) THEN
    ALTER TABLE public.teams
      ADD CONSTRAINT teams_league_config_fk
      FOREIGN KEY (league_id) REFERENCES public.league_config(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.events'::regclass
       AND conname = 'events_location_league_week_key'
  ) THEN
    ALTER TABLE public.events
      ADD CONSTRAINT events_location_league_week_key
      UNIQUE (location_id, league_id, week_number);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS events_one_open_per_league
  ON public.events(location_id, league_id)
  WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS league_config_one_working_per_location
  ON public.league_config(location_id)
  WHERE is_working;
CREATE INDEX IF NOT EXISTS idx_events_league_week
  ON public.events(league_id, week_number, start_date);
CREATE INDEX IF NOT EXISTS idx_teams_league
  ON public.teams(league_id, created_at);

CREATE TABLE IF NOT EXISTS public.team_memberships (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id    UUID NOT NULL REFERENCES public.locations(id),
  league_id      UUID NOT NULL REFERENCES public.league_config(id),
  player_id      UUID NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  team_id        UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  effective_from DATE NOT NULL,
  effective_to   DATE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE IF NOT EXISTS public.team_membership_conflicts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   UUID NOT NULL REFERENCES public.locations(id),
  league_id     UUID NOT NULL REFERENCES public.league_config(id),
  player_id     UUID NOT NULL REFERENCES public.players(id),
  candidate_ids JSONB NOT NULL,
  kept_team_id  UUID NOT NULL REFERENCES public.teams(id),
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (league_id, player_id)
);

-- Reconcile both legacy sources. Team slot columns win only when the sources
-- disagree; every disagreement is retained for admin review.
WITH candidates AS (
  SELECT t.location_id, t.league_id, t.player1_id AS player_id, t.id AS team_id, 1 AS priority
    FROM public.teams t WHERE t.player1_id IS NOT NULL
  UNION ALL
  SELECT t.location_id, t.league_id, t.player2_id, t.id, 1
    FROM public.teams t WHERE t.player2_id IS NOT NULL
  UNION ALL
  SELECT p.location_id, t.league_id, p.id, t.id, 2
    FROM public.players p
    JOIN public.teams t ON t.id = p.team_id AND t.location_id = p.location_id
), ranked AS (
  SELECT *, row_number() OVER (
    PARTITION BY league_id, player_id ORDER BY priority, team_id
  ) AS choice
  FROM candidates
), conflicts AS (
  SELECT
    location_id, league_id, player_id,
    jsonb_agg(DISTINCT team_id ORDER BY team_id) AS candidate_ids,
    (array_agg(team_id ORDER BY choice))[1] AS kept_team_id
  FROM ranked
  GROUP BY location_id, league_id, player_id
  HAVING count(DISTINCT team_id) > 1
)
INSERT INTO public.team_membership_conflicts (
  location_id, league_id, player_id, candidate_ids, kept_team_id
)
SELECT location_id, league_id, player_id, candidate_ids, kept_team_id
  FROM conflicts
ON CONFLICT (league_id, player_id) DO UPDATE
  SET candidate_ids = EXCLUDED.candidate_ids,
      kept_team_id = EXCLUDED.kept_team_id,
      detected_at = now();

WITH candidates AS (
  SELECT t.location_id, t.league_id, t.player1_id AS player_id, t.id AS team_id, 1 AS priority
    FROM public.teams t WHERE t.player1_id IS NOT NULL
  UNION ALL
  SELECT t.location_id, t.league_id, t.player2_id, t.id, 1
    FROM public.teams t WHERE t.player2_id IS NOT NULL
  UNION ALL
  SELECT p.location_id, t.league_id, p.id, t.id, 2
    FROM public.players p
    JOIN public.teams t ON t.id = p.team_id AND t.location_id = p.location_id
), chosen AS (
  SELECT DISTINCT ON (league_id, player_id)
    location_id, league_id, player_id, team_id
  FROM candidates
  ORDER BY league_id, player_id, priority, team_id
)
INSERT INTO public.team_memberships (
  location_id, league_id, player_id, team_id, effective_from
)
SELECT
  c.location_id,
  c.league_id,
  c.player_id,
  c.team_id,
  COALESCE(lc.start_date, DATE '1900-01-01')
FROM chosen c
JOIN public.league_config lc ON lc.id = c.league_id
WHERE NOT EXISTS (
  SELECT 1 FROM public.team_memberships tm
   WHERE tm.player_id = c.player_id
     AND tm.league_id = c.league_id
     AND tm.effective_to IS NULL
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.teams t
      LEFT JOIN public.team_memberships tm
        ON tm.team_id = t.id AND tm.effective_to IS NULL
     GROUP BY t.id
    HAVING count(tm.id) <> 2
  ) THEN
    RAISE EXCEPTION 'Each team must resolve to exactly two active memberships before Phase 1 can continue';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS team_memberships_one_active_player_league
  ON public.team_memberships(player_id, league_id)
  WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_team_memberships_team_dates
  ON public.team_memberships(team_id, effective_from, effective_to);
CREATE INDEX IF NOT EXISTS idx_team_memberships_player_dates
  ON public.team_memberships(player_id, league_id, effective_from, effective_to);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.team_memberships'::regclass
       AND conname = 'team_memberships_no_overlap'
  ) THEN
    ALTER TABLE public.team_memberships
      ADD CONSTRAINT team_memberships_no_overlap
      EXCLUDE USING gist (
        player_id WITH =,
        league_id WITH =,
        daterange(
          effective_from,
          COALESCE(effective_to + 1, 'infinity'::date),
          '[)'
        ) WITH &&
      )
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.enforce_team_size_two()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  affected_team UUID;
  active_count INTEGER;
BEGIN
  affected_team := COALESCE(NEW.team_id, OLD.team_id);
  IF EXISTS (SELECT 1 FROM public.teams WHERE id = affected_team) THEN
    SELECT count(*) INTO active_count
      FROM public.team_memberships
     WHERE team_id = affected_team AND effective_to IS NULL;
    IF active_count <> 2 THEN
      RAISE EXCEPTION 'Team % must have exactly two active members (found %)', affected_team, active_count;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS team_memberships_size_two ON public.team_memberships;
CREATE CONSTRAINT TRIGGER team_memberships_size_two
  AFTER INSERT OR UPDATE OR DELETE ON public.team_memberships
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_team_size_two();

CREATE OR REPLACE VIEW public.roster_at
WITH (security_invoker = true)
AS
SELECT
  e.id AS event_id,
  e.location_id,
  e.league_id,
  e.week_number,
  COALESCE(e.start_date, e.event_date, current_date) AS event_date,
  tm.team_id,
  t.name AS team_name,
  tm.player_id,
  p.name AS player_name,
  p.handicap
FROM public.events e
JOIN public.team_memberships tm
  ON tm.location_id = e.location_id
 AND tm.league_id = e.league_id
 AND COALESCE(e.start_date, e.event_date, current_date) >= tm.effective_from
 AND (tm.effective_to IS NULL OR COALESCE(e.start_date, e.event_date, current_date) <= tm.effective_to)
JOIN public.teams t ON t.id = tm.team_id
JOIN public.players p ON p.id = tm.player_id;

-- Populate score.team_id from the historical roster when a unique match exists.
UPDATE public.scores s
   SET team_id = r.team_id
  FROM public.roster_at r
 WHERE r.event_id = s.event_id
   AND r.player_id = s.player_id
   AND s.team_id IS NULL;

CREATE OR REPLACE FUNCTION public.guard_legacy_roster_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.roster_write', true) IS DISTINCT FROM 'on' THEN
    IF TG_TABLE_NAME = 'teams' THEN
      IF TG_OP = 'INSERT' AND (NEW.player1_id IS NOT NULL OR NEW.player2_id IS NOT NULL) THEN
        RAISE EXCEPTION 'Roster slots are read-only; use the roster RPC';
      END IF;
      IF TG_OP = 'UPDATE' AND (
        NEW.player1_id IS DISTINCT FROM OLD.player1_id OR
        NEW.player2_id IS DISTINCT FROM OLD.player2_id OR
        NEW.league_id IS DISTINCT FROM OLD.league_id
      ) THEN
        RAISE EXCEPTION 'Roster slots are read-only; use the roster RPC';
      END IF;
    ELSIF TG_TABLE_NAME = 'players' AND NEW.team_id IS DISTINCT FROM OLD.team_id THEN
      RAISE EXCEPTION 'players.team_id is retired; use team_memberships via the roster RPC';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS teams_guard_legacy_roster ON public.teams;
CREATE TRIGGER teams_guard_legacy_roster
  BEFORE INSERT OR UPDATE ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.guard_legacy_roster_columns();
DROP TRIGGER IF EXISTS players_guard_legacy_team_id ON public.players;
CREATE TRIGGER players_guard_legacy_team_id
  BEFORE UPDATE OF team_id ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.guard_legacy_roster_columns();

ALTER TABLE public.team_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_membership_conflicts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "team_memberships: location members read" ON public.team_memberships;
CREATE POLICY "team_memberships: location members read" ON public.team_memberships
  FOR SELECT TO authenticated USING (public.is_in_location(location_id));
DROP POLICY IF EXISTS "team membership conflicts: admins read" ON public.team_membership_conflicts;
CREATE POLICY "team membership conflicts: admins read" ON public.team_membership_conflicts
  FOR SELECT TO authenticated USING (public.is_admin_of_location(location_id));

GRANT SELECT ON public.team_memberships, public.roster_at TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.team_memberships FROM authenticated;
REVOKE ALL ON public.team_membership_conflicts FROM anon, authenticated;
GRANT SELECT ON public.team_membership_conflicts TO authenticated;

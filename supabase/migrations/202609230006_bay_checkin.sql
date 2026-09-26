-- ============================================================================
-- Bay check-in (2026-09-23)
-- ----------------------------------------------------------------------------
-- League nights run in waves (4, 6, 8 PM) with ~90 seconds to turn a bay
-- over. One player checks the whole team into a bay from their phone (QR at
-- the bay or the in-app button); staff "clear all" between waves; the
-- simulator reads its bay's occupants to label players and post holes by
-- player_id (docs/SIM_INTEGRATION.md, "Bay check-in").
--
-- Nothing is pre-assigned: placement is whatever teams check in to.
--
--   location_bays                   the location's bays (label '1'..'N')
--   bay_checkins                    one row per team per stint on a bay;
--                                   active = cleared_at IS NULL
--   checkin_team / checkout_my_team / my_checkin_status      players
--   bay_board                       live board (players' picker + admin)
--   admin_checkin_team / admin_clear_checkin / admin_clear_bay /
--   admin_clear_all_bays / admin_set_bays / admin_rename_bay  admins
--   sim_bay(key_hash, payload)      service role only; sim-ingest routes
--                                   {action:'bay'|'clear_bay'} here
--
-- A check-in is "live" while its week is open and it is under 12 hours old,
-- so a bay nobody cleared last night doesn't show old teams today (stale rows
-- are closed as 'expired' the next time anyone checks in at the location).
-- The sim finalizing a team's round does NOT clear it (extra holes are common).
--
-- Idempotent: safe to run more than once. One transaction.
-- ============================================================================

BEGIN;

-- ── 1. location_bays ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.location_bays (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  label       TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 20),
  sort        INTEGER NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS location_bays_location_label_key
  ON public.location_bays (location_id, lower(label));

-- Read-only to clients (the check-in page resolves ?bay=<label> with it);
-- every write goes through the admin RPCs below.
ALTER TABLE public.location_bays ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "location_bays: location members read" ON public.location_bays;
CREATE POLICY "location_bays: location members read" ON public.location_bays
  FOR SELECT TO authenticated
  USING (public.is_in_location(location_id));
REVOKE ALL ON public.location_bays FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.location_bays TO authenticated;


-- ── 2. bay_checkins ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bay_checkins (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  event_id      UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  team_id       UUID NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
  bay_id        UUID NOT NULL REFERENCES public.location_bays(id) ON DELETE CASCADE,
  checked_in_by UUID,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cleared_at    TIMESTAMPTZ,
  cleared_by    UUID,
  clear_reason  TEXT CHECK (clear_reason IN
                  ('manual', 'clear_all', 'moved', 'finished', 'checkout', 'sim', 'expired')),
  CONSTRAINT bay_checkins_cleared_reason CHECK ((cleared_at IS NULL) = (clear_reason IS NULL))
);
-- A team is on at most one bay at a time for a week.
CREATE UNIQUE INDEX IF NOT EXISTS bay_checkins_one_active_per_team
  ON public.bay_checkins (event_id, team_id) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bay_checkins_bay_active
  ON public.bay_checkins (bay_id) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bay_checkins_location_active
  ON public.bay_checkins (location_id) WHERE cleared_at IS NULL;
-- Frequent-partner suggestions look back 90 days by team.
CREATE INDEX IF NOT EXISTS idx_bay_checkins_team_time
  ON public.bay_checkins (team_id, checked_in_at DESC);

ALTER TABLE public.bay_checkins ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "bay_checkins: location members read" ON public.bay_checkins;
CREATE POLICY "bay_checkins: location members read" ON public.bay_checkins
  FOR SELECT TO authenticated
  USING (public.is_in_location(location_id));
REVOKE ALL ON public.bay_checkins FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bay_checkins TO authenticated;

-- Realtime for the admin board. Guarded so plain Postgres (CI) migrates.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'bay_checkins'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.bay_checkins;
  END IF;
END $$;


-- ── 3. Shared internals (never granted to clients) ──────────────────────────

-- Live = still tonight's: the week is open and it's under 12 hours old.
CREATE OR REPLACE FUNCTION public.bay_checkin_is_live(p_checked_in_at TIMESTAMPTZ, p_event_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_checked_in_at > now() - INTERVAL '12 hours'
     AND EXISTS (SELECT 1 FROM public.events e WHERE e.id = p_event_id AND e.status = 'open');
$$;

-- Finished = every rostered teammate's round is in (a non-rejected played
-- score, or a live card flagged submitted). Teams still playing are never
-- finished, and a team with no roster isn't either.
CREATE OR REPLACE FUNCTION public.bay_team_finished(p_event_id UUID, p_team_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.roster_at r WHERE r.event_id = p_event_id AND r.team_id = p_team_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.roster_at r
        WHERE r.event_id = p_event_id AND r.team_id = p_team_id
          AND NOT EXISTS (
            SELECT 1 FROM public.scores s
             WHERE s.event_id = p_event_id AND s.player_id = r.player_id
               AND s.entry_type = 'played' AND s.status <> 'rejected')
          AND NOT EXISTS (
            SELECT 1 FROM public.live_rounds lr
             WHERE lr.event_id = p_event_id AND lr.player_id = r.player_id AND lr.submitted)
     );
$$;

-- A team's rostered players for the week, with tonight's progress. An
-- approved sub keeps the rostered player's slot (holes post to player_id) and
-- is named in sub_name so the board / sim can show who is actually swinging.
CREATE OR REPLACE FUNCTION public.bay_team_players_json(p_event_id UUID, p_team_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'player_id', r.player_id,
           'name', r.player_name,
           'handicap', h.handicap_used,
           'sub_name', sub.name,
           'holes_played', COALESCE(lr.holes_played, 0),
           'submitted', COALESCE(lr.submitted, false) OR EXISTS (
              SELECT 1 FROM public.scores s
               WHERE s.event_id = p_event_id AND s.player_id = r.player_id
                 AND s.entry_type = 'played' AND s.status <> 'rejected'))
         ORDER BY r.player_name), '[]'::jsonb)
    FROM public.roster_at r
    CROSS JOIN LATERAL public.live_slot_handicap(p_event_id, r.player_id) h
    LEFT JOIN public.live_rounds lr ON lr.event_id = p_event_id AND lr.player_id = r.player_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(sp.name, NULLIF(btrim(concat_ws(' ', su.sub_first_name, su.sub_last_name)), '')) AS name
        FROM public.subs su
        LEFT JOIN public.players sp ON sp.id = su.sub_player_id
       WHERE su.event_id = p_event_id AND su.player_id = r.player_id AND su.status = 'approved'
       ORDER BY su.created_at DESC NULLS LAST
       LIMIT 1
    ) sub ON true
   WHERE r.event_id = p_event_id AND r.team_id = p_team_id;
$$;

-- Everyone live on a bay, earliest first.
CREATE OR REPLACE FUNCTION public.bay_occupants_json(p_bay_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'checkin_id', c.id,
           'team_id', c.team_id,
           'team_name', t.name,
           'event_id', c.event_id,
           'checked_in_at', c.checked_in_at,
           'finished', public.bay_team_finished(c.event_id, c.team_id),
           'players', public.bay_team_players_json(c.event_id, c.team_id))
         ORDER BY c.checked_in_at, t.name), '[]'::jsonb)
    FROM public.bay_checkins c
    JOIN public.teams t ON t.id = c.team_id
   WHERE c.bay_id = p_bay_id AND c.cleared_at IS NULL
     AND public.bay_checkin_is_live(c.checked_in_at, c.event_id);
$$;

-- Teams that shared a bay with p_team_id (overlapping check-ins on the same
-- bay) on at least 2 distinct earlier weeks in the last 90 days, that are
-- rostered this week and not checked in anywhere yet. Most frequent first.
CREATE OR REPLACE FUNCTION public.bay_checkin_suggestions(p_event_id UUID, p_team_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH shared AS (
    SELECT o.team_id, count(DISTINCT m.event_id) AS nights, max(o.checked_in_at) AS last_seen
      FROM public.bay_checkins m
      JOIN public.bay_checkins o
        ON o.bay_id = m.bay_id AND o.event_id = m.event_id AND o.team_id <> m.team_id
       AND o.checked_in_at < COALESCE(m.cleared_at, now())
       AND m.checked_in_at < COALESCE(o.cleared_at, now())
     WHERE m.team_id = p_team_id
       AND m.event_id <> p_event_id
       AND m.checked_in_at > now() - INTERVAL '90 days'
     GROUP BY o.team_id
    HAVING count(DISTINCT m.event_id) >= 2
  ), picked AS (
    SELECT s.team_id, s.nights, s.last_seen, t.name AS team_name
      FROM shared s
      JOIN public.teams t ON t.id = s.team_id
     WHERE EXISTS (SELECT 1 FROM public.roster_at r WHERE r.event_id = p_event_id AND r.team_id = s.team_id)
       AND NOT EXISTS (
         SELECT 1 FROM public.bay_checkins c
          WHERE c.event_id = p_event_id AND c.team_id = s.team_id AND c.cleared_at IS NULL
            AND public.bay_checkin_is_live(c.checked_in_at, c.event_id))
     ORDER BY s.nights DESC, s.last_seen DESC, t.name
     LIMIT 3
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'team_id', p.team_id,
           'team_name', p.team_name,
           'nights', p.nights,
           'players', (SELECT COALESCE(jsonb_agg(r.player_name ORDER BY r.player_name), '[]'::jsonb)
                         FROM public.roster_at r
                        WHERE r.event_id = p_event_id AND r.team_id = p.team_id))
         ORDER BY p.nights DESC, p.last_seen DESC, p.team_name), '[]'::jsonb)
    FROM picked p;
$$;

-- The caller's (event, team) at a location this week. status:
--   'ok' | 'no_open_week' | 'not_rostered' | 'ambiguous'
-- Several open weeks (more than one league running) resolve to the working
-- league's week when that is unambiguous.
CREATE OR REPLACE FUNCTION public.bay_caller_team(p_location_id UUID)
RETURNS TABLE (event_id UUID, team_id UUID, status TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  total INTEGER;
  working_total INTEGER;
  any_event UUID;
  any_team UUID;
  working_event UUID;
  working_team UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.events e WHERE e.location_id = p_location_id AND e.status = 'open') THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'no_open_week'::text;
    RETURN;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE x.working),
         (array_agg(x.event_id))[1], (array_agg(x.team_id))[1],
         (array_agg(x.event_id) FILTER (WHERE x.working))[1],
         (array_agg(x.team_id) FILTER (WHERE x.working))[1]
    INTO total, working_total, any_event, any_team, working_event, working_team
    FROM (
      SELECT DISTINCT r.event_id, r.team_id, COALESCE(lc.is_working, false) AS working
        FROM public.roster_at r
        JOIN public.players p ON p.id = r.player_id
        JOIN public.events e ON e.id = r.event_id
        LEFT JOIN public.league_config lc ON lc.id = e.league_id
       WHERE p.user_id = auth.uid() AND p.location_id = p_location_id
         AND e.location_id = p_location_id AND e.status = 'open'
    ) x;

  IF total = 0 THEN
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'not_rostered'::text;
  ELSIF total = 1 THEN
    RETURN QUERY SELECT any_event, any_team, 'ok'::text;
  ELSIF working_total = 1 THEN
    RETURN QUERY SELECT working_event, working_team, 'ok'::text;
  ELSE
    RETURN QUERY SELECT NULL::uuid, NULL::uuid, 'ambiguous'::text;
  END IF;
END;
$$;

-- Put teams on a bay. Callers have authorized and validated the teams are
-- rostered for p_event_id. Per bay (row lock), first:
--   * stale check-ins anywhere at the location close as 'expired'
--   * teams on THIS bay whose rounds are all in close as 'finished' (safety
--     net for a missed "clear all"; teams still playing are never touched)
-- then each team is moved here ('moved') unless it is already here.
CREATE OR REPLACE FUNCTION public.bay_checkin_internal(p_bay_id UUID, p_event_id UUID, p_team_ids UUID[])
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bay_row public.location_bays%ROWTYPE;
  tid UUID;
  cur public.bay_checkins%ROWTYPE;
  expired_count INTEGER;
  finished_count INTEGER;
  moved_count INTEGER := 0;
  added_count INTEGER := 0;
BEGIN
  SELECT * INTO bay_row FROM public.location_bays WHERE id = p_bay_id FOR UPDATE;
  IF NOT FOUND OR NOT bay_row.active THEN
    RAISE EXCEPTION 'That bay is not in use' USING ERRCODE = '22023';
  END IF;

  UPDATE public.bay_checkins c
     SET cleared_at = now(), cleared_by = auth.uid(), clear_reason = 'expired'
   WHERE c.location_id = bay_row.location_id AND c.cleared_at IS NULL
     AND NOT public.bay_checkin_is_live(c.checked_in_at, c.event_id);
  GET DIAGNOSTICS expired_count = ROW_COUNT;

  UPDATE public.bay_checkins c
     SET cleared_at = now(), cleared_by = auth.uid(), clear_reason = 'finished'
   WHERE c.bay_id = p_bay_id AND c.cleared_at IS NULL
     AND c.team_id <> ALL (p_team_ids)
     AND public.bay_team_finished(c.event_id, c.team_id);
  GET DIAGNOSTICS finished_count = ROW_COUNT;

  -- Sorted, so two check-ins sharing teams always lock them in one order.
  FOR tid IN SELECT DISTINCT x FROM unnest(p_team_ids) x WHERE x IS NOT NULL ORDER BY x LOOP
    -- Two teammates tapping at once (even on different bays) queue here
    -- instead of tripping the one-active-per-team index.
    PERFORM pg_advisory_xact_lock(hashtextextended('bay_checkin:' || p_event_id::text || ':' || tid::text, 0));
    SELECT * INTO cur FROM public.bay_checkins
     WHERE event_id = p_event_id AND team_id = tid AND cleared_at IS NULL
     FOR UPDATE;
    IF FOUND AND cur.bay_id = p_bay_id THEN
      CONTINUE;   -- already here
    END IF;
    IF FOUND THEN
      UPDATE public.bay_checkins
         SET cleared_at = now(), cleared_by = auth.uid(), clear_reason = 'moved'
       WHERE id = cur.id;
      moved_count := moved_count + 1;
    END IF;
    INSERT INTO public.bay_checkins (location_id, event_id, team_id, bay_id, checked_in_by)
    VALUES (bay_row.location_id, p_event_id, tid, p_bay_id, auth.uid());
    added_count := added_count + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'added', added_count, 'moved', moved_count,
    'cleared_finished', finished_count, 'expired', expired_count);
END;
$$;

-- Response shared by checkin_team / admin_checkin_team.
CREATE OR REPLACE FUNCTION public.bay_checkin_result(
  p_bay_id UUID,
  p_event_id UUID,
  p_team_ids UUID[],
  p_suggest_for UUID,
  p_stats JSONB
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'bay', (SELECT jsonb_build_object('id', b.id, 'label', b.label) FROM public.location_bays b WHERE b.id = p_bay_id),
    'event', (SELECT jsonb_build_object('id', e.id, 'name', e.name, 'week_number', e.week_number)
                FROM public.events e WHERE e.id = p_event_id),
    'team_id', p_suggest_for,
    'checked_in', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                      'team_id', t.id, 'team_name', t.name,
                      'players', public.bay_team_players_json(p_event_id, t.id)) ORDER BY t.name), '[]'::jsonb)
                     FROM public.teams t WHERE t.id = ANY (p_team_ids)),
    'teams', public.bay_occupants_json(p_bay_id),
    'suggestions', CASE WHEN p_suggest_for IS NULL THEN '[]'::jsonb
                        ELSE public.bay_checkin_suggestions(p_event_id, p_suggest_for) END,
    'cleared_finished', COALESCE((p_stats->>'cleared_finished')::integer, 0),
    'moved', COALESCE((p_stats->>'moved')::integer, 0)
  );
$$;

-- Open weeks at a location that a team is rostered in (working league first).
CREATE OR REPLACE FUNCTION public.bay_team_open_event(p_location_id UUID, p_team_id UUID)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INTEGER;
  ev UUID;
BEGIN
  SELECT count(DISTINCT r.event_id), min(r.event_id::text)::uuid INTO n, ev
    FROM public.roster_at r JOIN public.events e ON e.id = r.event_id
   WHERE r.team_id = p_team_id AND e.location_id = p_location_id AND e.status = 'open';
  IF n > 1 THEN
    SELECT count(DISTINCT r.event_id), min(r.event_id::text)::uuid INTO n, ev
      FROM public.roster_at r
      JOIN public.events e ON e.id = r.event_id
      JOIN public.league_config lc ON lc.id = e.league_id AND lc.is_working
     WHERE r.team_id = p_team_id AND e.location_id = p_location_id AND e.status = 'open';
  END IF;
  IF n = 0 THEN
    RAISE EXCEPTION 'That team isn''t playing this week (no open week for its league)' USING ERRCODE = '22023';
  ELSIF n > 1 THEN
    RAISE EXCEPTION 'That team is in more than one open week' USING ERRCODE = '22023';
  END IF;
  RETURN ev;
END;
$$;


-- ── 4. Player RPCs ──────────────────────────────────────────────────────────

-- One tap: the caller's whole team onto a bay (plus, optionally, teams they
-- play with — the "Also check in Team B?" chips).
CREATE OR REPLACE FUNCTION public.checkin_team(p_bay_id UUID, p_extra_team_ids UUID[] DEFAULT '{}')
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bay_row public.location_bays%ROWTYPE;
  me RECORD;
  extra UUID;
  teams UUID[];
  stats JSONB;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO bay_row FROM public.location_bays WHERE id = p_bay_id;
  IF NOT FOUND OR NOT public.is_in_location(bay_row.location_id) THEN
    RAISE EXCEPTION 'Bay not found' USING ERRCODE = '22023';
  END IF;
  IF NOT bay_row.active THEN
    RAISE EXCEPTION 'That bay is not in use' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO me FROM public.bay_caller_team(bay_row.location_id);
  IF me.status = 'no_open_week' THEN
    RAISE EXCEPTION 'There''s no open league week right now' USING ERRCODE = '22023';
  ELSIF me.status = 'not_rostered' THEN
    RAISE EXCEPTION 'You''re not on a team for this league week. Ask the front desk to check you in.' USING ERRCODE = '22023';
  ELSIF me.status <> 'ok' THEN
    RAISE EXCEPTION 'You''re on more than one team this week. Ask the front desk to check you in.' USING ERRCODE = '22023';
  END IF;

  teams := ARRAY[me.team_id];
  FOREACH extra IN ARRAY COALESCE(p_extra_team_ids, '{}') LOOP
    CONTINUE WHEN extra IS NULL OR extra = ANY (teams);
    IF NOT EXISTS (SELECT 1 FROM public.roster_at r WHERE r.event_id = me.event_id AND r.team_id = extra) THEN
      RAISE EXCEPTION 'That team isn''t playing this week' USING ERRCODE = '22023';
    END IF;
    teams := teams || extra;
  END LOOP;
  IF array_length(teams, 1) > 8 THEN
    RAISE EXCEPTION 'Too many teams for one bay' USING ERRCODE = '22023';
  END IF;

  stats := public.bay_checkin_internal(p_bay_id, me.event_id, teams);
  RETURN public.bay_checkin_result(p_bay_id, me.event_id, teams, me.team_id, stats);
END;
$$;

CREATE OR REPLACE FUNCTION public.checkout_my_team()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.bay_checkins c
     SET cleared_at = now(), cleared_by = auth.uid(), clear_reason = 'checkout'
   WHERE c.cleared_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.roster_at r
         JOIN public.players p ON p.id = r.player_id
        WHERE r.event_id = c.event_id AND r.team_id = c.team_id
          AND p.user_id = auth.uid() AND p.location_id = c.location_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- The caller's team this week and where it is (dashboard + check-in page).
CREATE OR REPLACE FUNCTION public.my_checkin_status(p_location_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  me RECORD;
  c public.bay_checkins%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.is_in_location(p_location_id) THEN
    RETURN jsonb_build_object('status', 'not_rostered');
  END IF;
  SELECT * INTO me FROM public.bay_caller_team(p_location_id);
  IF me.status <> 'ok' THEN
    RETURN jsonb_build_object('status', me.status);
  END IF;
  SELECT * INTO c FROM public.bay_checkins
   WHERE event_id = me.event_id AND team_id = me.team_id AND cleared_at IS NULL
     AND public.bay_checkin_is_live(checked_in_at, event_id);
  RETURN jsonb_build_object(
    'status', 'ok',
    'event', (SELECT jsonb_build_object('id', e.id, 'name', e.name, 'week_number', e.week_number)
                FROM public.events e WHERE e.id = me.event_id),
    'team', jsonb_build_object(
      'id', me.team_id,
      'name', (SELECT t.name FROM public.teams t WHERE t.id = me.team_id),
      'players', public.bay_team_players_json(me.event_id, me.team_id)),
    'bay', CASE WHEN c.id IS NULL THEN NULL ELSE
             (SELECT jsonb_build_object('id', b.id, 'label', b.label) FROM public.location_bays b WHERE b.id = c.bay_id) END,
    'checked_in_at', c.checked_in_at,
    'suggestions', CASE WHEN c.id IS NULL THEN '[]'::jsonb
                        ELSE public.bay_checkin_suggestions(me.event_id, me.team_id) END
  );
END;
$$;

-- Every active bay with who's on it, plus every team playing this week and
-- where it is (bay_id NULL = not checked in). Location members only.
CREATE OR REPLACE FUNCTION public.bay_board(p_location_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL
     OR NOT (public.is_in_location(p_location_id) OR public.is_admin_of_location(p_location_id)) THEN
    RAISE EXCEPTION 'Not a member of this location' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'bays', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'id', b.id, 'label', b.label, 'sort', b.sort,
                'teams', public.bay_occupants_json(b.id))
              ORDER BY b.sort, lower(b.label)), '[]'::jsonb)
               FROM public.location_bays b
              WHERE b.location_id = p_location_id AND b.active),
    'events', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'week_number', e.week_number)
                ORDER BY e.week_number), '[]'::jsonb)
                 FROM public.events e WHERE e.location_id = p_location_id AND e.status = 'open'),
    'teams', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'team_id', x.team_id, 'team_name', x.team_name, 'event_id', x.event_id,
                 'bay_id', x.bay_id, 'finished', public.bay_team_finished(x.event_id, x.team_id))
               ORDER BY x.team_name), '[]'::jsonb)
                FROM (
                  SELECT DISTINCT r.team_id, r.team_name, r.event_id,
                         (SELECT c.bay_id FROM public.bay_checkins c
                           WHERE c.event_id = r.event_id AND c.team_id = r.team_id AND c.cleared_at IS NULL
                             AND public.bay_checkin_is_live(c.checked_in_at, c.event_id)) AS bay_id
                    FROM public.roster_at r
                    JOIN public.events e ON e.id = r.event_id
                   WHERE e.location_id = p_location_id AND e.status = 'open'
                ) x)
  );
END;
$$;


-- ── 5. Admin RPCs ───────────────────────────────────────────────────────────

-- Walk-ins / players without a phone.
CREATE OR REPLACE FUNCTION public.admin_checkin_team(p_bay_id UUID, p_team_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bay_row public.location_bays%ROWTYPE;
  ev UUID;
  stats JSONB;
BEGIN
  SELECT * INTO bay_row FROM public.location_bays WHERE id = p_bay_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bay not found' USING ERRCODE = '22023'; END IF;
  PERFORM public.require_location_admin(bay_row.location_id);
  IF NOT EXISTS (SELECT 1 FROM public.teams t WHERE t.id = p_team_id AND t.location_id = bay_row.location_id) THEN
    RAISE EXCEPTION 'Team not found' USING ERRCODE = '22023';
  END IF;
  ev := public.bay_team_open_event(bay_row.location_id, p_team_id);
  stats := public.bay_checkin_internal(p_bay_id, ev, ARRAY[p_team_id]);
  PERFORM public.write_audit_event(
    bay_row.location_id, 'bay.admin_checkin', 'location_bays', p_bay_id, NULL,
    jsonb_build_object('team_id', p_team_id, 'event_id', ev, 'bay', bay_row.label) || stats
  );
  RETURN public.bay_checkin_result(p_bay_id, ev, ARRAY[p_team_id], NULL, stats);
END;
$$;

-- Take one team off its bay.
CREATE OR REPLACE FUNCTION public.admin_clear_checkin(p_checkin_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE c public.bay_checkins%ROWTYPE;
BEGIN
  SELECT * INTO c FROM public.bay_checkins WHERE id = p_checkin_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.require_location_admin(c.location_id);
  IF c.cleared_at IS NOT NULL THEN RETURN false; END IF;
  UPDATE public.bay_checkins
     SET cleared_at = now(), cleared_by = auth.uid(), clear_reason = 'manual'
   WHERE id = p_checkin_id;
  PERFORM public.write_audit_event(
    c.location_id, 'bay.clear_team', 'bay_checkins', p_checkin_id,
    jsonb_build_object('team_id', c.team_id, 'bay_id', c.bay_id), NULL
  );
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_clear_bay(p_bay_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bay_row public.location_bays%ROWTYPE;
  n INTEGER;
BEGIN
  SELECT * INTO bay_row FROM public.location_bays WHERE id = p_bay_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bay not found' USING ERRCODE = '22023'; END IF;
  PERFORM public.require_location_admin(bay_row.location_id);
  UPDATE public.bay_checkins
     SET cleared_at = now(), cleared_by = auth.uid(), clear_reason = 'manual'
   WHERE bay_id = p_bay_id AND cleared_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM public.write_audit_event(
    bay_row.location_id, 'bay.clear', 'location_bays', p_bay_id, NULL,
    jsonb_build_object('bay', bay_row.label, 'cleared', n)
  );
  RETURN n;
END;
$$;

-- Between waves: everyone off every bay.
CREATE OR REPLACE FUNCTION public.admin_clear_all_bays(p_location_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n INTEGER;
BEGIN
  PERFORM public.require_location_admin(p_location_id);
  UPDATE public.bay_checkins
     SET cleared_at = now(), cleared_by = auth.uid(), clear_reason = 'clear_all'
   WHERE location_id = p_location_id AND cleared_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM public.write_audit_event(
    p_location_id, 'bay.clear_all', 'location_bays', NULL, NULL,
    jsonb_build_object('cleared', n)
  );
  RETURN n;
END;
$$;

-- Number of bays: the first N bays (by sort) are active, the rest inactive.
-- Missing bays are created with the next free number as label. Bays are
-- never deleted (history keeps pointing at them); a bay switched off is
-- emptied first.
CREATE OR REPLACE FUNCTION public.admin_set_bays(p_location_id UUID, p_count INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  before_count INTEGER;
  existing INTEGER;
  i INTEGER;
  next_label INTEGER := 1;
  cleared INTEGER;
BEGIN
  PERFORM public.require_location_admin(p_location_id);
  IF p_count IS NULL OR p_count < 0 OR p_count > 60 THEN
    RAISE EXCEPTION 'Number of bays must be 0 to 60' USING ERRCODE = '22023';
  END IF;
  -- Serialize concurrent edits for this location.
  PERFORM 1 FROM public.locations WHERE id = p_location_id FOR UPDATE;

  SELECT count(*) FILTER (WHERE active), count(*) INTO before_count, existing
    FROM public.location_bays WHERE location_id = p_location_id;

  FOR i IN existing + 1 .. p_count LOOP
    WHILE EXISTS (SELECT 1 FROM public.location_bays
                   WHERE location_id = p_location_id AND lower(label) = next_label::text) LOOP
      next_label := next_label + 1;
    END LOOP;
    INSERT INTO public.location_bays (location_id, label, sort, active)
    VALUES (p_location_id, next_label::text, i, true);
  END LOOP;

  WITH ranked AS (
    SELECT id, row_number() OVER (ORDER BY sort, created_at, id) AS rn
      FROM public.location_bays WHERE location_id = p_location_id
  )
  UPDATE public.location_bays b
     SET active = (r.rn <= p_count), sort = r.rn
    FROM ranked r
   WHERE b.id = r.id AND (b.active IS DISTINCT FROM (r.rn <= p_count) OR b.sort <> r.rn);

  UPDATE public.bay_checkins c
     SET cleared_at = now(), cleared_by = auth.uid(), clear_reason = 'manual'
    FROM public.location_bays b
   WHERE b.id = c.bay_id AND b.location_id = p_location_id AND NOT b.active AND c.cleared_at IS NULL;
  GET DIAGNOSTICS cleared = ROW_COUNT;

  PERFORM public.write_audit_event(
    p_location_id, 'bay.set_count', 'location_bays', NULL,
    jsonb_build_object('active', before_count), jsonb_build_object('active', p_count, 'cleared', cleared)
  );
  RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label, 'sort', b.sort)
                                    ORDER BY b.sort), '[]'::jsonb)
            FROM public.location_bays b WHERE b.location_id = p_location_id AND b.active);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_rename_bay(p_bay_id UUID, p_label TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bay_row public.location_bays%ROWTYPE;
  new_label TEXT := btrim(COALESCE(p_label, ''));
BEGIN
  SELECT * INTO bay_row FROM public.location_bays WHERE id = p_bay_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Bay not found' USING ERRCODE = '22023'; END IF;
  PERFORM public.require_location_admin(bay_row.location_id);
  IF length(new_label) < 1 OR length(new_label) > 20 THEN
    RAISE EXCEPTION 'Bay name must be 1 to 20 characters' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.location_bays
              WHERE location_id = bay_row.location_id AND lower(label) = lower(new_label) AND id <> p_bay_id) THEN
    RAISE EXCEPTION 'Another bay is already called %', new_label USING ERRCODE = '22023';
  END IF;
  UPDATE public.location_bays SET label = new_label WHERE id = p_bay_id;
  PERFORM public.write_audit_event(
    bay_row.location_id, 'bay.rename', 'location_bays', p_bay_id,
    jsonb_build_object('label', bay_row.label), jsonb_build_object('label', new_label)
  );
  RETURN jsonb_build_object('id', p_bay_id, 'label', new_label);
END;
$$;


-- ── 6. sim_bay (service role only; sim-ingest routes bay actions here) ──────
-- p_key_hash: SHA-256 hex of the presented key (hashed in the edge function).
-- p_payload:  { action: 'bay' | 'clear_bay', bay: '<label>' }
-- Errors: 28000 = bad key (401); 22023 = bad request (422).
CREATE OR REPLACE FUNCTION public.sim_bay(p_key_hash TEXT, p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  key_row public.location_api_keys%ROWTYPE;
  bay_row public.location_bays%ROWTYPE;
  act TEXT;
  label_in TEXT;
  n INTEGER;
BEGIN
  SELECT * INTO key_row FROM public.location_api_keys
   WHERE key_hash = lower(COALESCE(p_key_hash, '')) AND kind = 'sim' AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invalid API key' USING ERRCODE = '28000'; END IF;
  UPDATE public.location_api_keys SET last_used_at = now()
   WHERE id = key_row.id AND (last_used_at IS NULL OR last_used_at < now() - INTERVAL '5 minutes');

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Body must be a JSON object' USING ERRCODE = '22023';
  END IF;
  act := p_payload->>'action';
  label_in := btrim(COALESCE(p_payload->>'bay', ''));
  IF label_in = '' THEN RAISE EXCEPTION 'bay is required' USING ERRCODE = '22023'; END IF;
  SELECT * INTO bay_row FROM public.location_bays
   WHERE location_id = key_row.location_id AND lower(label) = lower(label_in) AND active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown bay "%"', left(label_in, 20) USING ERRCODE = '22023';
  END IF;

  IF act = 'bay' THEN
    RETURN jsonb_build_object('bay', bay_row.label, 'occupants', public.bay_occupants_json(bay_row.id));
  ELSIF act = 'clear_bay' THEN
    PERFORM 1 FROM public.location_bays WHERE id = bay_row.id FOR UPDATE;
    UPDATE public.bay_checkins
       SET cleared_at = now(), cleared_by = NULL, clear_reason = 'sim'
     WHERE bay_id = bay_row.id AND cleared_at IS NULL;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      PERFORM public.write_audit_event(
        key_row.location_id, 'bay.clear', 'location_bays', bay_row.id, NULL,
        jsonb_build_object('bay', bay_row.label, 'cleared', n, 'source', 'sim')
      );
    END IF;
    RETURN jsonb_build_object('bay', bay_row.label, 'cleared', n);
  END IF;
  RAISE EXCEPTION 'Unknown action (use "bay" or "clear_bay")' USING ERRCODE = '22023';
END;
$$;


-- ── 7. Grants ───────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.bay_checkin_is_live(TIMESTAMPTZ, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bay_team_finished(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bay_team_players_json(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bay_occupants_json(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bay_checkin_suggestions(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bay_caller_team(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bay_checkin_internal(UUID, UUID, UUID[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bay_checkin_result(UUID, UUID, UUID[], UUID, JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.bay_team_open_event(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.checkin_team(UUID, UUID[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.checkout_my_team() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.my_checkin_status(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bay_board(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_checkin_team(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_clear_checkin(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_clear_bay(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_clear_all_bays(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_set_bays(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_rename_bay(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sim_bay(TEXT, JSONB) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.checkin_team(UUID, UUID[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.checkout_my_team() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_checkin_status(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bay_board(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_checkin_team(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_clear_checkin(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_clear_bay(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_clear_all_bays(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_bays(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_rename_bay(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.sim_bay(TEXT, JSONB) TO service_role;

COMMIT;

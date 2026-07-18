-- Phase 3.3: matchups + the format engine's scoring core.
--
-- matchups pair two teams (match_team) or two players (match_individual) for
-- one event. Writes are RPC-only (admin_set_matchups); members read their
-- location's rows. Results are computed server-side by compute_event_results,
-- which publish_week calls before closing the week and admins can re-run via
-- admin_rescore_event after late score corrections.
--
-- Engine v1 semantics:
--   match_team       per-hole net (sum of both teammates' net) — fewer wins the
--                    hole; more holes won wins the match. ponytail: aggregate
--                    net per hole; a best-ball-per-hole match variant can land
--                    as a format_config option later.
--   match_individual per-hole net, player vs player.
--   stableford       per-player points from net score vs par, stored on
--                    scores.format_points (quota_basis=handicap stores points
--                    minus a (2×holes − handicap) quota).
--   stroke           unchanged (net totals; no matchups involved).

BEGIN;

ALTER TABLE public.scores ADD COLUMN IF NOT EXISTS format_points NUMERIC;

CREATE TABLE IF NOT EXISTS public.matchups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES public.locations(id),
  league_id UUID NOT NULL,
  home_team_id UUID REFERENCES public.teams(id) ON DELETE CASCADE,
  away_team_id UUID REFERENCES public.teams(id) ON DELETE CASCADE,
  home_player_id UUID REFERENCES public.players(id) ON DELETE CASCADE,
  away_player_id UUID REFERENCES public.players(id) ON DELETE CASCADE,
  points_home NUMERIC,
  points_away NUMERIC,
  result JSONB,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'scored')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT matchups_one_pair CHECK (
    (home_team_id IS NOT NULL AND away_team_id IS NOT NULL
      AND home_player_id IS NULL AND away_player_id IS NULL
      AND home_team_id <> away_team_id)
    OR
    (home_player_id IS NOT NULL AND away_player_id IS NOT NULL
      AND home_team_id IS NULL AND away_team_id IS NULL
      AND home_player_id <> away_player_id)
  )
);

CREATE INDEX IF NOT EXISTS matchups_event_idx ON public.matchups(event_id);
CREATE INDEX IF NOT EXISTS matchups_league_idx ON public.matchups(location_id, league_id);

ALTER TABLE public.matchups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "matchups: location members read" ON public.matchups;
CREATE POLICY "matchups: location members read" ON public.matchups
  FOR SELECT TO authenticated
  USING (public.is_in_location(location_id));

REVOKE ALL ON public.matchups FROM anon;
GRANT SELECT ON public.matchups TO authenticated;

-- ── Pure scoring helpers ─────────────────────────────────────────────────────

-- Per-hole handicap strokes. rank of hole i = stroke_index[i] (or the hole's
-- position when no index is set — the documented even-spread fallback).
-- Plus players (negative handicap) give strokes back starting at the easiest
-- hole. allowance_pct scales the handicap before allocation.
CREATE OR REPLACE FUNCTION public.format_strokes_received(
  p_handicap NUMERIC,
  p_stroke_index JSONB,
  p_num_holes INTEGER,
  p_allowance_pct NUMERIC DEFAULT 100
)
RETURNS INTEGER[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  strokes INTEGER;
  base INTEGER;
  extra INTEGER;
  ranks INTEGER[];
  i INTEGER;
  out_arr INTEGER[] := '{}';
BEGIN
  strokes := round(COALESCE(p_handicap, 0) * COALESCE(p_allowance_pct, 100) / 100.0)::integer;
  IF p_stroke_index IS NOT NULL AND jsonb_typeof(p_stroke_index) = 'array'
     AND jsonb_array_length(p_stroke_index) = p_num_holes THEN
    ranks := ARRAY(SELECT raw::integer FROM jsonb_array_elements_text(p_stroke_index) AS t(raw));
  ELSE
    ranks := ARRAY(SELECT generate_series(1, p_num_holes));
  END IF;

  base := abs(strokes) / p_num_holes;
  extra := abs(strokes) % p_num_holes;
  FOR i IN 1..p_num_holes LOOP
    IF strokes >= 0 THEN
      -- extra strokes land on the hardest holes (rank 1 = hardest)
      out_arr := out_arr || (base + CASE WHEN ranks[i] <= extra THEN 1 ELSE 0 END);
    ELSE
      -- strokes given back start at the easiest hole (rank n)
      out_arr := out_arr || (-(base + CASE WHEN (p_num_holes - ranks[i] + 1) <= extra THEN 1 ELSE 0 END));
    END IF;
  END LOOP;
  RETURN out_arr;
END;
$$;

-- Hole-by-hole match play over two per-hole net arrays. Lower net wins a hole.
CREATE OR REPLACE FUNCTION public.format_match_result(p_home NUMERIC[], p_away NUMERIC[])
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'version', 1,
    'holes_home', count(*) FILTER (WHERE h < a),
    'holes_away', count(*) FILTER (WHERE a < h),
    'holes_halved', count(*) FILTER (WHERE h = a)
  )
  FROM unnest(p_home, p_away) AS t(h, a);
$$;

-- Stableford points for one round. p_points overrides the default table.
CREATE OR REPLACE FUNCTION public.format_stableford_points(
  p_hole_scores INTEGER[],
  p_hole_pars JSONB,
  p_strokes INTEGER[],
  p_points JSONB DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  pts JSONB := COALESCE(p_points, '{}'::jsonb);
  total NUMERIC := 0;
  i INTEGER;
  diff INTEGER;  -- net score minus par
  pars INTEGER[];
BEGIN
  pars := ARRAY(SELECT raw::integer FROM jsonb_array_elements_text(p_hole_pars) AS t(raw));
  FOR i IN 1..cardinality(p_hole_scores) LOOP
    diff := (p_hole_scores[i] - COALESCE(p_strokes[i], 0)) - pars[i];
    total := total + CASE
      WHEN diff <= -3 THEN COALESCE((pts->>'albatross')::numeric, 5)
      WHEN diff  = -2 THEN COALESCE((pts->>'eagle')::numeric, 4)
      WHEN diff  = -1 THEN COALESCE((pts->>'birdie')::numeric, 3)
      WHEN diff  =  0 THEN COALESCE((pts->>'par')::numeric, 2)
      WHEN diff  =  1 THEN COALESCE((pts->>'bogey')::numeric, 1)
      ELSE COALESCE((pts->>'double_bogey_plus')::numeric, 0)
    END;
  END LOOP;
  RETURN total;
END;
$$;

-- ── admin_set_matchups ───────────────────────────────────────────────────────
-- Replaces the full matchup list for an event. Round-robin generation happens
-- client-side; this is the only write path and enforces the invariants.

CREATE OR REPLACE FUNCTION public.admin_set_matchups(p_event_id UUID, p_pairs JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  pair JSONB;
  home_team UUID; away_team UUID; home_player UUID; away_player UUID;
  seen UUID[] := '{}';
  inserted INTEGER := 0;
BEGIN
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;
  PERFORM public.require_location_admin(event_row.location_id);
  IF event_row.status = 'closed' THEN
    RAISE EXCEPTION 'Matchups of a published event cannot change';
  END IF;
  IF jsonb_typeof(p_pairs) <> 'array' THEN RAISE EXCEPTION 'pairs must be a JSON array'; END IF;

  DELETE FROM public.matchups WHERE event_id = p_event_id;

  FOR pair IN SELECT value FROM jsonb_array_elements(p_pairs)
  LOOP
    home_team   := NULLIF(pair->>'home_team_id', '')::uuid;
    away_team   := NULLIF(pair->>'away_team_id', '')::uuid;
    home_player := NULLIF(pair->>'home_player_id', '')::uuid;
    away_player := NULLIF(pair->>'away_player_id', '')::uuid;

    IF home_team IS NOT NULL THEN
      IF (SELECT count(*) FROM public.teams
           WHERE id IN (home_team, away_team)
             AND league_id = event_row.league_id
             AND location_id = event_row.location_id) <> 2 THEN
        RAISE EXCEPTION 'Both teams must belong to the event league';
      END IF;
      IF home_team = ANY(seen) OR away_team = ANY(seen) THEN
        RAISE EXCEPTION 'A team can only appear in one matchup per event';
      END IF;
      seen := seen || home_team || away_team;
    ELSIF home_player IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.roster_at WHERE event_id = p_event_id AND player_id = home_player)
         OR NOT EXISTS (SELECT 1 FROM public.roster_at WHERE event_id = p_event_id AND player_id = away_player) THEN
        RAISE EXCEPTION 'Both players must be rostered for the event';
      END IF;
      IF home_player = ANY(seen) OR away_player = ANY(seen) THEN
        RAISE EXCEPTION 'A player can only appear in one matchup per event';
      END IF;
      seen := seen || home_player || away_player;
    ELSE
      RAISE EXCEPTION 'Each pair needs home/away team ids or player ids';
    END IF;

    INSERT INTO public.matchups (
      event_id, location_id, league_id,
      home_team_id, away_team_id, home_player_id, away_player_id
    ) VALUES (
      p_event_id, event_row.location_id, event_row.league_id,
      home_team, away_team, home_player, away_player
    );
    inserted := inserted + 1;
  END LOOP;

  PERFORM public.write_audit_event(
    event_row.location_id, 'matchup.set', 'events', p_event_id, NULL,
    jsonb_build_object('pairs', p_pairs, 'count', inserted)
  );
  RETURN inserted;
END;
$$;

-- ── compute_event_results ────────────────────────────────────────────────────
-- Scores every matchup of the event from verified played scores and fills
-- scores.format_points for stableford events. Idempotent; callers hold the
-- event-row lock (publish_week) or take it (admin_rescore_event).

CREATE OR REPLACE FUNCTION public.compute_event_results(p_event_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  course_row public.courses%ROWTYPE;
  cfg JSONB;
  allowance NUMERIC;
  pts_win NUMERIC; pts_tie NUMERIC; pts_loss NUMERIC;
  no_show TEXT;
  m RECORD;
  net_home NUMERIC[]; net_away NUMERIC[];
  match_result JSONB;
  scored_count INTEGER := 0;
BEGIN
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;
  cfg := COALESCE(event_row.format_config, '{"version":1}'::jsonb);

  IF event_row.format = 'stableford' THEN
    SELECT * INTO course_row FROM public.courses WHERE id = event_row.course_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Stableford scoring requires a course'; END IF;
    UPDATE public.scores s
       SET format_points = public.format_stableford_points(
             s.hole_scores, course_row.hole_pars,
             public.format_strokes_received(s.handicap_used, course_row.stroke_index, course_row.num_holes, 100),
             cfg->'points'
           )
           - CASE WHEN cfg->>'quota_basis' = 'handicap'
                  THEN (2 * course_row.num_holes) - COALESCE(s.handicap_used, 0)
                  ELSE 0 END
     WHERE s.event_id = p_event_id
       AND s.entry_type = 'played'
       AND s.status = 'verified'
       AND s.hole_scores IS NOT NULL;
    GET DIAGNOSTICS scored_count = ROW_COUNT;
    RETURN jsonb_build_object('format', 'stableford', 'players_scored', scored_count);
  END IF;

  IF event_row.format NOT IN ('match_team', 'match_individual') THEN
    RETURN jsonb_build_object('format', event_row.format, 'matchups_scored', 0);
  END IF;

  SELECT * INTO course_row FROM public.courses WHERE id = event_row.course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Match scoring requires a course'; END IF;

  allowance := COALESCE((cfg->>'allowance_pct')::numeric, 100);
  pts_win  := COALESCE((cfg->>'points_win')::numeric, 2);
  pts_tie  := COALESCE((cfg->>'points_tie')::numeric, 1);
  pts_loss := COALESCE((cfg->>'points_loss')::numeric, 0);
  no_show  := COALESCE(cfg->>'no_show', 'forfeit');

  FOR m IN SELECT * FROM public.matchups WHERE event_id = p_event_id
  LOOP
    -- Per-hole net for each side: sum over that side's verified played scores
    -- (one player for match_individual, both teammates for match_team).
    SELECT array_agg_sum INTO net_home FROM (
      SELECT public.per_hole_net_sum(p_event_id, m.home_team_id, m.home_player_id,
                                     course_row.stroke_index, course_row.num_holes, allowance) AS array_agg_sum
    ) t;
    SELECT array_agg_sum INTO net_away FROM (
      SELECT public.per_hole_net_sum(p_event_id, m.away_team_id, m.away_player_id,
                                     course_row.stroke_index, course_row.num_holes, allowance) AS array_agg_sum
    ) t;

    IF net_home IS NULL OR net_away IS NULL THEN
      -- No-show handling: a side with no verified scores didn't play.
      UPDATE public.matchups SET
        status = 'scored',
        result = jsonb_build_object('version', 1, 'no_show',
                   CASE WHEN net_home IS NULL AND net_away IS NULL THEN 'both'
                        WHEN net_home IS NULL THEN 'home' ELSE 'away' END,
                 'policy', no_show),
        points_home = CASE
          WHEN net_home IS NULL AND net_away IS NULL THEN
            CASE no_show WHEN 'half_points' THEN pts_tie ELSE pts_loss END
          WHEN net_home IS NULL THEN
            CASE no_show WHEN 'half_points' THEN pts_tie WHEN 'zero_points' THEN 0 ELSE pts_loss END
          ELSE CASE no_show WHEN 'half_points' THEN pts_tie ELSE pts_win END
        END,
        points_away = CASE
          WHEN net_home IS NULL AND net_away IS NULL THEN
            CASE no_show WHEN 'half_points' THEN pts_tie ELSE pts_loss END
          WHEN net_away IS NULL THEN
            CASE no_show WHEN 'half_points' THEN pts_tie WHEN 'zero_points' THEN 0 ELSE pts_loss END
          ELSE CASE no_show WHEN 'half_points' THEN pts_tie ELSE pts_win END
        END
      WHERE id = m.id;
    ELSE
      match_result := public.format_match_result(net_home, net_away);
      UPDATE public.matchups SET
        status = 'scored',
        result = match_result,
        points_home = CASE
          WHEN (match_result->>'holes_home')::int > (match_result->>'holes_away')::int THEN pts_win
          WHEN (match_result->>'holes_home')::int < (match_result->>'holes_away')::int THEN pts_loss
          ELSE pts_tie END,
        points_away = CASE
          WHEN (match_result->>'holes_away')::int > (match_result->>'holes_home')::int THEN pts_win
          WHEN (match_result->>'holes_away')::int < (match_result->>'holes_home')::int THEN pts_loss
          ELSE pts_tie END
      WHERE id = m.id;
    END IF;
    scored_count := scored_count + 1;
  END LOOP;

  RETURN jsonb_build_object('format', event_row.format, 'matchups_scored', scored_count);
END;
$$;

-- Per-hole net sum for one side of a matchup. NULL when the side has no
-- verified played scores (no-show detection).
CREATE OR REPLACE FUNCTION public.per_hole_net_sum(
  p_event_id UUID,
  p_team_id UUID,
  p_player_id UUID,
  p_stroke_index JSONB,
  p_num_holes INTEGER,
  p_allowance NUMERIC
)
RETURNS NUMERIC[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s RECORD;
  strokes INTEGER[];
  totals NUMERIC[];
  i INTEGER;
  found_any BOOLEAN := false;
BEGIN
  totals := array_fill(0::numeric, ARRAY[p_num_holes]);
  FOR s IN
    SELECT sc.hole_scores, sc.handicap_used
      FROM public.scores sc
     WHERE sc.event_id = p_event_id
       AND sc.entry_type = 'played'
       AND sc.status = 'verified'
       AND sc.hole_scores IS NOT NULL
       AND ((p_player_id IS NOT NULL AND sc.player_id = p_player_id)
         OR (p_player_id IS NULL AND sc.team_id = p_team_id))
  LOOP
    -- Sub rounds count for the team they played for; mirrored sub-profile rows
    -- carry the sub's own player_id and a NULL/foreign team_id, so the
    -- team_id filter above naturally excludes them.
    found_any := true;
    strokes := public.format_strokes_received(s.handicap_used, p_stroke_index, p_num_holes, p_allowance);
    FOR i IN 1..p_num_holes LOOP
      totals[i] := totals[i] + s.hole_scores[i] - strokes[i];
    END LOOP;
  END LOOP;
  IF NOT found_any THEN RETURN NULL; END IF;
  RETURN totals;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_rescore_event(p_event_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  outcome JSONB;
BEGIN
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;
  PERFORM public.require_location_admin(event_row.location_id);
  outcome := public.compute_event_results(p_event_id);
  PERFORM public.write_audit_event(
    event_row.location_id, 'event.rescore', 'events', p_event_id, NULL, outcome
  );
  RETURN outcome;
END;
$$;

-- ── publish_week: score results before closing ───────────────────────────────

CREATE OR REPLACE FUNCTION public.publish_week(p_event_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  next_event_id UUID;
  pending_count INTEGER;
  penalty_row RECORD;
  penalties_added INTEGER := 0;
  results JSONB;
BEGIN
  -- Same event-row lock as submit_scores.
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;
  PERFORM public.require_location_admin(event_row.location_id);

  IF event_row.status = 'closed' THEN
    RETURN jsonb_build_object('published', false, 'already_closed', true, 'next_event_id', NULL);
  END IF;
  IF event_row.status <> 'open' THEN RAISE EXCEPTION 'Only an open event can be published'; END IF;

  SELECT count(*) INTO pending_count FROM public.scores
   WHERE event_id = p_event_id AND status = 'pending';
  IF pending_count > 0 THEN
    RAISE EXCEPTION 'Resolve % pending score row(s) before publishing', pending_count;
  END IF;

  -- A verified played result always supersedes an old penalty.
  DELETE FROM public.scores penalty
   WHERE penalty.event_id = p_event_id
     AND penalty.entry_type = 'missed_penalty'
     AND EXISTS (
       SELECT 1 FROM public.scores played
        WHERE played.event_id = penalty.event_id
          AND played.player_id = penalty.player_id
          AND played.entry_type = 'played'
          AND played.status = 'verified'
     );

  FOR penalty_row IN
    INSERT INTO public.scores (
      event_id, player_id, team_id, hole_scores, gross_total, net_total,
      handicap_used, sub_played, entry_type, status, location_id
    )
    SELECT
      p_event_id, r.player_id, r.team_id, NULL, NULL,
      round(COALESCE(p.handicap, 0))::integer + 7,
      round(COALESCE(p.handicap, 0))::integer,
      false, 'missed_penalty', 'verified', event_row.location_id
    FROM public.roster_at r
    JOIN public.players p ON p.id = r.player_id
    WHERE r.event_id = p_event_id
      AND NOT EXISTS (
        SELECT 1 FROM public.scores existing
         WHERE existing.event_id = p_event_id
           AND existing.player_id = r.player_id
           AND existing.entry_type = 'played'
           AND existing.status = 'verified'
      )
    ON CONFLICT (event_id, player_id, entry_type) WHERE status <> 'rejected'
    DO NOTHING
    RETURNING id, player_id
  LOOP
    penalties_added := penalties_added + 1;
    PERFORM public.phase1_apply_no_show_policy(p_event_id, penalty_row.player_id, penalty_row.id);
  END LOOP;

  -- Phase 3: format engine — score matchups / stableford points before close.
  results := public.compute_event_results(p_event_id);

  UPDATE public.events SET status = 'closed' WHERE id = p_event_id;

  SELECT id INTO next_event_id
    FROM public.events
   WHERE location_id = event_row.location_id
     AND league_id = event_row.league_id
     AND status = 'draft'
     AND NOT COALESCE(is_bye, false)
     AND week_number > COALESCE(event_row.week_number, 0)
   ORDER BY week_number, start_date, id
   LIMIT 1
   FOR UPDATE;
  IF next_event_id IS NOT NULL THEN
    UPDATE public.events SET status = 'open' WHERE id = next_event_id;
  END IF;

  PERFORM public.write_audit_event(
    event_row.location_id, 'event.publish', 'events', p_event_id,
    to_jsonb(event_row),
    jsonb_build_object(
      'status', 'closed',
      'penalties_added', penalties_added,
      'results', results,
      'next_event_id', next_event_id
    )
  );
  RETURN jsonb_build_object(
    'published', true,
    'already_closed', false,
    'penalties_added', penalties_added,
    'results', results,
    'next_event_id', next_event_id
  );
END;
$$;

-- ── grants ───────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.format_strokes_received(NUMERIC, JSONB, INTEGER, NUMERIC) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.format_match_result(NUMERIC[], NUMERIC[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.format_stableford_points(INTEGER[], JSONB, INTEGER[], JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_set_matchups(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.compute_event_results(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.per_hole_net_sum(UUID, UUID, UUID, JSONB, INTEGER, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_rescore_event(UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admin_set_matchups(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_rescore_event(UUID) TO authenticated;

COMMIT;

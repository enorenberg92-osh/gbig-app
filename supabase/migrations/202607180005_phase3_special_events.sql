-- Phase 3.5: special event nights.
-- 1. compute_event_results learns scramble + best_ball: the team-of-the-night
--    result is written to scores.format_points on every team member's row
--    (identical value; leaderboards read one per team).
--      scramble  team result = shared gross − round(combined hcp × pct/100)
--      best_ball team result = Σ per-hole best (or sum of both) net among team
-- 2. Handicap recalculation skips rounds from events whose format_config sets
--    exclude_from_handicap (scramble defaults to excluded — a shared ball says
--    nothing about an individual's game).

BEGIN;

-- ── recalc exclusion ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recalculate_player_handicap(p_player_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  player_row public.players%ROWTYPE;
  score_limit INTEGER;
  diffs NUMERIC[];
  sorted_diffs NUMERIC[];
  n INTEGER;
  low_discard INTEGER;
  high_discard INTEGER;
  used_diffs NUMERIC[];
  new_handicap INTEGER;
BEGIN
  SELECT * INTO player_row FROM public.players WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not found'; END IF;
  PERFORM public.require_location_admin(player_row.location_id);
  IF COALESCE(player_row.handicap_locked, false) THEN RETURN jsonb_build_object('skipped', true, 'reason', 'locked'); END IF;
  SELECT COALESCE(num_weeks, 12) INTO score_limit FROM public.league_config
   WHERE location_id = player_row.location_id AND is_working ORDER BY id LIMIT 1;
  score_limit := COALESCE(score_limit, 12);

  SELECT array_agg(diff ORDER BY week_number, start_date, created_at)
    INTO diffs
    FROM (
      SELECT s.gross_total - c.total_par AS diff, e.week_number, e.start_date, s.created_at
        FROM public.scores s
        JOIN public.events e ON e.id = s.event_id
        JOIN public.courses c ON c.id = e.course_id
       WHERE s.player_id = p_player_id
         AND s.location_id = player_row.location_id
         AND s.entry_type = 'played'
         AND s.status = 'verified'
         AND NOT COALESCE(s.sub_played, false)
         AND s.gross_total IS NOT NULL
         -- Phase 3.5: special-night rounds flagged exclude_from_handicap
         -- (scramble default: excluded) don't feed the handicap.
         AND NOT (
           COALESCE((e.format_config->>'exclude_from_handicap')::boolean,
                    e.format = 'scramble')
         )
       ORDER BY e.week_number DESC NULLS LAST, e.start_date DESC NULLS LAST, s.created_at DESC
       LIMIT score_limit
    ) recent;
  IF diffs IS NULL OR cardinality(diffs) = 0 THEN RETURN jsonb_build_object('skipped', true, 'reason', 'no_scores'); END IF;
  SELECT array_agg(value ORDER BY value) INTO sorted_diffs FROM unnest(diffs) value;
  n := cardinality(sorted_diffs);
  high_discard := CASE WHEN n >= 4 THEN 1 ELSE 0 END;
  low_discard := CASE WHEN n >= 5 THEN 1 ELSE 0 END;
  used_diffs := sorted_diffs[(1 + low_discard):(n - high_discard)];
  SELECT greatest(-2, least(27, floor(avg(value) * 0.90)::integer)) INTO new_handicap FROM unnest(used_diffs) value;
  IF new_handicap IS NOT DISTINCT FROM player_row.handicap THEN
    RETURN jsonb_build_object('skipped', true, 'newHcp', new_handicap);
  END IF;
  PERFORM set_config('app.player_write', 'on', true);
  UPDATE public.players SET handicap = new_handicap WHERE id = p_player_id;
  PERFORM public.write_audit_event(
    player_row.location_id, 'handicap.recalculate', 'players', p_player_id,
    jsonb_build_object('handicap', player_row.handicap),
    jsonb_build_object('handicap', new_handicap, 'scores_used', cardinality(used_diffs))
  );
  RETURN jsonb_build_object('updated', true, 'oldHcp', player_row.handicap, 'newHcp', new_handicap);
END;
$$;

-- ── team-of-the-night results ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.compute_team_night_results(p_event_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  course_row public.courses%ROWTYPE;
  cfg JSONB;
  team RECORD;
  s RECORD;
  team_result NUMERIC;
  best NUMERIC;
  hole_sum NUMERIC;
  i INTEGER;
  member_count INTEGER;
  combined_hcp NUMERIC;
  strokes INTEGER[];
  nets NUMERIC[][];
  teams_scored INTEGER := 0;
  balls INTEGER;
BEGIN
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id;
  cfg := COALESCE(event_row.format_config, '{"version":1}'::jsonb);
  SELECT * INTO course_row FROM public.courses WHERE id = event_row.course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Team night scoring requires a course'; END IF;

  FOR team IN
    SELECT DISTINCT sc.team_id
      FROM public.scores sc
     WHERE sc.event_id = p_event_id
       AND sc.entry_type = 'played' AND sc.status = 'verified'
       AND sc.hole_scores IS NOT NULL AND sc.team_id IS NOT NULL
  LOOP
    IF event_row.format = 'scramble' THEN
      -- Teammates share one ball: rows are duplicates of the team score.
      SELECT min(sc.gross_total), sum(sc.handicap_used), count(*)
        INTO team_result, combined_hcp, member_count
        FROM public.scores sc
       WHERE sc.event_id = p_event_id AND sc.team_id = team.team_id
         AND sc.entry_type = 'played' AND sc.status = 'verified';
      team_result := team_result
        - round(COALESCE(combined_hcp, 0) * COALESCE((cfg->>'team_handicap_pct')::numeric, 35) / 100.0);
    ELSE
      -- best_ball: per-hole best net (balls_counted=1) or both nets summed (=2).
      balls := COALESCE((cfg->>'balls_counted')::integer, 1);
      team_result := 0;
      FOR i IN 1..course_row.num_holes LOOP
        best := NULL; hole_sum := 0;
        FOR s IN
          SELECT sc.hole_scores, sc.handicap_used
            FROM public.scores sc
           WHERE sc.event_id = p_event_id AND sc.team_id = team.team_id
             AND sc.entry_type = 'played' AND sc.status = 'verified'
             AND sc.hole_scores IS NOT NULL
        LOOP
          strokes := public.format_strokes_received(
            s.handicap_used, course_row.stroke_index, course_row.num_holes,
            COALESCE((cfg->>'allowance_pct')::numeric, 100));
          hole_sum := hole_sum + (s.hole_scores[i] - strokes[i]);
          IF best IS NULL OR (s.hole_scores[i] - strokes[i]) < best THEN
            best := s.hole_scores[i] - strokes[i];
          END IF;
        END LOOP;
        team_result := team_result + CASE WHEN balls = 2 THEN hole_sum ELSE COALESCE(best, 0) END;
      END LOOP;
    END IF;

    UPDATE public.scores SET format_points = team_result
     WHERE event_id = p_event_id AND team_id = team.team_id
       AND entry_type = 'played' AND status = 'verified';
    teams_scored := teams_scored + 1;
  END LOOP;
  RETURN teams_scored;
END;
$$;

-- compute_event_results: route scramble/best_ball to the team-night scorer.
-- (Body otherwise identical to 202607180003.)
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

  IF event_row.format IN ('scramble', 'best_ball') THEN
    scored_count := public.compute_team_night_results(p_event_id);
    RETURN jsonb_build_object('format', event_row.format, 'teams_scored', scored_count);
  END IF;

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
    SELECT array_agg_sum INTO net_home FROM (
      SELECT public.per_hole_net_sum(p_event_id, m.home_team_id, m.home_player_id,
                                     course_row.stroke_index, course_row.num_holes, allowance) AS array_agg_sum
    ) t;
    SELECT array_agg_sum INTO net_away FROM (
      SELECT public.per_hole_net_sum(p_event_id, m.away_team_id, m.away_player_id,
                                     course_row.stroke_index, course_row.num_holes, allowance) AS array_agg_sum
    ) t;

    IF net_home IS NULL OR net_away IS NULL THEN
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

REVOKE ALL ON FUNCTION public.compute_team_night_results(UUID) FROM PUBLIC, anon, authenticated;

COMMIT;

-- Phase 4.1: optional per-hole stats + handicap history feed.
-- scores.hole_stats: [{putts, fir, gir, penalties}] per hole — every field
-- optional/null (stats are always skippable). Shape enforced by CHECK; length
-- (must match the course) enforced in the RPCs that know the course.
-- recalculate_player_handicap now records each change in handicap_history
-- (the table existed since v1 but nothing wrote to it — the Phase 4 profile
-- graph reads it).

BEGIN;

ALTER TABLE public.scores ADD COLUMN IF NOT EXISTS hole_stats JSONB;

CREATE OR REPLACE FUNCTION public.hole_stats_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  entry JSONB;
  key TEXT;
BEGIN
  IF value IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(value) <> 'array' THEN RETURN false; END IF;
  FOR entry IN SELECT * FROM jsonb_array_elements(value)
  LOOP
    IF jsonb_typeof(entry) <> 'object' THEN RETURN false; END IF;
    FOR key IN SELECT jsonb_object_keys(entry)
    LOOP
      IF key NOT IN ('putts', 'fir', 'gir', 'penalties') THEN RETURN false; END IF;
    END LOOP;
    IF entry ? 'putts' AND jsonb_typeof(entry->'putts') <> 'null' AND
       ((entry->>'putts')::integer IS NULL OR (entry->>'putts')::integer NOT BETWEEN 0 AND 10) THEN
      RETURN false;
    END IF;
    IF entry ? 'penalties' AND jsonb_typeof(entry->'penalties') <> 'null' AND
       ((entry->>'penalties')::integer IS NULL OR (entry->>'penalties')::integer NOT BETWEEN 0 AND 5) THEN
      RETURN false;
    END IF;
    IF entry ? 'fir' AND jsonb_typeof(entry->'fir') NOT IN ('boolean', 'null') THEN RETURN false; END IF;
    IF entry ? 'gir' AND jsonb_typeof(entry->'gir') NOT IN ('boolean', 'null') THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.scores'::regclass AND conname = 'scores_hole_stats_shape'
  ) THEN
    ALTER TABLE public.scores
      ADD CONSTRAINT scores_hole_stats_shape CHECK (public.hole_stats_valid(hole_stats));
  END IF;
END $$;

-- ── submit_scores: accept optional hole_stats per entry ──────────────────────
CREATE OR REPLACE FUNCTION public.submit_scores(p_event_id UUID, p_entries JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  caller_player public.players%ROWTYPE;
  caller_team_id UUID;
  course_row public.courses%ROWTYPE;
  entry JSONB;
  entry_player public.players%ROWTYPE;
  holes JSONB;
  holes_int INTEGER[];
  stats JSONB;
  gross INTEGER;
  handicap_value INTEGER;
  inserted_count INTEGER := 0;
  affected INTEGER;
  roster_count INTEGER;
  distinct_entry_count INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- Shared lock with publish_week: submission and publishing serialize.
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;
  IF event_row.status <> 'open' THEN RAISE EXCEPTION 'This event is no longer open'; END IF;

  SELECT * INTO caller_player
    FROM public.players
   WHERE user_id = auth.uid() AND location_id = event_row.location_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'No player profile is linked to this account'; END IF;

  SELECT r.team_id INTO caller_team_id
    FROM public.roster_at r
   WHERE r.event_id = p_event_id AND r.player_id = caller_player.id;
  IF caller_team_id IS NULL THEN RAISE EXCEPTION 'You are not rostered for this event'; END IF;

  IF jsonb_typeof(p_entries) <> 'array' THEN RAISE EXCEPTION 'entries must be a JSON array'; END IF;
  SELECT count(*) INTO roster_count FROM public.roster_at
   WHERE event_id = p_event_id AND team_id = caller_team_id;
  SELECT count(DISTINCT value->>'player_id') INTO distinct_entry_count
    FROM jsonb_array_elements(p_entries);
  IF jsonb_array_length(p_entries) <> roster_count OR distinct_entry_count <> roster_count THEN
    RAISE EXCEPTION 'Submit exactly one score for each rostered teammate';
  END IF;

  SELECT c.* INTO course_row
    FROM public.courses c WHERE c.id = event_row.course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This event has no valid course'; END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_entries)
  LOOP
    SELECT p.* INTO entry_player
      FROM public.players p
      JOIN public.roster_at r ON r.player_id = p.id
     WHERE r.event_id = p_event_id
       AND r.team_id = caller_team_id
       AND p.id = (entry->>'player_id')::uuid
       AND p.location_id = event_row.location_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'A submitted player is not on your event roster'; END IF;

    holes := entry->'hole_scores';
    IF NOT public.jsonb_int_array_valid(holes, course_row.num_holes, 1, 20) THEN
      RAISE EXCEPTION 'Scores must include % holes with values from 1 to 20', course_row.num_holes;
    END IF;
    -- live schema stores hole_scores as integer[]
    holes_int := ARRAY(SELECT elem::integer FROM jsonb_array_elements_text(holes) AS t(elem));
    gross := public.jsonb_int_array_sum(holes);
    handicap_value := round(COALESCE(entry_player.handicap, 0))::integer;

    -- Phase 4: optional per-hole stats, always skippable.
    stats := CASE WHEN jsonb_typeof(entry->'hole_stats') = 'array' THEN entry->'hole_stats' ELSE NULL END;
    IF stats IS NOT NULL THEN
      IF jsonb_array_length(stats) <> course_row.num_holes OR NOT public.hole_stats_valid(stats) THEN
        RAISE EXCEPTION 'hole_stats must be % per-hole objects with putts/fir/gir/penalties', course_row.num_holes;
      END IF;
    END IF;

    INSERT INTO public.scores (
      event_id, player_id, team_id, hole_scores, hole_stats, gross_total, net_total,
      handicap_used, sub_played, entry_type, status, location_id
    ) VALUES (
      p_event_id, entry_player.id, caller_team_id, holes_int, stats, gross,
      gross - handicap_value, handicap_value, false, 'played', 'pending',
      event_row.location_id
    )
    ON CONFLICT (event_id, player_id, entry_type) WHERE status <> 'rejected'
    DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT;
    inserted_count := inserted_count + affected;
  END LOOP;

  IF inserted_count > 0 THEN
    PERFORM public.write_audit_event(
      event_row.location_id, 'score.submit', 'events', p_event_id, NULL,
      jsonb_build_object(
        'team_id', caller_team_id,
        'submitted_player_ids', (
          SELECT jsonb_agg(value->>'player_id') FROM jsonb_array_elements(p_entries)
        ),
        'status', 'pending'
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'inserted', inserted_count,
    'already_submitted', inserted_count = 0,
    'status', 'pending'
  );
END;
$$;

-- ── recalculate_player_handicap: record history (body from 3.5 + insert) ─────
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
  -- Phase 4: feed the profile handicap graph.
  INSERT INTO public.handicap_history (player_id, handicap, scores_used, location_id)
  VALUES (p_player_id, new_handicap, cardinality(used_diffs), player_row.location_id);
  PERFORM public.write_audit_event(
    player_row.location_id, 'handicap.recalculate', 'players', p_player_id,
    jsonb_build_object('handicap', player_row.handicap),
    jsonb_build_object('handicap', new_handicap, 'scores_used', cardinality(used_diffs))
  );
  RETURN jsonb_build_object('updated', true, 'oldHcp', player_row.handicap, 'newHcp', new_handicap);
END;
$$;

COMMIT;

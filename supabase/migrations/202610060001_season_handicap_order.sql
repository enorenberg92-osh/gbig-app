-- Week numbers restart at session rollover; use actual play dates for recent history.
BEGIN;
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

  SELECT array_agg(diff ORDER BY played_date, week_number, created_at)
    INTO diffs
    FROM (
      SELECT s.gross_total - c.total_par AS diff, e.week_number, COALESCE(e.start_date, e.event_date, s.created_at::date) AS played_date, s.created_at
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
       ORDER BY COALESCE(e.start_date, e.event_date, s.created_at::date) DESC, e.week_number DESC NULLS LAST, s.created_at DESC, s.id DESC
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

BEGIN;

ALTER TABLE public.league_config ADD COLUMN IF NOT EXISTS min_handicap INTEGER NOT NULL DEFAULT -2
  CONSTRAINT league_min_handicap_range CHECK (min_handicap BETWEEN -2 AND 27);

-- Runs before scores_validate_payload. Cap only newly entered/corrected cards,
-- preserving historical cards during unrelated status/handicap updates.
CREATE OR REPLACE FUNCTION public.cap_score_double_par()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  course_row public.courses%ROWTYPE;
  capped INTEGER[];
BEGIN
  IF NEW.entry_type <> 'played' THEN RETURN NEW; END IF;
  SELECT c.* INTO course_row FROM public.events e
    JOIN public.courses c ON c.id = e.course_id WHERE e.id = NEW.event_id;
  IF NOT FOUND OR NOT public.jsonb_int_array_valid(course_row.hole_pars, course_row.num_holes, 3, 6) THEN
    RAISE EXCEPTION 'Played scores require a course with complete valid hole pars';
  END IF;
  -- Leave malformed cards to the existing validator; never turn bad data into a card.
  IF NOT public.int_array_valid(NEW.hole_scores, course_row.num_holes, 1, 20) THEN RETURN NEW; END IF;
  SELECT array_agg(least(value, (course_row.hole_pars->>(ordinality::integer - 1))::integer * 2) ORDER BY ordinality)
    INTO capped FROM unnest(NEW.hole_scores) WITH ORDINALITY AS h(value, ordinality);
  IF capped IS DISTINCT FROM NEW.hole_scores THEN
    NEW.hole_scores := capped;
    NEW.gross_total := public.int_array_sum(capped);
    NEW.net_total := NEW.gross_total - NEW.handicap_used;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS scores_cap_double_par ON public.scores;
CREATE TRIGGER scores_cap_double_par BEFORE INSERT OR UPDATE OF hole_scores ON public.scores
  FOR EACH ROW EXECUTE FUNCTION public.cap_score_double_par();
REVOKE ALL ON FUNCTION public.cap_score_double_par() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.apply_player_handicap(p_player_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  player_row public.players%ROWTYPE;
  score_limit INTEGER;
  minimum_handicap INTEGER;
  seed INTEGER;
  diffs NUMERIC[];
  sorted_diffs NUMERIC[];
  n INTEGER;
  used_diffs NUMERIC[];
  new_handicap INTEGER;
BEGIN
  SELECT * INTO player_row FROM public.players WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not found'; END IF;
  IF COALESCE(player_row.handicap_locked, false) THEN RETURN jsonb_build_object('skipped', true, 'reason', 'locked'); END IF;
  SELECT COALESCE(num_weeks, 12), COALESCE(min_handicap, -2) INTO score_limit, minimum_handicap FROM public.league_config
   WHERE location_id = player_row.location_id AND is_working ORDER BY id LIMIT 1;
  score_limit := COALESCE(score_limit, 12);
  minimum_handicap := COALESCE(minimum_handicap, -2);
  seed := COALESCE(player_row.starting_handicap, round(player_row.handicap)::integer);

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

  IF diffs IS NULL THEN
    new_handicap := CASE WHEN seed IS NULL THEN NULL ELSE greatest(minimum_handicap, seed) END;
  ELSE
    IF seed IS NOT NULL AND cardinality(diffs) < score_limit THEN
      diffs := array_prepend(seed::numeric, diffs);
    END IF;
    SELECT array_agg(value ORDER BY value) INTO sorted_diffs FROM unnest(diffs) value;
    n := cardinality(sorted_diffs);
    -- Discards: 4 values drop 1 high; 5+ drop 1 high and 1 low.
    used_diffs := sorted_diffs[(1 + CASE WHEN n >= 5 THEN 1 ELSE 0 END):(n - CASE WHEN n >= 4 THEN 1 ELSE 0 END)];
    SELECT greatest(minimum_handicap, least(27, floor(avg(value) * 0.90)::integer)) INTO new_handicap FROM unnest(used_diffs) value;
  END IF;

  IF new_handicap IS NULL OR new_handicap = player_row.handicap THEN
    RETURN jsonb_build_object('skipped', true, 'newHcp', new_handicap);
  END IF;
  PERFORM set_config('app.player_write', 'on', true);
  UPDATE public.players SET handicap = new_handicap WHERE id = p_player_id;
  INSERT INTO public.handicap_history (player_id, handicap, scores_used, location_id)
  VALUES (p_player_id, new_handicap, COALESCE(cardinality(used_diffs), 0), player_row.location_id);
  PERFORM public.write_audit_event(
    player_row.location_id, 'handicap.recalculate', 'players', p_player_id,
    jsonb_build_object('handicap', player_row.handicap),
    jsonb_build_object('handicap', new_handicap, 'registered', seed, 'scores_used', COALESCE(cardinality(used_diffs), 0))
  );
  RETURN jsonb_build_object('updated', true, 'oldHcp', player_row.handicap, 'newHcp', new_handicap);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_min_handicap(p_league_id UUID, p_min_handicap INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  league_row public.league_config%ROWTYPE;
  player_id UUID;
BEGIN
  SELECT * INTO league_row FROM public.league_config WHERE id = p_league_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(league_row.location_id);
  IF p_min_handicap IS NULL OR p_min_handicap < -2 OR p_min_handicap > 27 THEN
    RAISE EXCEPTION 'Minimum handicap must be a whole number from -2 to 27';
  END IF;
  UPDATE public.league_config SET min_handicap = p_min_handicap WHERE id = p_league_id;
  PERFORM public.write_audit_event(league_row.location_id, 'league.min_handicap', 'league_config', p_league_id,
    jsonb_build_object('min_handicap', league_row.min_handicap), jsonb_build_object('min_handicap', p_min_handicap));
  IF league_row.is_working THEN
    FOR player_id IN SELECT id FROM public.players WHERE location_id = league_row.location_id ORDER BY id LOOP
      PERFORM public.apply_player_handicap(player_id);
    END LOOP;
  END IF;
  RETURN jsonb_build_object('min_handicap', p_min_handicap);
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_min_handicap(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_min_handicap(UUID, INTEGER) TO authenticated;
-- Keep the internal calculation callable only through the existing authorized RPCs.
REVOKE ALL ON FUNCTION public.apply_player_handicap(UUID) FROM PUBLIC, anon, authenticated;

COMMIT;

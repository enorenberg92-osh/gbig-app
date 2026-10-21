-- League rulings (2026-10-21):
--  1. A player-submitted score is official immediately (no admin approval) and
--     the player's handicap recalculates in the same transaction.
--  2. The registered handicap (players.starting_handicap) counts as the oldest
--     "round" in the handicap average until a full window of real rounds
--     exists. Example: registered 4, shoots +8 -> avg(4, 8) = 6 x 90% = 5.4 -> 5.
--     No rounds yet -> play off the registered handicap as-is.
--  3. Admins can override the handicap a round was played off. That rewrites
--     the round's net (gross is never touched) and becomes the player's new
--     registered handicap.
BEGIN;

SELECT set_config('app.player_write', 'on', true);

-- ── Registered handicap ────────────────────────────────────────────────────
-- Legacy starting_handicap defaulted to 18 and was never maintained. Backfill
-- with the handicap each player actually started the season on: the handicap
-- stamped on their first own round, else their current handicap.
ALTER TABLE public.players ALTER COLUMN starting_handicap DROP DEFAULT;
UPDATE public.players p
   SET starting_handicap = COALESCE((
     SELECT s.handicap_used
       FROM public.scores s
       JOIN public.events e ON e.id = s.event_id
      WHERE s.player_id = p.id
        AND s.entry_type = 'played'
        AND NOT COALESCE(s.sub_played, false)
      ORDER BY COALESCE(e.start_date, e.event_date, s.created_at::date), s.created_at
      LIMIT 1
   ), round(p.handicap)::integer);

CREATE OR REPLACE FUNCTION public.players_default_registered_handicap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.starting_handicap := COALESCE(NEW.starting_handicap, round(NEW.handicap)::integer);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS players_default_registered_handicap ON public.players;
CREATE TRIGGER players_default_registered_handicap BEFORE INSERT ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.players_default_registered_handicap();

-- Players must not edit their own registered handicap through profile RLS.
CREATE OR REPLACE FUNCTION public.guard_player_profile_updates()
RETURNS trigger
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
     OR NEW.starting_handicap IS DISTINCT FROM OLD.starting_handicap
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

-- ── Handicap engine ────────────────────────────────────────────────────────
-- Internal: no permission check. Callers (admin RPCs, submit_scores) gate it.
CREATE OR REPLACE FUNCTION public.apply_player_handicap(p_player_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  player_row public.players%ROWTYPE;
  score_limit INTEGER;
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
  SELECT COALESCE(num_weeks, 12) INTO score_limit FROM public.league_config
   WHERE location_id = player_row.location_id AND is_working ORDER BY id LIMIT 1;
  score_limit := COALESCE(score_limit, 12);
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
    new_handicap := seed;
  ELSE
    IF seed IS NOT NULL AND cardinality(diffs) < score_limit THEN
      diffs := array_prepend(seed::numeric, diffs);
    END IF;
    SELECT array_agg(value ORDER BY value) INTO sorted_diffs FROM unnest(diffs) value;
    n := cardinality(sorted_diffs);
    -- Discards: 4 values drop 1 high; 5+ drop 1 high and 1 low.
    used_diffs := sorted_diffs[(1 + CASE WHEN n >= 5 THEN 1 ELSE 0 END):(n - CASE WHEN n >= 4 THEN 1 ELSE 0 END)];
    SELECT greatest(-2, least(27, floor(avg(value) * 0.90)::integer)) INTO new_handicap FROM unnest(used_diffs) value;
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

CREATE OR REPLACE FUNCTION public.recalculate_player_handicap(p_player_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE player_location UUID;
BEGIN
  SELECT location_id INTO player_location FROM public.players WHERE id = p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not found'; END IF;
  PERFORM public.require_location_admin(player_location);
  RETURN public.apply_player_handicap(p_player_id);
END;
$$;

-- ── Scores are official on submit ──────────────────────────────────────────
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

  IF jsonb_typeof(p_entries) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'entries must be a JSON array'; END IF;
  SELECT count(*) INTO roster_count FROM public.roster_at
   WHERE event_id = p_event_id AND team_id = caller_team_id;
  SELECT count(DISTINCT (value->>'player_id')::uuid) INTO distinct_entry_count
    FROM jsonb_array_elements(p_entries);
  -- A nonempty subset lets partners play separately. Every supplied card must
  -- still be complete, unique, and on the caller's dated roster.
  IF jsonb_array_length(p_entries) < 1 OR jsonb_array_length(p_entries) > roster_count
     OR distinct_entry_count <> jsonb_array_length(p_entries) THEN
    RAISE EXCEPTION 'Submit one complete scorecard per selected teammate, without duplicates';
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
      gross - handicap_value, handicap_value, false, 'played', 'verified',
      event_row.location_id
    )
    ON CONFLICT (event_id, player_id, entry_type) WHERE status <> 'rejected'
    DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT;
    inserted_count := inserted_count + affected;
    -- The round is stamped with the pre-round handicap above; the new
    -- handicap applies from next week.
    IF affected > 0 THEN PERFORM public.apply_player_handicap(entry_player.id); END IF;
  END LOOP;

  IF inserted_count > 0 THEN
    PERFORM public.write_audit_event(
      event_row.location_id, 'score.submit', 'events', p_event_id, NULL,
      jsonb_build_object(
        'team_id', caller_team_id,
        'submitted_player_ids', (
          SELECT jsonb_agg(value->>'player_id') FROM jsonb_array_elements(p_entries)
        ),
        'status', 'verified'
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'inserted', inserted_count,
    'already_submitted', inserted_count = 0,
    'status', 'verified'
  );
END;
$$;

-- ── Per-round handicap override ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_override_score_handicap(p_score_id UUID, p_handicap INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  score_row public.scores%ROWTYPE;
  event_row public.events%ROWTYPE;
  player_row public.players%ROWTYPE;
  clamped INTEGER;
  after_row JSONB;
BEGIN
  IF p_handicap IS NULL THEN RAISE EXCEPTION 'Enter an override handicap'; END IF;
  SELECT * INTO score_row FROM public.scores WHERE id = p_score_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Score not found'; END IF;
  -- Same lock order as submit/publish: event, then score, then player.
  SELECT * INTO event_row FROM public.events WHERE id = score_row.event_id FOR UPDATE;
  PERFORM public.require_location_admin(score_row.location_id);
  SELECT * INTO score_row FROM public.scores WHERE id = p_score_id FOR UPDATE;
  IF score_row.entry_type <> 'played' OR score_row.status <> 'verified' OR score_row.gross_total IS NULL THEN
    RAISE EXCEPTION 'Only played rounds can have their handicap overridden';
  END IF;
  SELECT * INTO player_row FROM public.players WHERE id = score_row.player_id FOR UPDATE;
  clamped := greatest(-2, least(CASE WHEN COALESCE(player_row.is_sub, false) THEN 40 ELSE 27 END, p_handicap));

  UPDATE public.scores
     SET handicap_used = clamped, net_total = gross_total - clamped
   WHERE id = p_score_id
  RETURNING to_jsonb(scores) INTO after_row;

  -- A sub_played row carries the sub's gross, not this player's golf, so it
  -- must not move this player's registered handicap.
  IF NOT COALESCE(score_row.sub_played, false) THEN
    PERFORM set_config('app.player_write', 'on', true);
    UPDATE public.players SET starting_handicap = clamped WHERE id = player_row.id;
    PERFORM public.apply_player_handicap(player_row.id);
  END IF;

  PERFORM public.write_audit_event(
    score_row.location_id, 'score.handicap_override', 'scores', p_score_id,
    jsonb_build_object('handicap_used', score_row.handicap_used, 'net_total', score_row.net_total,
                       'registered', player_row.starting_handicap),
    jsonb_build_object('handicap_used', clamped, 'net_total', score_row.gross_total - clamped,
                       'registered', CASE WHEN COALESCE(score_row.sub_played, false) THEN player_row.starting_handicap ELSE clamped END)
  );

  IF event_row.status = 'closed' THEN
    PERFORM public.compute_event_results(event_row.id);
  END IF;
  RETURN after_row;
END;
$$;

-- ── Admin handicap edits set the registered handicap ───────────────────────
CREATE OR REPLACE FUNCTION public.admin_update_player(p_player_id UUID, p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  player_row public.players%ROWTYPE;
  registered INTEGER;
  new_registered INTEGER;
  after_row JSONB;
BEGIN
  SELECT * INTO player_row FROM public.players WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not found'; END IF;
  PERFORM public.require_location_admin(player_row.location_id);
  registered := COALESCE(player_row.starting_handicap, round(COALESCE(player_row.handicap, 0))::integer);
  new_registered := greatest(-2, least(
    CASE WHEN COALESCE(player_row.is_sub, false) THEN 40 ELSE 27 END,
    COALESCE(round(NULLIF(p_payload->>'handicap', '')::numeric)::integer, registered)
  ));
  PERFORM set_config('app.player_write', 'on', true);
  UPDATE public.players SET
    name = COALESCE(NULLIF(trim(p_payload->>'name'), ''), name),
    email = CASE WHEN p_payload ? 'email' THEN NULLIF(lower(trim(p_payload->>'email')), '') ELSE email END,
    starting_handicap = new_registered,
    handicap = CASE WHEN new_registered IS DISTINCT FROM registered THEN new_registered ELSE handicap END,
    in_skins = COALESCE((p_payload->>'in_skins')::boolean, in_skins),
    handicap_locked = COALESCE((p_payload->>'handicap_locked')::boolean, handicap_locked),
    league_password = COALESCE(NULLIF(p_payload->>'league_password', ''), league_password)
  WHERE id = p_player_id;
  IF new_registered IS DISTINCT FROM registered THEN
    PERFORM public.apply_player_handicap(p_player_id);
  END IF;
  SELECT to_jsonb(p) INTO after_row FROM public.players p WHERE p.id = p_player_id;
  PERFORM public.write_audit_event(
    player_row.location_id, 'player.update', 'players', p_player_id,
    to_jsonb(player_row), after_row
  );
  RETURN after_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_player_handicap(p_player_id UUID, p_handicap INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE player_row public.players%ROWTYPE; clamped INTEGER; result_handicap INTEGER;
BEGIN
  SELECT * INTO player_row FROM public.players WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not found'; END IF;
  PERFORM public.require_location_admin(player_row.location_id);
  clamped := greatest(-2, least(CASE WHEN COALESCE(player_row.is_sub, false) THEN 40 ELSE 27 END, p_handicap));
  PERFORM set_config('app.player_write', 'on', true);
  UPDATE public.players SET handicap = clamped, starting_handicap = clamped WHERE id = p_player_id;
  PERFORM public.apply_player_handicap(p_player_id);
  SELECT round(handicap)::integer INTO result_handicap FROM public.players WHERE id = p_player_id;
  PERFORM public.write_audit_event(
    player_row.location_id, 'handicap.override', 'players', p_player_id,
    jsonb_build_object('handicap', player_row.handicap, 'registered', player_row.starting_handicap),
    jsonb_build_object('handicap', result_handicap, 'registered', clamped)
  );
  RETURN result_handicap;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_player_handicap(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.players_default_registered_handicap() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_override_score_handicap(UUID, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_override_score_handicap(UUID, INTEGER) TO authenticated;
REVOKE ALL ON FUNCTION public.submit_scores(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_scores(UUID, JSONB) TO authenticated;

-- ── One-time: clear the old review queue and re-rate everyone ──────────────
DO $$
DECLARE ev RECORD; pid UUID;
BEGIN
  FOR ev IN
    WITH approved AS (
      UPDATE public.scores SET status = 'verified' WHERE status = 'pending'
      RETURNING id, event_id, location_id
    )
    SELECT event_id, location_id, jsonb_agg(id) AS ids FROM approved GROUP BY event_id, location_id
  LOOP
    PERFORM public.write_audit_event(ev.location_id, 'score.bulk_approve', 'events', ev.event_id, NULL,
      jsonb_build_object('score_ids', ev.ids, 'reason', 'scores official on submit'));
  END LOOP;
  FOR pid IN SELECT id FROM public.players WHERE NOT COALESCE(handicap_locked, false) LOOP
    PERFORM public.apply_player_handicap(pid);
  END LOOP;
END $$;

COMMIT;

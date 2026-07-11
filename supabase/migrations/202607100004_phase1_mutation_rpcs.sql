-- Phase 1 / apply fourth: transactional, server-authoritative mutation paths.
-- Every callable function follows the fixed-search_path / auth.uid() / explicit
-- admin-check hardening template. Location and player identity are never trusted
-- from client arguments.

CREATE OR REPLACE FUNCTION public.require_location_admin(p_location_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_admin_of_location(p_location_id) THEN
    RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501';
  END IF;
END;
$$;

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

    INSERT INTO public.scores (
      event_id, player_id, team_id, hole_scores, gross_total, net_total,
      handicap_used, sub_played, entry_type, status, location_id
    ) VALUES (
      p_event_id, entry_player.id, caller_team_id, holes_int, gross,
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

CREATE OR REPLACE FUNCTION public.admin_upsert_score(p_event_id UUID, p_entries JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  course_row public.courses%ROWTYPE;
  entry JSONB;
  target_player public.players%ROWTYPE;
  before_row JSONB;
  after_row JSONB;
  holes JSONB;
  holes_int INTEGER[];
  gross INTEGER;
  handicap_value INTEGER;
  target_team_id UUID;
  changed_count INTEGER := 0;
  penalties_superseded INTEGER;
BEGIN
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;
  PERFORM public.require_location_admin(event_row.location_id);
  -- Closed weeks stay editable by admins: life happens and scores get fixed
  -- late. The event itself never reopens; every correction is audited and any
  -- missed-week penalty for the corrected player is superseded below.
  IF jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) = 0 THEN
    RAISE EXCEPTION 'entries must be a non-empty JSON array';
  END IF;

  SELECT * INTO course_row FROM public.courses WHERE id = event_row.course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This event has no valid course'; END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_entries)
  LOOP
    SELECT * INTO target_player FROM public.players
     WHERE id = (entry->>'player_id')::uuid
       AND location_id = event_row.location_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Player is not in the event location'; END IF;

    holes := entry->'hole_scores';
    IF NOT public.jsonb_int_array_valid(holes, course_row.num_holes, 1, 20) THEN
      RAISE EXCEPTION 'Scores must include % holes with values from 1 to 20', course_row.num_holes;
    END IF;
    -- live schema stores hole_scores as integer[]
    holes_int := ARRAY(SELECT elem::integer FROM jsonb_array_elements_text(holes) AS t(elem));
    gross := public.jsonb_int_array_sum(holes);
    handicap_value := COALESCE(
      NULLIF(entry->>'handicap_used', '')::integer,
      round(COALESCE(target_player.handicap, 0))::integer
    );
    SELECT r.team_id INTO target_team_id FROM public.roster_at r
     WHERE r.event_id = p_event_id AND r.player_id = target_player.id;

    SELECT to_jsonb(s) INTO before_row FROM public.scores s
     WHERE s.event_id = p_event_id
       AND s.player_id = target_player.id
       AND s.entry_type = 'played'
       AND s.status <> 'rejected';

    INSERT INTO public.scores (
      event_id, player_id, team_id, hole_scores, gross_total, net_total,
      handicap_used, sub_played, entry_type, status, location_id
    ) VALUES (
      p_event_id, target_player.id, target_team_id, holes_int, gross,
      gross - handicap_value, handicap_value,
      COALESCE((entry->>'sub_played')::boolean, false),
      'played', 'verified', event_row.location_id
    )
    ON CONFLICT (event_id, player_id, entry_type) WHERE status <> 'rejected'
    DO UPDATE SET
      team_id = EXCLUDED.team_id,
      hole_scores = EXCLUDED.hole_scores,
      gross_total = EXCLUDED.gross_total,
      net_total = EXCLUDED.net_total,
      handicap_used = EXCLUDED.handicap_used,
      sub_played = EXCLUDED.sub_played,
      status = 'verified';

    SELECT to_jsonb(s) INTO after_row FROM public.scores s
     WHERE s.event_id = p_event_id
       AND s.player_id = target_player.id
       AND s.entry_type = 'played'
       AND s.status <> 'rejected';

    -- A late-entered real score supersedes any missed-week penalty this
    -- player received when the week was published (mirrors publish_week).
    DELETE FROM public.scores penalty
     WHERE penalty.event_id = p_event_id
       AND penalty.player_id = target_player.id
       AND penalty.entry_type = 'missed_penalty';
    GET DIAGNOSTICS penalties_superseded = ROW_COUNT;

    PERFORM public.write_audit_event(
      event_row.location_id, 'score.admin_upsert', 'scores',
      (after_row->>'id')::uuid, before_row,
      after_row || jsonb_build_object(
        'event_status', event_row.status,
        'penalty_superseded', penalties_superseded > 0
      )
    );
    changed_count := changed_count + 1;
  END LOOP;

  RETURN jsonb_build_object('updated', changed_count, 'status', 'verified');
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_review_score(p_score_id UUID, p_status TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  score_row public.scores%ROWTYPE;
  before_row JSONB;
  after_row JSONB;
BEGIN
  IF p_status NOT IN ('verified', 'rejected') THEN
    RAISE EXCEPTION 'Review status must be verified or rejected';
  END IF;
  SELECT * INTO score_row FROM public.scores WHERE id = p_score_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Score not found'; END IF;
  PERFORM public.require_location_admin(score_row.location_id);
  before_row := to_jsonb(score_row);
  UPDATE public.scores SET status = p_status WHERE id = p_score_id RETURNING to_jsonb(scores) INTO after_row;
  PERFORM public.write_audit_event(
    score_row.location_id,
    CASE WHEN p_status = 'verified' THEN 'score.approve' ELSE 'score.reject' END,
    'scores', p_score_id, before_row, after_row
  );
  RETURN after_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_score(p_score_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  score_row public.scores%ROWTYPE;
BEGIN
  SELECT * INTO score_row FROM public.scores WHERE id = p_score_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.require_location_admin(score_row.location_id);
  DELETE FROM public.scores WHERE id = p_score_id;
  PERFORM public.write_audit_event(
    score_row.location_id, 'score.delete', 'scores', p_score_id,
    to_jsonb(score_row), NULL
  );
  RETURN true;
END;
$$;

-- Phase 1 stroke-play stub. Phase 3 replaces this function body with the
-- versioned format engine's explicit no-show outcome writer.
CREATE OR REPLACE FUNCTION public.phase1_apply_no_show_policy(
  p_event_id UUID,
  p_player_id UUID,
  p_score_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'version', 1,
    'policy', 'stroke_net_penalty',
    'event_id', p_event_id,
    'player_id', p_player_id,
    'score_id', p_score_id
  );
$$;

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
      'next_event_id', next_event_id
    )
  );
  RETURN jsonb_build_object(
    'published', true,
    'already_closed', false,
    'penalties_added', penalties_added,
    'next_event_id', next_event_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.request_sub(p_event_id UUID, p_sub JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  player_row public.players%ROWTYPE;
  request_id UUID;
  handicap_value INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id AND status = 'open';
  IF NOT FOUND THEN RAISE EXCEPTION 'Sub requests require an open event'; END IF;
  SELECT * INTO player_row FROM public.players
   WHERE user_id = auth.uid() AND location_id = event_row.location_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'No player profile is linked to this account'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.roster_at WHERE event_id = p_event_id AND player_id = player_row.id) THEN
    RAISE EXCEPTION 'You are not rostered for this event';
  END IF;
  handicap_value := greatest(-2, least(27, round((p_sub->>'sub_handicap')::numeric)::integer));
  INSERT INTO public.subs (
    event_id, player_id, sub_first_name, sub_last_name, sub_email, sub_phone,
    sub_handicap, sub_player_id, status, location_id
  ) VALUES (
    p_event_id, player_row.id, trim(p_sub->>'sub_first_name'), trim(p_sub->>'sub_last_name'),
    NULLIF(trim(p_sub->>'sub_email'), ''), NULLIF(trim(p_sub->>'sub_phone'), ''),
    handicap_value, NULLIF(p_sub->>'sub_player_id', '')::uuid, 'pending', event_row.location_id
  ) RETURNING id INTO request_id;
  PERFORM public.write_audit_event(
    event_row.location_id, 'sub.request', 'subs', request_id, NULL,
    jsonb_build_object('event_id', p_event_id, 'player_id', player_row.id, 'status', 'pending')
  );
  RETURN request_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_sub_status(p_sub_id UUID, p_status TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  sub_row public.subs%ROWTYPE;
  profile_id UUID;
  before_row JSONB;
BEGIN
  IF p_status NOT IN ('approved', 'denied') THEN RAISE EXCEPTION 'Invalid sub status'; END IF;
  SELECT * INTO sub_row FROM public.subs WHERE id = p_sub_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sub request not found'; END IF;
  PERFORM public.require_location_admin(sub_row.location_id);
  before_row := to_jsonb(sub_row);

  profile_id := sub_row.sub_player_id;
  IF p_status = 'approved' THEN
    IF profile_id IS NULL THEN
      SELECT id INTO profile_id FROM public.players
       WHERE location_id = sub_row.location_id
         AND is_sub = true
         AND first_name = trim(sub_row.sub_first_name)
         AND last_name = trim(sub_row.sub_last_name)
       ORDER BY id LIMIT 1;
    END IF;
    IF profile_id IS NULL THEN
      INSERT INTO public.players (
        first_name, last_name, name, handicap, email, is_sub, location_id
      ) VALUES (
        trim(sub_row.sub_first_name), trim(sub_row.sub_last_name),
        trim(sub_row.sub_first_name || ' ' || sub_row.sub_last_name),
        greatest(-2, least(40, round(COALESCE(sub_row.sub_handicap, 0))::integer)),
        sub_row.sub_email, true, sub_row.location_id
      ) RETURNING id INTO profile_id;
    ELSE
      PERFORM set_config('app.player_write', 'on', true);
      UPDATE public.players
         SET handicap = greatest(-2, least(40, round(COALESCE(sub_row.sub_handicap, 0))::integer)),
             is_sub = true
       WHERE id = profile_id AND location_id = sub_row.location_id;
    END IF;
  END IF;

  UPDATE public.subs
     SET status = p_status,
         sub_player_id = CASE WHEN p_status = 'approved' THEN profile_id ELSE sub_player_id END
   WHERE id = p_sub_id;
  PERFORM public.write_audit_event(
    sub_row.location_id, 'sub.' || p_status, 'subs', p_sub_id, before_row,
    jsonb_build_object('status', p_status, 'sub_player_id', profile_id)
  );
  RETURN jsonb_build_object('status', p_status, 'sub_player_id', profile_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_sub(p_sub_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE sub_row public.subs%ROWTYPE;
BEGIN
  SELECT * INTO sub_row FROM public.subs WHERE id = p_sub_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.require_location_admin(sub_row.location_id);
  DELETE FROM public.subs WHERE id = p_sub_id;
  PERFORM public.write_audit_event(sub_row.location_id, 'sub.delete', 'subs', p_sub_id, to_jsonb(sub_row), NULL);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_save_team(
  p_team_id UUID,
  p_league_id UUID,
  p_name TEXT,
  p_player_ids JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  league_row public.league_config%ROWTYPE;
  team_id_value UUID;
  player_one UUID;
  player_two UUID;
  before_row JSONB;
BEGIN
  SELECT * INTO league_row FROM public.league_config WHERE id = p_league_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(league_row.location_id);
  IF jsonb_typeof(p_player_ids) <> 'array' OR jsonb_array_length(p_player_ids) <> 2 THEN
    RAISE EXCEPTION 'A team requires exactly two players';
  END IF;
  player_one := (p_player_ids->>0)::uuid;
  player_two := (p_player_ids->>1)::uuid;
  IF player_one = player_two THEN RAISE EXCEPTION 'Team players must be different'; END IF;
  IF (SELECT count(*) FROM public.players WHERE id IN (player_one, player_two) AND location_id = league_row.location_id) <> 2 THEN
    RAISE EXCEPTION 'Both players must belong to the league location';
  END IF;

  PERFORM set_config('app.roster_write', 'on', true);
  IF p_team_id IS NULL THEN
    INSERT INTO public.teams (
      name, player1_id, player2_id, league_id, location_id
    ) VALUES (
      trim(p_name), player_one, player_two, p_league_id, league_row.location_id
    ) RETURNING id INTO team_id_value;
  ELSE
    SELECT to_jsonb(t) INTO before_row FROM public.teams t
     WHERE id = p_team_id AND location_id = league_row.location_id AND league_id = p_league_id FOR UPDATE;
    IF before_row IS NULL THEN RAISE EXCEPTION 'Team not found in league'; END IF;
    team_id_value := p_team_id;
    UPDATE public.teams SET name = trim(p_name), player1_id = player_one, player2_id = player_two
     WHERE id = team_id_value;
    DELETE FROM public.team_memberships WHERE team_id = team_id_value AND effective_to IS NULL;
  END IF;

  -- A current-roster edit corrects the league roster from its start. Phase 5
  -- adds the explicit mid-season effective-date swap UI.
  INSERT INTO public.team_memberships (
    location_id, league_id, player_id, team_id, effective_from
  ) VALUES
    (league_row.location_id, p_league_id, player_one, team_id_value, COALESCE(league_row.start_date, DATE '1900-01-01')),
    (league_row.location_id, p_league_id, player_two, team_id_value, COALESCE(league_row.start_date, DATE '1900-01-01'));
  UPDATE public.players SET team_id = team_id_value WHERE id IN (player_one, player_two);

  PERFORM public.write_audit_event(
    league_row.location_id,
    CASE WHEN p_team_id IS NULL THEN 'roster.team_create' ELSE 'roster.team_update' END,
    'teams', team_id_value, before_row,
    jsonb_build_object('name', trim(p_name), 'league_id', p_league_id, 'player_ids', p_player_ids)
  );
  RETURN team_id_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_team(p_team_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE team_row public.teams%ROWTYPE;
BEGIN
  SELECT * INTO team_row FROM public.teams WHERE id = p_team_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.require_location_admin(team_row.location_id);
  PERFORM set_config('app.roster_write', 'on', true);
  UPDATE public.players SET team_id = NULL WHERE team_id = p_team_id;
  DELETE FROM public.teams WHERE id = p_team_id;
  PERFORM public.write_audit_event(team_row.location_id, 'roster.team_delete', 'teams', p_team_id, to_jsonb(team_row), NULL);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_upsert_event(p_event_id UUID, p_league_id UUID, p_payload JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  league_row public.league_config%ROWTYPE;
  event_id_value UUID;
  requested_status TEXT;
  before_row JSONB;
BEGIN
  SELECT * INTO league_row FROM public.league_config WHERE id = p_league_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(league_row.location_id);
  requested_status := COALESCE(NULLIF(p_payload->>'status', ''), 'draft');
  IF requested_status NOT IN ('draft', 'open', 'cancelled', 'closed') THEN RAISE EXCEPTION 'Invalid event status'; END IF;
  IF requested_status = 'closed' AND NOT COALESCE((p_payload->>'is_bye')::boolean, false) THEN
    RAISE EXCEPTION 'Only publish_week may close a playable event';
  END IF;

  IF p_event_id IS NULL THEN
    INSERT INTO public.events (
      name, start_date, end_date, status, notes, course_id, hole_event_hole,
      hole_event_name, is_bye, week_number, league_id, location_id
    ) VALUES (
      trim(p_payload->>'name'), NULLIF(p_payload->>'start_date', '')::date,
      NULLIF(p_payload->>'end_date', '')::date, requested_status,
      NULLIF(trim(p_payload->>'notes'), ''), NULLIF(p_payload->>'course_id', '')::uuid,
      NULLIF(p_payload->>'hole_event_hole', '')::integer,
      NULLIF(trim(p_payload->>'hole_event_name'), ''),
      COALESCE((p_payload->>'is_bye')::boolean, false),
      NULLIF(p_payload->>'week_number', '')::integer,
      p_league_id, league_row.location_id
    ) RETURNING id INTO event_id_value;
  ELSE
    SELECT to_jsonb(e) INTO before_row FROM public.events e
     WHERE id = p_event_id AND league_id = p_league_id AND location_id = league_row.location_id FOR UPDATE;
    IF before_row IS NULL THEN RAISE EXCEPTION 'Event not found in league'; END IF;
    IF before_row->>'status' = 'closed' AND requested_status <> 'closed' THEN
      RAISE EXCEPTION 'Published events are immutable';
    END IF;
    event_id_value := p_event_id;
    UPDATE public.events SET
      name = trim(p_payload->>'name'),
      start_date = NULLIF(p_payload->>'start_date', '')::date,
      end_date = NULLIF(p_payload->>'end_date', '')::date,
      status = requested_status,
      notes = NULLIF(trim(p_payload->>'notes'), ''),
      course_id = NULLIF(p_payload->>'course_id', '')::uuid,
      hole_event_hole = NULLIF(p_payload->>'hole_event_hole', '')::integer,
      hole_event_name = NULLIF(trim(p_payload->>'hole_event_name'), ''),
      is_bye = COALESCE((p_payload->>'is_bye')::boolean, false),
      week_number = COALESCE(NULLIF(p_payload->>'week_number', '')::integer, week_number)
    WHERE id = event_id_value;
  END IF;
  PERFORM public.write_audit_event(
    league_row.location_id,
    CASE WHEN p_event_id IS NULL THEN 'event.create' ELSE 'event.update' END,
    'events', event_id_value, before_row,
    (SELECT to_jsonb(e) FROM public.events e WHERE e.id = event_id_value)
  );
  RETURN event_id_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_generate_schedule(p_league_id UUID, p_weeks JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE league_row public.league_config%ROWTYPE; week JSONB; inserted_count INTEGER := 0; affected INTEGER;
BEGIN
  SELECT * INTO league_row FROM public.league_config WHERE id = p_league_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(league_row.location_id);
  IF jsonb_typeof(p_weeks) <> 'array' THEN RAISE EXCEPTION 'weeks must be an array'; END IF;
  FOR week IN SELECT value FROM jsonb_array_elements(p_weeks)
  LOOP
    INSERT INTO public.events (
      name, week_number, start_date, end_date, status, league_id, location_id, is_bye
    ) VALUES (
      COALESCE(NULLIF(week->>'name', ''), 'Week ' || (week->>'week_number')),
      (week->>'week_number')::integer, (week->>'start_date')::date,
      (week->>'end_date')::date, 'draft', p_league_id, league_row.location_id, false
    ) ON CONFLICT (location_id, league_id, week_number) DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT;
    inserted_count := inserted_count + affected;
  END LOOP;
  PERFORM public.write_audit_event(
    league_row.location_id, 'event.schedule_generate', 'league_config', p_league_id,
    NULL, jsonb_build_object('inserted', inserted_count, 'weeks', p_weeks)
  );
  RETURN inserted_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_event(p_event_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE event_row public.events%ROWTYPE;
BEGIN
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.require_location_admin(event_row.location_id);
  IF event_row.status = 'closed' THEN RAISE EXCEPTION 'Published events cannot be deleted'; END IF;
  DELETE FROM public.scores WHERE event_id = p_event_id;
  DELETE FROM public.events WHERE id = p_event_id;
  PERFORM public.write_audit_event(event_row.location_id, 'event.delete', 'events', p_event_id, to_jsonb(event_row), NULL);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_create_player(p_location_id UUID, p_payload JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  player_id_value UUID;
  is_sub_value BOOLEAN := COALESCE((p_payload->>'is_sub')::boolean, false);
  max_handicap INTEGER;
  clamped_handicap INTEGER;
BEGIN
  PERFORM public.require_location_admin(p_location_id);
  max_handicap := CASE WHEN is_sub_value THEN 40 ELSE 27 END;
  clamped_handicap := greatest(-2, least(
    max_handicap,
    COALESCE((p_payload->>'handicap')::integer, 0)
  ));

  INSERT INTO public.players (
    first_name, last_name, name, email, handicap, in_skins,
    handicap_locked, league_password, is_sub, location_id
  ) VALUES (
    NULLIF(trim(p_payload->>'first_name'), ''),
    NULLIF(trim(p_payload->>'last_name'), ''),
    COALESCE(
      NULLIF(trim(p_payload->>'name'), ''),
      NULLIF(trim((p_payload->>'first_name') || ' ' || (p_payload->>'last_name')), '')
    ),
    CASE WHEN p_payload ? 'email' THEN NULLIF(lower(trim(p_payload->>'email')), '') ELSE NULL END,
    clamped_handicap,
    COALESCE((p_payload->>'in_skins')::boolean, false),
    COALESCE((p_payload->>'handicap_locked')::boolean, false),
    COALESCE(NULLIF(p_payload->>'league_password', ''), 'password'),
    is_sub_value,
    p_location_id
  ) RETURNING id INTO player_id_value;

  PERFORM public.write_audit_event(
    p_location_id, 'player.create', 'players', player_id_value,
    NULL, jsonb_build_object('id', player_id_value, 'name', p_payload->>'name')
  );
  RETURN player_id_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_player_handicap(p_player_id UUID, p_handicap INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE player_row public.players%ROWTYPE; clamped INTEGER;
BEGIN
  SELECT * INTO player_row FROM public.players WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not found'; END IF;
  PERFORM public.require_location_admin(player_row.location_id);
  clamped := greatest(-2, least(CASE WHEN COALESCE(player_row.is_sub, false) THEN 40 ELSE 27 END, p_handicap));
  PERFORM set_config('app.player_write', 'on', true);
  UPDATE public.players SET handicap = clamped WHERE id = p_player_id;
  PERFORM public.write_audit_event(
    player_row.location_id, 'handicap.override', 'players', p_player_id,
    jsonb_build_object('handicap', player_row.handicap), jsonb_build_object('handicap', clamped)
  );
  RETURN clamped;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_player(p_player_id UUID, p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE player_row public.players%ROWTYPE; new_handicap INTEGER; after_row JSONB;
BEGIN
  SELECT * INTO player_row FROM public.players WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not found'; END IF;
  PERFORM public.require_location_admin(player_row.location_id);
  new_handicap := greatest(-2, least(
    CASE WHEN COALESCE(player_row.is_sub, false) THEN 40 ELSE 27 END,
    COALESCE((p_payload->>'handicap')::integer, round(COALESCE(player_row.handicap, 0))::integer)
  ));
  PERFORM set_config('app.player_write', 'on', true);
  UPDATE public.players SET
    name = COALESCE(NULLIF(trim(p_payload->>'name'), ''), name),
    email = CASE WHEN p_payload ? 'email' THEN NULLIF(lower(trim(p_payload->>'email')), '') ELSE email END,
    handicap = new_handicap,
    in_skins = COALESCE((p_payload->>'in_skins')::boolean, in_skins),
    handicap_locked = COALESCE((p_payload->>'handicap_locked')::boolean, handicap_locked),
    league_password = COALESCE(NULLIF(p_payload->>'league_password', ''), league_password)
  WHERE id = p_player_id
  RETURNING to_jsonb(players) INTO after_row;
  PERFORM public.write_audit_event(
    player_row.location_id, 'player.update', 'players', p_player_id,
    to_jsonb(player_row), after_row
  );
  RETURN after_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_player(p_player_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE player_row public.players%ROWTYPE; score_count INTEGER;
BEGIN
  SELECT * INTO player_row FROM public.players WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.require_location_admin(player_row.location_id);
  IF EXISTS (SELECT 1 FROM public.team_memberships WHERE player_id = p_player_id AND effective_to IS NULL) THEN
    RAISE EXCEPTION 'Remove or replace this player on their active team before deleting the profile';
  END IF;
  SELECT count(*) INTO score_count FROM public.scores WHERE player_id = p_player_id;
  DELETE FROM public.scores WHERE player_id = p_player_id;
  DELETE FROM public.subs WHERE player_id = p_player_id OR sub_player_id = p_player_id;
  DELETE FROM public.follows WHERE follower_id = p_player_id OR following_id = p_player_id;
  DELETE FROM public.messages WHERE sender_id = p_player_id OR recipient_id = p_player_id;
  DELETE FROM public.players WHERE id = p_player_id;
  PERFORM public.write_audit_event(
    player_row.location_id, 'player.delete', 'players', p_player_id, to_jsonb(player_row),
    jsonb_build_object('deleted', true, 'score_rows_deleted', score_count)
  );
  RETURN true;
END;
$$;

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

CREATE OR REPLACE FUNCTION public.recalculate_handicaps()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE admin_location UUID; player_id_value UUID; result JSONB; updated_count INTEGER := 0;
BEGIN
  SELECT location_id INTO admin_location FROM public.location_admins WHERE user_id = auth.uid() ORDER BY created_at LIMIT 1;
  IF admin_location IS NULL THEN RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501'; END IF;
  FOR player_id_value IN SELECT id FROM public.players WHERE location_id = admin_location AND NOT COALESCE(handicap_locked, false)
  LOOP
    result := public.recalculate_player_handicap(player_id_value);
    IF COALESCE((result->>'updated')::boolean, false) THEN updated_count := updated_count + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('updated', updated_count);
END;
$$;

-- No function is executable until its explicit authenticated grant below.
REVOKE ALL ON FUNCTION public.require_location_admin(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_scores(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_upsert_score(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_review_score(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_score(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.phase1_apply_no_show_policy(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_week(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.request_sub(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_set_sub_status(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_sub(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_save_team(UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_team(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_upsert_event(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_generate_schedule(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_event(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_create_player(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_set_player_handicap(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_update_player(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_player(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recalculate_player_handicap(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recalculate_handicaps() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.submit_scores(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_upsert_score(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_review_score(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_score(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.publish_week(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.request_sub(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_sub_status(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_sub(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_team(UUID, UUID, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_team(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_upsert_event(UUID, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_generate_schedule(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_event(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_create_player(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_player_handicap(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_player(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_player(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_player_handicap(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_handicaps() TO authenticated;

-- Validate score payloads deterministically; serialize review against publishing.
-- Closed-round admin corrections remain supported and now recompute format results.
-- No password/account changes. Apply through the normal migration process.
BEGIN;

CREATE OR REPLACE FUNCTION public.jsonb_int_array_valid(value JSONB, expected_length INTEGER, min_value INTEGER, max_value INTEGER)
RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE item JSONB;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'array' THEN RETURN false; END IF;
  IF expected_length IS NULL OR jsonb_array_length(value) <> expected_length THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
    IF jsonb_typeof(item) <> 'number' OR item::text !~ '^-?[0-9]+$' THEN RETURN false; END IF;
    IF (item::text)::numeric < min_value OR (item::text)::numeric > max_value THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
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
  parent_event_id UUID;
  parent_status TEXT;
  before_row JSONB;
  after_row JSONB;
BEGIN
  IF p_status NOT IN ('verified', 'rejected') THEN
    RAISE EXCEPTION 'Review status must be verified or rejected';
  END IF;
  SELECT event_id INTO parent_event_id FROM public.scores WHERE id = p_score_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Score not found'; END IF;
  SELECT status INTO parent_status FROM public.events WHERE id = parent_event_id FOR UPDATE;
  IF parent_status <> 'open' THEN RAISE EXCEPTION 'Review scores before closing the round. Use an audited score correction for a closed round.'; END IF;
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

  IF event_row.status = 'closed' THEN
    PERFORM public.compute_event_results(p_event_id);
  END IF;
  RETURN jsonb_build_object('updated', changed_count, 'status', 'verified');
END;
$$;

COMMIT;

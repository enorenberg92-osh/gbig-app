-- Allow partners to submit complete scorecards independently.
-- Preserve existing roster authorization, event lock, validation, pending review,
-- audit logging, and insert-only idempotency. No existing scores are changed.

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

REVOKE ALL ON FUNCTION public.submit_scores(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_scores(UUID, JSONB) TO authenticated;

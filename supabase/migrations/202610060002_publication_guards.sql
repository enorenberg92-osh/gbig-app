-- Guard publication at the database boundary and preserve finalized results.
BEGIN;
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
  penalty_par INTEGER;
  course_row public.courses%ROWTYPE;
BEGIN
  -- Same event-row lock as submit_scores.
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;
  PERFORM public.require_location_admin(event_row.location_id);

  IF event_row.status = 'closed' THEN
    RETURN jsonb_build_object('published', false, 'already_closed', true, 'next_event_id', NULL);
  END IF;
  IF event_row.status <> 'open' THEN RAISE EXCEPTION 'Only an open event can be published'; END IF;

  SELECT * INTO course_row FROM public.courses WHERE id=event_row.course_id AND location_id=event_row.location_id;
  IF NOT FOUND OR NOT public.jsonb_int_array_valid(course_row.hole_pars,course_row.num_holes,1,7)
     OR course_row.total_par IS DISTINCT FROM public.jsonb_int_array_sum(course_row.hole_pars) THEN
    RAISE EXCEPTION 'Assign a course with complete pars and matching total par before publishing';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.roster_at WHERE event_id=p_event_id)
     OR EXISTS(SELECT 1 FROM public.roster_at WHERE event_id=p_event_id GROUP BY team_id HAVING count(*)<>2 OR count(DISTINCT player_id)<>2)
     OR EXISTS(SELECT 1 FROM public.roster_at WHERE event_id=p_event_id GROUP BY player_id HAVING count(*)<>1) THEN
    RAISE EXCEPTION 'Each team needs exactly two different rostered players before publishing';
  END IF;
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

  SELECT COALESCE(c.total_par, 36) INTO penalty_par
    FROM public.events e
    LEFT JOIN public.courses c ON c.id = e.course_id
   WHERE e.id = p_event_id;

  FOR penalty_row IN
    INSERT INTO public.scores (
      event_id, player_id, team_id, hole_scores, gross_total, net_total,
      handicap_used, sub_played, entry_type, status, location_id
    )
    SELECT
      p_event_id, r.player_id, r.team_id, NULL, NULL,
      penalty_par + round(COALESCE(p.handicap, 0))::integer + 7,
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
CREATE OR REPLACE FUNCTION public.admin_delete_score(p_score_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  score_row public.scores%ROWTYPE;
  event_row public.events%ROWTYPE;
  target_event UUID;
BEGIN
  SELECT event_id INTO target_event FROM public.scores WHERE id=p_score_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO event_row FROM public.events WHERE id=target_event FOR UPDATE;
  PERFORM public.require_location_admin(event_row.location_id);
  IF event_row.status='closed' THEN RAISE EXCEPTION 'Use a score correction for a closed round; deleting would leave results incomplete'; END IF;
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
COMMIT;

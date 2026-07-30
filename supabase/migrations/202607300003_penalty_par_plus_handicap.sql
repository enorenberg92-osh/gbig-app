-- Penalty rule per Erich (2026-07-30): missed-week penalty net is
--   course par + player handicap + 7
-- e.g. a 2-handicap on a par-36 course who misses the week gets net 45.
-- (202607300001 had used par + 7 flat; this adds the handicap term.)

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

-- Re-base existing penalty rows on the new formula, using the handicap that
-- was stored on the row when the penalty was issued.
UPDATE public.scores s
   SET net_total = COALESCE(c.total_par, 36) + COALESCE(s.handicap_used, 0) + 7
  FROM public.events e
  LEFT JOIN public.courses c ON c.id = e.course_id
 WHERE e.id = s.event_id
   AND s.entry_type = 'missed_penalty'
   AND s.net_total IS DISTINCT FROM COALESCE(c.total_par, 36) + COALESCE(s.handicap_used, 0) + 7;

COMMIT;

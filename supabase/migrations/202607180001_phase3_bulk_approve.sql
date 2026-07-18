-- Phase 3.1: one-tap bulk approve for the admin review queue.
-- Per-row approve/reject already exists (admin_review_score); this approves
-- every pending row for one event in a single audited statement.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_bulk_approve_scores(p_event_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  approved_ids UUID[];
  approved_players UUID[];
BEGIN
  -- Same event-row lock as submit_scores/publish_week: bulk approve
  -- serializes against submissions and publishing.
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;
  PERFORM public.require_location_admin(event_row.location_id);

  WITH updated AS (
    UPDATE public.scores
       SET status = 'verified'
     WHERE event_id = p_event_id AND status = 'pending'
    RETURNING id, player_id
  )
  SELECT array_agg(id), array_agg(DISTINCT player_id)
    INTO approved_ids, approved_players
    FROM updated;

  IF approved_ids IS NOT NULL THEN
    PERFORM public.write_audit_event(
      event_row.location_id, 'score.bulk_approve', 'events', p_event_id, NULL,
      jsonb_build_object('score_ids', to_jsonb(approved_ids))
    );
  END IF;

  RETURN jsonb_build_object(
    'approved', COALESCE(cardinality(approved_ids), 0),
    'player_ids', COALESCE(to_jsonb(approved_players), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_bulk_approve_scores(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_bulk_approve_scores(UUID) TO authenticated;

COMMIT;

-- Season archive & history.
--
-- Each season is a league_config row. Finished seasons get archived_at set:
-- they stay browsable (standings season picker, player career stats) but can't
-- be the admin's working league until un-archived.
--
-- Reads need no new policy: "league_config: location members read" (phase 1
-- role split) already lets every signed-in member of a location SELECT all of
-- its league_config rows, and events / scores / roster_at are location-scoped
-- the same way, so past seasons' standings resolve for players as-is.

BEGIN;

ALTER TABLE public.league_config
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

COMMENT ON COLUMN public.league_config.archived_at IS
  'When the season was archived (NULL = not archived). Archived seasons cannot be the working league.';

-- The working league is what every admin tool writes into, so an archived
-- season can never hold that slot. Enforced here (not just in the UI) because
-- admins switch the working league with direct table updates.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.league_config'::regclass
       AND conname = 'league_config_archived_not_working'
  ) THEN
    ALTER TABLE public.league_config
      ADD CONSTRAINT league_config_archived_not_working
      CHECK (archived_at IS NULL OR is_working IS NOT TRUE);
  END IF;
END $$;

-- Archive / un-archive a season. Returns the new archived_at (NULL when
-- un-archived). Archiving is idempotent and keeps the original timestamp.
CREATE OR REPLACE FUNCTION public.admin_set_league_archived(p_league_id UUID, p_archived BOOLEAN)
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  league_row public.league_config%ROWTYPE;
  new_archived_at TIMESTAMPTZ;
BEGIN
  IF p_archived IS NULL THEN RAISE EXCEPTION 'archived flag is required'; END IF;

  SELECT * INTO league_row FROM public.league_config WHERE id = p_league_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(league_row.location_id);

  IF p_archived AND league_row.is_working THEN
    RAISE EXCEPTION 'This is the working league. Load a different league before archiving it.';
  END IF;

  new_archived_at := CASE WHEN p_archived THEN COALESCE(league_row.archived_at, now()) ELSE NULL END;
  IF new_archived_at IS NOT DISTINCT FROM league_row.archived_at THEN
    RETURN new_archived_at;
  END IF;

  UPDATE public.league_config SET archived_at = new_archived_at WHERE id = p_league_id;

  PERFORM public.write_audit_event(
    league_row.location_id,
    CASE WHEN p_archived THEN 'league.archive' ELSE 'league.unarchive' END,
    'league_config', p_league_id,
    jsonb_build_object('archived_at', league_row.archived_at),
    jsonb_build_object('archived_at', new_archived_at)
  );
  RETURN new_archived_at;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_league_archived(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_league_archived(UUID, BOOLEAN) TO authenticated;

COMMIT;

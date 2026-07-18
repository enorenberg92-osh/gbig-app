-- Phase 5.4: mid-season team swap preserving score history.
-- Player ids on scores never change; the team link changes via
-- team_memberships effective ranges, which roster_at already resolves per
-- event date. The outgoing membership closes the day before the effective
-- date; the incoming one starts on it. Legacy display columns
-- (teams.player1/2_id, players.team_id) are refreshed to the current roster.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_swap_team_member(
  p_team_id UUID,
  p_out_player_id UUID,
  p_in_player_id UUID,
  p_effective_date DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  team_row public.teams%ROWTYPE;
  out_membership public.team_memberships%ROWTYPE;
BEGIN
  SELECT * INTO team_row FROM public.teams WHERE id = p_team_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Team not found'; END IF;
  PERFORM public.require_location_admin(team_row.location_id);
  IF p_effective_date IS NULL THEN RAISE EXCEPTION 'An effective date is required'; END IF;
  IF p_out_player_id = p_in_player_id THEN RAISE EXCEPTION 'Choose two different players'; END IF;

  SELECT * INTO out_membership FROM public.team_memberships
   WHERE team_id = p_team_id AND player_id = p_out_player_id AND effective_to IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The outgoing player has no active spot on this team'; END IF;
  IF p_effective_date <= out_membership.effective_from THEN
    RAISE EXCEPTION 'Effective date must be after the outgoing player joined (%). Use team edit to correct a roster from the start.',
      out_membership.effective_from;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.players
     WHERE id = p_in_player_id AND location_id = team_row.location_id
  ) THEN RAISE EXCEPTION 'The incoming player must belong to this location'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.team_memberships
     WHERE player_id = p_in_player_id AND league_id = team_row.league_id AND effective_to IS NULL
  ) THEN RAISE EXCEPTION 'The incoming player is already on a team in this league'; END IF;

  PERFORM set_config('app.roster_write', 'on', true);

  UPDATE public.team_memberships
     SET effective_to = p_effective_date - 1
   WHERE id = out_membership.id;

  INSERT INTO public.team_memberships (
    location_id, league_id, player_id, team_id, effective_from
  ) VALUES (
    team_row.location_id, team_row.league_id, p_in_player_id, p_team_id, p_effective_date
  );

  -- Refresh legacy display fields to the current roster.
  UPDATE public.teams SET
    player1_id = CASE WHEN player1_id = p_out_player_id THEN p_in_player_id ELSE player1_id END,
    player2_id = CASE WHEN player2_id = p_out_player_id THEN p_in_player_id ELSE player2_id END
  WHERE id = p_team_id;
  UPDATE public.players SET team_id = NULL WHERE id = p_out_player_id;
  UPDATE public.players SET team_id = p_team_id WHERE id = p_in_player_id;

  PERFORM public.write_audit_event(
    team_row.location_id, 'roster.mid_season_swap', 'teams', p_team_id,
    jsonb_build_object('out_player_id', p_out_player_id),
    jsonb_build_object('in_player_id', p_in_player_id, 'effective_from', p_effective_date)
  );

  RETURN jsonb_build_object(
    'team_id', p_team_id,
    'out_player_id', p_out_player_id,
    'in_player_id', p_in_player_id,
    'effective_from', p_effective_date
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_swap_team_member(UUID, UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_swap_team_member(UUID, UUID, UUID, DATE) TO authenticated;

COMMIT;

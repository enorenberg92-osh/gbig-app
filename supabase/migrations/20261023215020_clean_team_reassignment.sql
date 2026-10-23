BEGIN;

-- Keep legacy display labels in sync when a player leaves a team. Retain
-- unchanged memberships and dated history when editing a name or roster.
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
  IF p_player_ids IS NULL OR jsonb_typeof(p_player_ids) <> 'array' THEN
    RAISE EXCEPTION 'A team requires exactly two players';
  END IF;
  IF jsonb_array_length(p_player_ids) <> 2 THEN
    RAISE EXCEPTION 'A team requires exactly two players';
  END IF;
  player_one := (p_player_ids->>0)::uuid;
  player_two := (p_player_ids->>1)::uuid;
  IF player_one = player_two THEN RAISE EXCEPTION 'Team players must be different'; END IF;
  IF (SELECT count(*) FROM public.players WHERE id IN (player_one, player_two) AND location_id = league_row.location_id) <> 2 THEN
    RAISE EXCEPTION 'Both players must belong to the league location';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.team_memberships
    WHERE league_id = p_league_id AND player_id IN (player_one, player_two)
      AND effective_to IS NULL AND team_id IS DISTINCT FROM p_team_id
  ) THEN
    RAISE EXCEPTION 'A selected player is already on another team in this league. Remove them from that team first.';
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
    -- This form corrects the roster. Dated moves use admin_swap_team_member.
    DELETE FROM public.team_memberships
     WHERE team_id = team_id_value AND effective_to IS NULL
       AND player_id NOT IN (player_one, player_two);
  END IF;

  INSERT INTO public.team_memberships (
    location_id, league_id, player_id, team_id, effective_from
  )
  SELECT league_row.location_id, p_league_id, selected.player_id, team_id_value,
    GREATEST(COALESCE(league_row.start_date, DATE '1900-01-01'),
      (SELECT max(history.effective_to) + 1 FROM public.team_memberships history
       WHERE history.league_id = p_league_id AND history.player_id = selected.player_id))
  FROM (VALUES (player_one), (player_two)) AS selected(player_id)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.team_memberships current_member
    WHERE current_member.team_id = team_id_value AND current_member.player_id = selected.player_id
      AND current_member.effective_to IS NULL
  );

  UPDATE public.players SET team_id = NULL
   WHERE team_id = team_id_value AND id NOT IN (player_one, player_two);
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

REVOKE ALL ON FUNCTION public.admin_save_team(UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_team(UUID, UUID, TEXT, JSONB) TO authenticated;

-- Repair only abandoned labels: the player occupies neither that team's slots
-- nor any active membership. Do not infer a transfer or change score history.
DO $$
DECLARE stale_player RECORD;
BEGIN
  PERFORM set_config('app.roster_write', 'on', true);
  FOR stale_player IN
    SELECT p.id, p.location_id, p.team_id FROM public.players p
    WHERE p.team_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.teams t
        WHERE t.id = p.team_id AND p.id IN (t.player1_id, t.player2_id))
      AND NOT EXISTS (SELECT 1 FROM public.team_memberships m
        WHERE m.player_id = p.id AND m.effective_to IS NULL)
    FOR UPDATE OF p
  LOOP
    UPDATE public.players SET team_id = NULL WHERE id = stale_player.id;
    PERFORM public.write_audit_event(stale_player.location_id,
      'roster.stale_team_label_clear', 'players', stale_player.id,
      jsonb_build_object('team_id', stale_player.team_id), jsonb_build_object('team_id', NULL));
  END LOOP;
END;
$$;

COMMIT;

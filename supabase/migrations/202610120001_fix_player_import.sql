-- CSV import (and manual Add Player) failed on real league data:
--  1. players.email was NOT NULL, but the UI treats email as optional
--     ("No email — add one later to create a login").
--  2. admin_create_player / admin_update_player cast handicap with ::integer,
--     so a decimal like "7.5" raised. Round like admin_add_sub already does.

ALTER TABLE public.players ALTER COLUMN email DROP NOT NULL;


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
    COALESCE(round((p_payload->>'handicap')::numeric)::integer, 0)
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
    COALESCE(round((p_payload->>'handicap')::numeric)::integer, round(COALESCE(player_row.handicap, 0))::integer)
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

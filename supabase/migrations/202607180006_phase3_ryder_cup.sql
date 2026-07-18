-- Phase 3.6: Ryder Cup module.
-- cups: named competition with versioned point rules ({win, tie, loss, weeks}).
-- Qualification list = per-player points from scored league matchups over the
-- last `weeks` weeks, computed on demand (cup_qualification) — no stored
-- accrual table to drift out of sync.
-- cup_matches: sessions (fourball / foursomes / singles) with explicit result
-- (team_a / team_b / halved); running score = 1 / ½ / 0 summed client-side.
-- Feature-gated on 'cups' (same require_feature_enabled path as subs/social).

BEGIN;

CREATE TABLE IF NOT EXISTS public.cups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES public.locations(id),
  league_id UUID NOT NULL,
  name TEXT NOT NULL,
  team_a_name TEXT NOT NULL DEFAULT 'Team Red',
  team_b_name TEXT NOT NULL DEFAULT 'Team Blue',
  start_date DATE,
  end_date DATE,
  point_rules JSONB NOT NULL DEFAULT '{"version": 1, "win": 2, "tie": 1, "loss": 0, "weeks": 12}'::jsonb,
  status TEXT NOT NULL DEFAULT 'setup' CHECK (status IN ('setup', 'active', 'complete')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.cup_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cup_id UUID NOT NULL REFERENCES public.cups(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES public.locations(id),
  session TEXT NOT NULL CHECK (session IN ('fourball', 'foursomes', 'singles')),
  match_order INTEGER NOT NULL DEFAULT 0,
  team_a_players UUID[] NOT NULL,
  team_b_players UUID[] NOT NULL,
  result TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending', 'team_a', 'team_b', 'halved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cup_matches_cup_idx ON public.cup_matches(cup_id);

ALTER TABLE public.cups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cup_matches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cups: location members read" ON public.cups;
CREATE POLICY "cups: location members read" ON public.cups
  FOR SELECT TO authenticated USING (public.is_in_location(location_id));
DROP POLICY IF EXISTS "cup_matches: location members read" ON public.cup_matches;
CREATE POLICY "cup_matches: location members read" ON public.cup_matches
  FOR SELECT TO authenticated USING (public.is_in_location(location_id));

REVOKE ALL ON public.cups, public.cup_matches FROM anon;
GRANT SELECT ON public.cups, public.cup_matches TO authenticated;

-- ── validation ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.validate_point_rules(p_rules JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  IF p_rules IS NULL OR jsonb_typeof(p_rules) <> 'object' THEN
    RAISE EXCEPTION 'point_rules must be a JSON object';
  END IF;
  IF (p_rules->>'version')::numeric IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'point_rules.version must be 1';
  END IF;
  IF (p_rules->>'win')::numeric IS NULL OR (p_rules->>'tie')::numeric IS NULL
     OR (p_rules->>'loss')::numeric IS NULL THEN
    RAISE EXCEPTION 'point_rules needs numeric win, tie and loss values';
  END IF;
  IF COALESCE((p_rules->>'weeks')::integer, 0) < 1 THEN
    RAISE EXCEPTION 'point_rules.weeks must be a positive number of weeks';
  END IF;
END;
$$;

-- ── admin RPCs ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_upsert_cup(p_cup_id UUID, p_league_id UUID, p_payload JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  league_row public.league_config%ROWTYPE;
  cup_id_value UUID;
  before_row JSONB;
  rules JSONB;
  requested_status TEXT;
BEGIN
  SELECT * INTO league_row FROM public.league_config WHERE id = p_league_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(league_row.location_id);
  PERFORM public.require_feature_enabled(league_row.location_id, p_league_id, 'cups');

  rules := COALESCE(p_payload->'point_rules', '{"version": 1, "win": 2, "tie": 1, "loss": 0, "weeks": 12}'::jsonb);
  PERFORM public.validate_point_rules(rules);
  requested_status := COALESCE(NULLIF(p_payload->>'status', ''), 'setup');
  IF requested_status NOT IN ('setup', 'active', 'complete') THEN RAISE EXCEPTION 'Invalid cup status'; END IF;
  IF COALESCE(trim(p_payload->>'name'), '') = '' THEN RAISE EXCEPTION 'Cup name is required'; END IF;

  IF p_cup_id IS NULL THEN
    INSERT INTO public.cups (
      location_id, league_id, name, team_a_name, team_b_name,
      start_date, end_date, point_rules, status
    ) VALUES (
      league_row.location_id, p_league_id, trim(p_payload->>'name'),
      COALESCE(NULLIF(trim(p_payload->>'team_a_name'), ''), 'Team Red'),
      COALESCE(NULLIF(trim(p_payload->>'team_b_name'), ''), 'Team Blue'),
      NULLIF(p_payload->>'start_date', '')::date,
      NULLIF(p_payload->>'end_date', '')::date,
      rules, requested_status
    ) RETURNING id INTO cup_id_value;
  ELSE
    SELECT to_jsonb(c) INTO before_row FROM public.cups c
     WHERE id = p_cup_id AND league_id = p_league_id AND location_id = league_row.location_id FOR UPDATE;
    IF before_row IS NULL THEN RAISE EXCEPTION 'Cup not found in league'; END IF;
    cup_id_value := p_cup_id;
    UPDATE public.cups SET
      name = trim(p_payload->>'name'),
      team_a_name = COALESCE(NULLIF(trim(p_payload->>'team_a_name'), ''), team_a_name),
      team_b_name = COALESCE(NULLIF(trim(p_payload->>'team_b_name'), ''), team_b_name),
      start_date = NULLIF(p_payload->>'start_date', '')::date,
      end_date = NULLIF(p_payload->>'end_date', '')::date,
      point_rules = rules,
      status = requested_status
    WHERE id = cup_id_value;
  END IF;

  PERFORM public.write_audit_event(
    league_row.location_id,
    CASE WHEN p_cup_id IS NULL THEN 'cup.create' ELSE 'cup.update' END,
    'cups', cup_id_value, before_row,
    (SELECT to_jsonb(c) FROM public.cups c WHERE c.id = cup_id_value)
  );
  RETURN cup_id_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_cup(p_cup_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE cup_row public.cups%ROWTYPE;
BEGIN
  SELECT * INTO cup_row FROM public.cups WHERE id = p_cup_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.require_location_admin(cup_row.location_id);
  DELETE FROM public.cups WHERE id = p_cup_id;
  PERFORM public.write_audit_event(cup_row.location_id, 'cup.delete', 'cups', p_cup_id, to_jsonb(cup_row), NULL);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_upsert_cup_match(p_match_id UUID, p_cup_id UUID, p_payload JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cup_row public.cups%ROWTYPE;
  match_id_value UUID;
  before_row JSONB;
  a_players UUID[];
  b_players UUID[];
  session_value TEXT;
  expected_size INTEGER;
BEGIN
  SELECT * INTO cup_row FROM public.cups WHERE id = p_cup_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cup not found'; END IF;
  PERFORM public.require_location_admin(cup_row.location_id);
  PERFORM public.require_feature_enabled(cup_row.location_id, cup_row.league_id, 'cups');

  session_value := p_payload->>'session';
  IF session_value NOT IN ('fourball', 'foursomes', 'singles') THEN
    RAISE EXCEPTION 'session must be fourball, foursomes or singles';
  END IF;
  expected_size := CASE WHEN session_value = 'singles' THEN 1 ELSE 2 END;

  a_players := ARRAY(SELECT (value#>>'{}')::uuid FROM jsonb_array_elements(p_payload->'team_a_players'));
  b_players := ARRAY(SELECT (value#>>'{}')::uuid FROM jsonb_array_elements(p_payload->'team_b_players'));
  IF cardinality(a_players) <> expected_size OR cardinality(b_players) <> expected_size THEN
    RAISE EXCEPTION '% needs % player(s) per side', session_value, expected_size;
  END IF;
  IF a_players && b_players THEN
    RAISE EXCEPTION 'A player cannot be on both sides of a match';
  END IF;
  IF (SELECT count(*) FROM public.players
       WHERE id = ANY(a_players || b_players) AND location_id = cup_row.location_id)
     <> cardinality(a_players || b_players) THEN
    RAISE EXCEPTION 'All players must belong to the cup location';
  END IF;

  IF p_match_id IS NULL THEN
    INSERT INTO public.cup_matches (
      cup_id, location_id, session, match_order, team_a_players, team_b_players
    ) VALUES (
      p_cup_id, cup_row.location_id, session_value,
      COALESCE((p_payload->>'match_order')::integer, 0), a_players, b_players
    ) RETURNING id INTO match_id_value;
  ELSE
    SELECT to_jsonb(m) INTO before_row FROM public.cup_matches m
     WHERE id = p_match_id AND cup_id = p_cup_id FOR UPDATE;
    IF before_row IS NULL THEN RAISE EXCEPTION 'Match not found in cup'; END IF;
    match_id_value := p_match_id;
    UPDATE public.cup_matches SET
      session = session_value,
      match_order = COALESCE((p_payload->>'match_order')::integer, match_order),
      team_a_players = a_players,
      team_b_players = b_players
    WHERE id = match_id_value;
  END IF;

  PERFORM public.write_audit_event(
    cup_row.location_id,
    CASE WHEN p_match_id IS NULL THEN 'cup.match_create' ELSE 'cup.match_update' END,
    'cup_matches', match_id_value, before_row,
    (SELECT to_jsonb(m) FROM public.cup_matches m WHERE m.id = match_id_value)
  );
  RETURN match_id_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_cup_match_result(p_match_id UUID, p_result TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  match_row public.cup_matches%ROWTYPE;
  after_row JSONB;
BEGIN
  IF p_result NOT IN ('pending', 'team_a', 'team_b', 'halved') THEN
    RAISE EXCEPTION 'Invalid match result';
  END IF;
  SELECT * INTO match_row FROM public.cup_matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Match not found'; END IF;
  PERFORM public.require_location_admin(match_row.location_id);
  UPDATE public.cup_matches SET result = p_result WHERE id = p_match_id
  RETURNING to_jsonb(cup_matches) INTO after_row;
  PERFORM public.write_audit_event(
    match_row.location_id, 'cup.match_result', 'cup_matches', p_match_id,
    to_jsonb(match_row), after_row
  );
  RETURN after_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_cup_match(p_match_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE match_row public.cup_matches%ROWTYPE;
BEGIN
  SELECT * INTO match_row FROM public.cup_matches WHERE id = p_match_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.require_location_admin(match_row.location_id);
  DELETE FROM public.cup_matches WHERE id = p_match_id;
  PERFORM public.write_audit_event(match_row.location_id, 'cup.match_delete', 'cup_matches', p_match_id, to_jsonb(match_row), NULL);
  RETURN true;
END;
$$;

-- ── qualification list ───────────────────────────────────────────────────────
-- Per-player points over the cup's horizon: every scored league matchup the
-- player took part in (individually, or via their team through roster_at)
-- counts as a win / tie / loss and earns the configured points.
CREATE OR REPLACE FUNCTION public.cup_qualification(p_cup_id UUID)
RETURNS TABLE (player_id UUID, player_name TEXT, points NUMERIC, wins BIGINT, ties BIGINT, losses BIGINT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cup_row public.cups%ROWTYPE;
  win_pts NUMERIC; tie_pts NUMERIC; loss_pts NUMERIC;
  horizon INTEGER;
  max_week INTEGER;
BEGIN
  SELECT * INTO cup_row FROM public.cups WHERE id = p_cup_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cup not found'; END IF;
  IF NOT public.is_in_location(cup_row.location_id) THEN
    RAISE EXCEPTION 'Not a member of this location' USING ERRCODE = '42501';
  END IF;

  win_pts  := (cup_row.point_rules->>'win')::numeric;
  tie_pts  := (cup_row.point_rules->>'tie')::numeric;
  loss_pts := (cup_row.point_rules->>'loss')::numeric;
  horizon  := COALESCE((cup_row.point_rules->>'weeks')::integer, 12);

  SELECT max(e.week_number) INTO max_week
    FROM public.events e
   WHERE e.league_id = cup_row.league_id AND e.status = 'closed';

  RETURN QUERY
  WITH outcomes AS (
    -- one row per player per scored matchup they took part in
    SELECT pl.player_id AS pid,
           CASE WHEN pl.own > pl.opp THEN 'w' WHEN pl.own < pl.opp THEN 'l' ELSE 't' END AS outcome
      FROM public.matchups m
      JOIN public.events e ON e.id = m.event_id
      CROSS JOIN LATERAL (
        -- individual sides
        SELECT m.home_player_id AS player_id, m.points_home AS own, m.points_away AS opp
         WHERE m.home_player_id IS NOT NULL
        UNION ALL
        SELECT m.away_player_id, m.points_away, m.points_home
         WHERE m.away_player_id IS NOT NULL
        UNION ALL
        -- team sides: credit each rostered member
        SELECT r.player_id, m.points_home, m.points_away
          FROM public.roster_at r
         WHERE m.home_team_id IS NOT NULL AND r.event_id = m.event_id AND r.team_id = m.home_team_id
        UNION ALL
        SELECT r.player_id, m.points_away, m.points_home
          FROM public.roster_at r
         WHERE m.away_team_id IS NOT NULL AND r.event_id = m.event_id AND r.team_id = m.away_team_id
      ) pl
     WHERE m.status = 'scored'
       AND m.league_id = cup_row.league_id
       AND m.location_id = cup_row.location_id
       AND e.status = 'closed'
       AND (max_week IS NULL OR COALESCE(e.week_number, 0) > max_week - horizon)
  )
  SELECT o.pid,
         p.name,
         (count(*) FILTER (WHERE o.outcome = 'w') * win_pts
          + count(*) FILTER (WHERE o.outcome = 't') * tie_pts
          + count(*) FILTER (WHERE o.outcome = 'l') * loss_pts) AS points,
         count(*) FILTER (WHERE o.outcome = 'w') AS wins,
         count(*) FILTER (WHERE o.outcome = 't') AS ties,
         count(*) FILTER (WHERE o.outcome = 'l') AS losses
    FROM outcomes o
    JOIN public.players p ON p.id = o.pid
   GROUP BY o.pid, p.name
   ORDER BY points DESC, wins DESC, p.name;
END;
$$;

-- ── grants ───────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.validate_point_rules(JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_upsert_cup(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_cup(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_upsert_cup_match(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_set_cup_match_result(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_cup_match(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cup_qualification(UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admin_upsert_cup(UUID, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_cup(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_upsert_cup_match(UUID, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_cup_match_result(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_cup_match(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cup_qualification(UUID) TO authenticated;

COMMIT;

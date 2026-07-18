-- Tournaments: standalone scored events with sign-ups, separate from league
-- seasons (league_config) and social RSVPs (app_events).
--
-- Model: a tournament has a format (validated by the existing
-- validate_format_config contract), a team size (1..4 — league's two-player
-- rule doesn't apply here), and entries. Players self-sign-up while status =
-- 'signup'; admins add guests (players rows with is_sub = true, same pattern
-- as league subs). Admins group entries into teams, enter scores, and the
-- leaderboard is computed server-side on demand — tournaments never touch
-- league standings or handicaps.
--
-- v1 formats: stroke, scramble, best_ball, stableford. Match-play brackets
-- need pairing UI and land later. Feature-gated on 'tournaments'.

BEGIN;

CREATE TABLE IF NOT EXISTS public.tournaments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES public.locations(id),
  name TEXT NOT NULL,
  tournament_date DATE,
  course_id UUID REFERENCES public.courses(id),
  format TEXT NOT NULL DEFAULT 'stroke',
  format_config JSONB NOT NULL DEFAULT '{"version": 1}'::jsonb,
  team_size INTEGER NOT NULL DEFAULT 1 CHECK (team_size BETWEEN 1 AND 4),
  capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'signup' CHECK (status IN ('signup', 'scoring', 'complete', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tournaments_format_valid CHECK (
    format IN ('stroke', 'scramble', 'best_ball', 'stableford')
    AND public.format_config_valid(format, format_config)
  )
);

CREATE TABLE IF NOT EXISTS public.tournament_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id UUID NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES public.locations(id),
  player_id UUID NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  team_no INTEGER CHECK (team_no IS NULL OR team_no > 0),
  hole_scores INTEGER[],
  handicap_used INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tournament_id, player_id)
);

CREATE INDEX IF NOT EXISTS tournament_entries_tid_idx ON public.tournament_entries(tournament_id);

ALTER TABLE public.tournaments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_entries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tournaments: location members read" ON public.tournaments;
CREATE POLICY "tournaments: location members read" ON public.tournaments
  FOR SELECT TO authenticated USING (public.is_in_location(location_id));
DROP POLICY IF EXISTS "tournament_entries: location members read" ON public.tournament_entries;
CREATE POLICY "tournament_entries: location members read" ON public.tournament_entries
  FOR SELECT TO authenticated USING (public.is_in_location(location_id));

REVOKE ALL ON public.tournaments, public.tournament_entries FROM anon;
GRANT SELECT ON public.tournaments, public.tournament_entries TO authenticated;

-- ── Admin CRUD ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_upsert_tournament(p_tournament_id UUID, p_location_id UUID, p_payload JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t_id UUID;
  before_row JSONB;
  fmt TEXT;
  cfg JSONB;
  requested_status TEXT;
BEGIN
  PERFORM public.require_location_admin(p_location_id);
  PERFORM public.require_feature_enabled(p_location_id, NULL, 'tournaments');

  fmt := COALESCE(NULLIF(p_payload->>'format', ''), 'stroke');
  IF fmt NOT IN ('stroke', 'scramble', 'best_ball', 'stableford') THEN
    RAISE EXCEPTION 'Tournament format must be stroke, scramble, best_ball or stableford';
  END IF;
  cfg := COALESCE(p_payload->'format_config', '{"version": 1}'::jsonb);
  PERFORM public.validate_format_config(fmt, cfg);
  requested_status := COALESCE(NULLIF(p_payload->>'status', ''), 'signup');
  IF requested_status NOT IN ('signup', 'scoring', 'complete', 'cancelled') THEN
    RAISE EXCEPTION 'Invalid tournament status';
  END IF;
  IF COALESCE(trim(p_payload->>'name'), '') = '' THEN RAISE EXCEPTION 'Tournament name is required'; END IF;

  IF p_tournament_id IS NULL THEN
    INSERT INTO public.tournaments (
      location_id, name, tournament_date, course_id, format, format_config,
      team_size, capacity, notes, status
    ) VALUES (
      p_location_id, trim(p_payload->>'name'),
      NULLIF(p_payload->>'tournament_date', '')::date,
      NULLIF(p_payload->>'course_id', '')::uuid,
      fmt, cfg,
      COALESCE((p_payload->>'team_size')::integer, 1),
      NULLIF(p_payload->>'capacity', '')::integer,
      NULLIF(trim(p_payload->>'notes'), ''),
      requested_status
    ) RETURNING id INTO t_id;
  ELSE
    SELECT to_jsonb(t) INTO before_row FROM public.tournaments t
     WHERE id = p_tournament_id AND location_id = p_location_id FOR UPDATE;
    IF before_row IS NULL THEN RAISE EXCEPTION 'Tournament not found'; END IF;
    t_id := p_tournament_id;
    UPDATE public.tournaments SET
      name = trim(p_payload->>'name'),
      tournament_date = NULLIF(p_payload->>'tournament_date', '')::date,
      course_id = NULLIF(p_payload->>'course_id', '')::uuid,
      format = fmt,
      format_config = cfg,
      team_size = COALESCE((p_payload->>'team_size')::integer, team_size),
      capacity = NULLIF(p_payload->>'capacity', '')::integer,
      notes = NULLIF(trim(p_payload->>'notes'), ''),
      status = requested_status
    WHERE id = t_id;
  END IF;

  PERFORM public.write_audit_event(
    p_location_id,
    CASE WHEN p_tournament_id IS NULL THEN 'tournament.create' ELSE 'tournament.update' END,
    'tournaments', t_id, before_row,
    (SELECT to_jsonb(t) FROM public.tournaments t WHERE t.id = t_id)
  );
  RETURN t_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_tournament(p_tournament_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE t_row public.tournaments%ROWTYPE;
BEGIN
  SELECT * INTO t_row FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.require_location_admin(t_row.location_id);
  DELETE FROM public.tournaments WHERE id = p_tournament_id;
  PERFORM public.write_audit_event(t_row.location_id, 'tournament.delete', 'tournaments', p_tournament_id, to_jsonb(t_row), NULL);
  RETURN true;
END;
$$;

-- ── Sign-ups ─────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.signup_tournament(p_tournament_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t_row public.tournaments%ROWTYPE;
  player_row public.players%ROWTYPE;
  entry_id UUID;
  entry_count INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO t_row FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
  PERFORM public.require_feature_enabled(t_row.location_id, NULL, 'tournaments');
  IF t_row.status <> 'signup' THEN RAISE EXCEPTION 'Sign-ups are closed for this tournament'; END IF;

  SELECT * INTO player_row FROM public.players
   WHERE user_id = auth.uid() AND location_id = t_row.location_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'No player profile is linked to this account'; END IF;

  SELECT count(*) INTO entry_count FROM public.tournament_entries WHERE tournament_id = p_tournament_id;
  IF t_row.capacity IS NOT NULL AND entry_count >= t_row.capacity THEN
    RAISE EXCEPTION 'This tournament is full';
  END IF;

  INSERT INTO public.tournament_entries (tournament_id, location_id, player_id)
  VALUES (p_tournament_id, t_row.location_id, player_row.id)
  ON CONFLICT (tournament_id, player_id) DO NOTHING
  RETURNING id INTO entry_id;

  RETURN entry_id; -- NULL = was already signed up
END;
$$;

CREATE OR REPLACE FUNCTION public.withdraw_tournament(p_tournament_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t_row public.tournaments%ROWTYPE;
  player_row public.players%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO t_row FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
  IF t_row.status <> 'signup' THEN RAISE EXCEPTION 'The field is set — ask an admin to remove you'; END IF;
  SELECT * INTO player_row FROM public.players
   WHERE user_id = auth.uid() AND location_id = t_row.location_id;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM public.tournament_entries
   WHERE tournament_id = p_tournament_id AND player_id = player_row.id;
  RETURN FOUND;
END;
$$;

-- Admin adds anyone (member or guest profile) and removes anyone, any status.
CREATE OR REPLACE FUNCTION public.admin_set_tournament_entry(p_tournament_id UUID, p_player_id UUID, p_add BOOLEAN)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE t_row public.tournaments%ROWTYPE;
BEGIN
  SELECT * INTO t_row FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
  PERFORM public.require_location_admin(t_row.location_id);
  IF p_add THEN
    IF NOT EXISTS (SELECT 1 FROM public.players WHERE id = p_player_id AND location_id = t_row.location_id) THEN
      RAISE EXCEPTION 'Player must belong to this location';
    END IF;
    INSERT INTO public.tournament_entries (tournament_id, location_id, player_id)
    VALUES (p_tournament_id, t_row.location_id, p_player_id)
    ON CONFLICT (tournament_id, player_id) DO NOTHING;
  ELSE
    DELETE FROM public.tournament_entries
     WHERE tournament_id = p_tournament_id AND player_id = p_player_id;
  END IF;
  RETURN true;
END;
$$;

-- ── Teams & scores ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_set_tournament_teams(p_tournament_id UUID, p_assignments JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t_row public.tournaments%ROWTYPE;
  a JSONB;
  updated INTEGER := 0;
  oversize INTEGER;
BEGIN
  SELECT * INTO t_row FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
  PERFORM public.require_location_admin(t_row.location_id);
  IF jsonb_typeof(p_assignments) <> 'array' THEN RAISE EXCEPTION 'assignments must be a JSON array'; END IF;

  FOR a IN SELECT value FROM jsonb_array_elements(p_assignments)
  LOOP
    UPDATE public.tournament_entries
       SET team_no = NULLIF(a->>'team_no', '')::integer
     WHERE tournament_id = p_tournament_id
       AND player_id = (a->>'player_id')::uuid;
    updated := updated + (CASE WHEN FOUND THEN 1 ELSE 0 END);
  END LOOP;

  SELECT max(cnt) INTO oversize FROM (
    SELECT count(*) AS cnt FROM public.tournament_entries
     WHERE tournament_id = p_tournament_id AND team_no IS NOT NULL
     GROUP BY team_no
  ) g;
  IF oversize > t_row.team_size THEN
    RAISE EXCEPTION 'A team exceeds the tournament team size of %', t_row.team_size;
  END IF;
  RETURN updated;
END;
$$;

-- Score one entry. Handicap defaults to the player's current handicap and is
-- frozen on the entry (handicap_used) so later league recalcs don't shift
-- tournament results.
CREATE OR REPLACE FUNCTION public.admin_enter_tournament_score(
  p_tournament_id UUID, p_player_id UUID, p_hole_scores JSONB, p_handicap INTEGER DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t_row public.tournaments%ROWTYPE;
  course_row public.courses%ROWTYPE;
  holes_int INTEGER[];
BEGIN
  SELECT * INTO t_row FROM public.tournaments WHERE id = p_tournament_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
  PERFORM public.require_location_admin(t_row.location_id);
  SELECT * INTO course_row FROM public.courses WHERE id = t_row.course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assign a course to this tournament before entering scores'; END IF;
  IF NOT public.jsonb_int_array_valid(p_hole_scores, course_row.num_holes, 1, 20) THEN
    RAISE EXCEPTION 'Scores must include % holes with values from 1 to 20', course_row.num_holes;
  END IF;
  holes_int := ARRAY(SELECT elem::integer FROM jsonb_array_elements_text(p_hole_scores) AS t(elem));

  UPDATE public.tournament_entries e
     SET hole_scores = holes_int,
         handicap_used = COALESCE(p_handicap,
                                  e.handicap_used,
                                  (SELECT round(COALESCE(p.handicap, 0))::integer FROM public.players p WHERE p.id = e.player_id))
   WHERE e.tournament_id = p_tournament_id AND e.player_id = p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That player is not in this tournament'; END IF;
  RETURN true;
END;
$$;

-- ── Leaderboard (computed on demand, member-readable) ────────────────────────
CREATE OR REPLACE FUNCTION public.tournament_leaderboard(p_tournament_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t_row public.tournaments%ROWTYPE;
  course_row public.courses%ROWTYPE;
  cfg JSONB;
  e RECORD;
  rows JSONB := '[]'::jsonb;
  strokes INTEGER[];
  net NUMERIC;
  team RECORD;
  i INTEGER;
  best NUMERIC;
  hole_sum NUMERIC;
  team_total NUMERIC;
  s RECORD;
  balls INTEGER;
BEGIN
  SELECT * INTO t_row FROM public.tournaments WHERE id = p_tournament_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Tournament not found'; END IF;
  IF NOT public.is_in_location(t_row.location_id) THEN
    RAISE EXCEPTION 'Not a member of this location' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO course_row FROM public.courses WHERE id = t_row.course_id;
  IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
  cfg := t_row.format_config;

  IF t_row.format IN ('stroke', 'stableford') THEN
    FOR e IN
      SELECT te.player_id, te.team_no, te.hole_scores, te.handicap_used, p.name
        FROM public.tournament_entries te JOIN public.players p ON p.id = te.player_id
       WHERE te.tournament_id = p_tournament_id AND te.hole_scores IS NOT NULL
    LOOP
      strokes := public.format_strokes_received(e.handicap_used, course_row.stroke_index, course_row.num_holes, 100);
      IF t_row.format = 'stableford' THEN
        net := public.format_stableford_points(e.hole_scores, course_row.hole_pars, strokes, cfg->'points')
               - CASE WHEN cfg->>'quota_basis' = 'handicap'
                      THEN (2 * course_row.num_holes) - COALESCE(e.handicap_used, 0) ELSE 0 END;
      ELSE
        net := (SELECT sum(v) FROM unnest(e.hole_scores) v) - COALESCE(e.handicap_used, 0);
      END IF;
      rows := rows || jsonb_build_object(
        'name', e.name, 'team_no', e.team_no,
        'gross', (SELECT sum(v) FROM unnest(e.hole_scores) v),
        'result', net
      );
    END LOOP;
    RETURN (SELECT COALESCE(jsonb_agg(r ORDER BY
              CASE WHEN t_row.format = 'stableford' THEN -(r->>'result')::numeric ELSE (r->>'result')::numeric END),
            '[]'::jsonb)
            FROM jsonb_array_elements(rows) r);
  END IF;

  -- Team formats: scramble / best_ball, grouped by team_no.
  FOR team IN
    SELECT te.team_no FROM public.tournament_entries te
     WHERE te.tournament_id = p_tournament_id AND te.team_no IS NOT NULL AND te.hole_scores IS NOT NULL
     GROUP BY te.team_no ORDER BY te.team_no
  LOOP
    IF t_row.format = 'scramble' THEN
      SELECT min((SELECT sum(v) FROM unnest(te.hole_scores) v)),
             sum(te.handicap_used)
        INTO team_total, net
        FROM public.tournament_entries te
       WHERE te.tournament_id = p_tournament_id AND te.team_no = team.team_no AND te.hole_scores IS NOT NULL;
      net := team_total - round(COALESCE(net, 0) * COALESCE((cfg->>'team_handicap_pct')::numeric, 35) / 100.0);
    ELSE
      balls := COALESCE((cfg->>'balls_counted')::integer, 1);
      net := 0; team_total := 0;
      FOR i IN 1..course_row.num_holes LOOP
        best := NULL; hole_sum := 0;
        FOR s IN
          SELECT te.hole_scores, te.handicap_used FROM public.tournament_entries te
           WHERE te.tournament_id = p_tournament_id AND te.team_no = team.team_no AND te.hole_scores IS NOT NULL
        LOOP
          strokes := public.format_strokes_received(s.handicap_used, course_row.stroke_index, course_row.num_holes,
                                                    COALESCE((cfg->>'allowance_pct')::numeric, 100));
          hole_sum := hole_sum + (s.hole_scores[i] - strokes[i]);
          IF best IS NULL OR (s.hole_scores[i] - strokes[i]) < best THEN best := s.hole_scores[i] - strokes[i]; END IF;
        END LOOP;
        net := net + CASE WHEN balls = 2 THEN hole_sum ELSE COALESCE(best, 0) END;
      END LOOP;
      team_total := NULL;
    END IF;

    rows := rows || jsonb_build_object(
      'team_no', team.team_no,
      'name', (SELECT string_agg(p.name, ' / ' ORDER BY p.name)
                 FROM public.tournament_entries te JOIN public.players p ON p.id = te.player_id
                WHERE te.tournament_id = p_tournament_id AND te.team_no = team.team_no),
      'gross', team_total,
      'result', net
    );
  END LOOP;

  RETURN (SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'result')::numeric), '[]'::jsonb)
          FROM jsonb_array_elements(rows) r);
END;
$$;

-- ── grants ───────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.admin_upsert_tournament(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_tournament(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.signup_tournament(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.withdraw_tournament(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_set_tournament_entry(UUID, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_set_tournament_teams(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_enter_tournament_score(UUID, UUID, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tournament_leaderboard(UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admin_upsert_tournament(UUID, UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_tournament(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.signup_tournament(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_tournament(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_tournament_entry(UUID, UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_tournament_teams(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_enter_tournament_score(UUID, UUID, JSONB, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.tournament_leaderboard(UUID) TO authenticated;

COMMIT;

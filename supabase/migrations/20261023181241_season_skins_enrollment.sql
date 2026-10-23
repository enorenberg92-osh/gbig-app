-- Skins enrollment belongs to a league season. The legacy player flag remains
-- a compatibility input for the existing profile editor, never a report fallback.
CREATE TABLE public.league_skins_enrollments (
  league_id UUID NOT NULL REFERENCES public.league_config(id) ON DELETE CASCADE,
  player_id UUID NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  enrolled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (league_id, player_id)
);
CREATE INDEX league_skins_enrollments_location ON public.league_skins_enrollments(location_id, league_id);
CREATE INDEX league_skins_enrollments_player ON public.league_skins_enrollments(player_id);

ALTER TABLE public.league_skins_enrollments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.league_skins_enrollments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.league_skins_enrollments TO authenticated;
GRANT ALL ON public.league_skins_enrollments TO service_role;
CREATE POLICY "season skins: location members read"
  ON public.league_skins_enrollments FOR SELECT TO authenticated
  USING (public.is_in_location(location_id));

-- Preserve existing selections for current and previously played seasons.
-- Planned seasons start unchecked; new seasons never inherit the global flag.
WITH season_players AS (
  SELECT league_id, player_id FROM public.team_memberships
  UNION
  SELECT league_id, player1_id FROM public.teams WHERE player1_id IS NOT NULL
  UNION
  SELECT league_id, player2_id FROM public.teams WHERE player2_id IS NOT NULL
  UNION
  SELECT league_id, id FROM public.players WHERE league_id IS NOT NULL
)
INSERT INTO public.league_skins_enrollments(league_id, player_id, location_id, enrolled)
SELECT l.id, p.id, l.location_id,
  COALESCE(p.in_skins, false) AND (
    COALESCE(l.is_working, false) OR EXISTS (
      SELECT 1 FROM public.events e JOIN public.scores s ON s.event_id = e.id
      WHERE e.league_id = l.id AND s.status <> 'rejected'
    )
  )
FROM season_players sp
JOIN public.league_config l ON l.id = sp.league_id
JOIN public.players p ON p.id = sp.player_id AND p.location_id = l.location_id;

CREATE OR REPLACE FUNCTION public.guard_league_skins_enrollment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.league_config l JOIN public.players p ON p.id = NEW.player_id
    WHERE l.id = NEW.league_id AND l.location_id = NEW.location_id
      AND p.location_id = NEW.location_id
  ) THEN
    RAISE EXCEPTION 'Player and league must belong to the same venue' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_league_skins_enrollment() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER guard_league_skins_enrollment
  BEFORE INSERT OR UPDATE ON public.league_skins_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.guard_league_skins_enrollment();

CREATE OR REPLACE FUNCTION public.audit_league_skins_enrollment()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.enrolled IS NOT DISTINCT FROM OLD.enrolled THEN
    RETURN NEW;
  END IF;
  PERFORM public.write_audit_event(
    NEW.location_id, 'league.skins_enrollment.update', 'league_skins_enrollments', NEW.player_id,
    CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END, to_jsonb(NEW)
  );
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.audit_league_skins_enrollment() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER audit_league_skins_enrollment
  AFTER INSERT OR UPDATE ON public.league_skins_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.audit_league_skins_enrollment();

CREATE OR REPLACE FUNCTION public.sync_working_league_skins()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  working_league_id UUID;
BEGIN
  -- Substitute profiles are not automatically added to the league roster.
  IF TG_OP = 'INSERT' AND COALESCE(NEW.is_sub, false) THEN RETURN NEW; END IF;
  SELECT id INTO working_league_id FROM public.league_config
    WHERE location_id = NEW.location_id AND is_working;
  IF working_league_id IS NOT NULL THEN
    -- UPDATE OF deliberately fires even if the raw flag is unchanged: a new
    -- season can be unchecked while the historical player flag is still true.
    INSERT INTO public.league_skins_enrollments(league_id, player_id, location_id, enrolled)
    VALUES (working_league_id, NEW.id, NEW.location_id, COALESCE(NEW.in_skins, false))
    ON CONFLICT (league_id, player_id) DO UPDATE SET enrolled = EXCLUDED.enrolled;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_working_league_skins() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER sync_working_league_skins
  AFTER INSERT OR UPDATE OF in_skins ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.sync_working_league_skins();

CREATE OR REPLACE FUNCTION public.admin_set_skins_enrollment(
  p_league_id UUID, p_player_id UUID, p_enrolled BOOLEAN
)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  league_row public.league_config%ROWTYPE;
  player_row public.players%ROWTYPE;
BEGIN
  SELECT * INTO league_row FROM public.league_config WHERE id = p_league_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(league_row.location_id);
  IF p_enrolled IS NULL THEN RAISE EXCEPTION 'Choose whether the player is enrolled'; END IF;
  SELECT * INTO player_row FROM public.players WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND OR player_row.location_id IS DISTINCT FROM league_row.location_id THEN
    RAISE EXCEPTION 'Player not found in this venue';
  END IF;
  INSERT INTO public.league_skins_enrollments(league_id, player_id, location_id, enrolled)
  VALUES (p_league_id, p_player_id, league_row.location_id, p_enrolled)
  ON CONFLICT (league_id, player_id) DO UPDATE SET enrolled = EXCLUDED.enrolled;
  IF league_row.is_working THEN
    PERFORM set_config('app.player_write', 'on', true);
    UPDATE public.players SET in_skins = p_enrolled WHERE id = p_player_id;
  END IF;
  RETURN p_enrolled;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_skins_enrollment(UUID, UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_skins_enrollment(UUID, UUID, BOOLEAN) TO authenticated;

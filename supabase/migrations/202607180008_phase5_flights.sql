-- Phase 5.1: flights/divisions.
-- flights group a league's teams for per-flight standings. Admins CRUD flights
-- directly (allowlisted table); team assignment goes through one audited RPC.
-- Feature-gated on 'flights'.

BEGIN;

CREATE TABLE IF NOT EXISTS public.flights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES public.locations(id),
  league_id UUID NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.teams ADD COLUMN IF NOT EXISTS flight_id UUID REFERENCES public.flights(id) ON DELETE SET NULL;

ALTER TABLE public.flights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "flights: location members read" ON public.flights;
CREATE POLICY "flights: location members read" ON public.flights
  FOR SELECT TO authenticated USING (public.is_in_location(location_id));
DROP POLICY IF EXISTS "flights: admins write" ON public.flights;
CREATE POLICY "flights: admins write" ON public.flights
  FOR ALL TO authenticated
  USING (public.is_admin_of_location(location_id))
  WITH CHECK (public.is_admin_of_location(location_id));

REVOKE ALL ON public.flights FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.flights TO authenticated;

-- One audited call assigns every team; NULL flight_id clears an assignment.
CREATE OR REPLACE FUNCTION public.admin_assign_flights(p_league_id UUID, p_assignments JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  league_row public.league_config%ROWTYPE;
  a JSONB;
  target_flight UUID;
  updated INTEGER := 0;
  affected INTEGER;
BEGIN
  SELECT * INTO league_row FROM public.league_config WHERE id = p_league_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(league_row.location_id);
  PERFORM public.require_feature_enabled(league_row.location_id, p_league_id, 'flights');
  IF jsonb_typeof(p_assignments) <> 'array' THEN RAISE EXCEPTION 'assignments must be a JSON array'; END IF;

  FOR a IN SELECT value FROM jsonb_array_elements(p_assignments)
  LOOP
    target_flight := NULLIF(a->>'flight_id', '')::uuid;
    IF target_flight IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.flights
       WHERE id = target_flight AND league_id = p_league_id AND location_id = league_row.location_id
    ) THEN
      RAISE EXCEPTION 'Flight does not belong to this league';
    END IF;
    UPDATE public.teams
       SET flight_id = target_flight
     WHERE id = (a->>'team_id')::uuid
       AND league_id = p_league_id
       AND location_id = league_row.location_id;
    GET DIAGNOSTICS affected = ROW_COUNT;
    updated := updated + affected;
  END LOOP;

  PERFORM public.write_audit_event(
    league_row.location_id, 'flight.assign', 'league_config', p_league_id,
    NULL, jsonb_build_object('assignments', p_assignments, 'updated', updated)
  );
  RETURN updated;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_assign_flights(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_assign_flights(UUID, JSONB) TO authenticated;

COMMIT;

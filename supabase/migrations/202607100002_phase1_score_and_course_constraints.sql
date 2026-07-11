-- Phase 1 / apply second: lifecycle columns, duplicate quarantine, score uniqueness,
-- and course/score validation. Existing score rows are intentionally backfilled as
-- verified before the partial unique index is built.

ALTER TABLE public.scores
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'verified',
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS team_id UUID REFERENCES public.teams(id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.scores'::regclass
       AND conname = 'scores_status_check'
  ) THEN
    ALTER TABLE public.scores
      ADD CONSTRAINT scores_status_check
      CHECK (status IN ('pending', 'verified', 'rejected'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.score_duplicate_quarantine (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_score_id  UUID NOT NULL,
  location_id        UUID NOT NULL REFERENCES public.locations(id),
  event_id           UUID NOT NULL,
  player_id          UUID NOT NULL,
  entry_type         TEXT NOT NULL,
  source_score       JSONB NOT NULL,
  quarantined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason             TEXT NOT NULL DEFAULT 'duplicate effective score during Phase 1 migration',
  UNIQUE (original_score_id)
);

WITH ranked AS (
  SELECT
    s.id,
    row_number() OVER (
      PARTITION BY s.event_id, s.player_id, s.entry_type
      ORDER BY
        -- live schema: hole_scores is integer[], not jsonb
        COALESCE(cardinality(s.hole_scores), 0) DESC,
        ((s.gross_total IS NOT NULL)::int + (s.net_total IS NOT NULL)::int + (s.handicap_used IS NOT NULL)::int) DESC,
        s.created_at DESC,
        s.id
    ) AS duplicate_rank
  FROM public.scores s
  WHERE s.status <> 'rejected'
), duplicates AS (
  SELECT s.*
    FROM public.scores s
    JOIN ranked r ON r.id = s.id
   WHERE r.duplicate_rank > 1
)
INSERT INTO public.score_duplicate_quarantine (
  original_score_id, location_id, event_id, player_id, entry_type, source_score
)
SELECT id, location_id, event_id, player_id, entry_type, to_jsonb(duplicates)
  FROM duplicates
ON CONFLICT (original_score_id) DO NOTHING;

DELETE FROM public.scores s
USING public.score_duplicate_quarantine q
WHERE q.original_score_id = s.id;

CREATE UNIQUE INDEX IF NOT EXISTS scores_one_effective_entry
  ON public.scores(event_id, player_id, entry_type)
  WHERE status <> 'rejected';

CREATE INDEX IF NOT EXISTS idx_scores_player_created
  ON public.scores(player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scores_event_status_type
  ON public.scores(event_id, status, entry_type);

CREATE OR REPLACE FUNCTION public.jsonb_int_array_valid(
  value JSONB,
  expected_length INTEGER,
  min_value INTEGER,
  max_value INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT value IS NOT NULL
    AND jsonb_typeof(value) = 'array'
    AND jsonb_array_length(value) = expected_length
    AND NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(value) AS item(raw)
       WHERE raw !~ '^-?[0-9]+$'
          OR raw::integer < min_value
          OR raw::integer > max_value
    );
$$;

CREATE OR REPLACE FUNCTION public.jsonb_int_array_sum(value JSONB)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT COALESCE(sum(raw::integer), 0)::integer
    FROM jsonb_array_elements_text(value) AS item(raw);
$$;

-- Integer[] twins of the jsonb helpers: scores.hole_scores is integer[] in the
-- live schema (jsonb helpers still validate courses.hole_pars + RPC payloads).
CREATE OR REPLACE FUNCTION public.int_array_valid(
  value INTEGER[],
  expected_length INTEGER,
  min_value INTEGER,
  max_value INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT value IS NOT NULL
    AND cardinality(value) = expected_length
    AND NOT EXISTS (
      SELECT 1 FROM unnest(value) AS item(v)
       WHERE v IS NULL OR v < min_value OR v > max_value
    );
$$;

CREATE OR REPLACE FUNCTION public.int_array_sum(value INTEGER[])
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = public
AS $$
  SELECT COALESCE(sum(v), 0)::integer FROM unnest(value) AS item(v);
$$;

-- Legacy backfill: some courses predate hole_pars and only carry pars int[].
UPDATE public.courses
   SET hole_pars = to_jsonb(pars)
 WHERE hole_pars IS NULL
   AND pars IS NOT NULL;

-- Repair only derived values. Missing/invalid pars are never fabricated.
UPDATE public.courses
   SET num_holes = jsonb_array_length(hole_pars),
       total_par = public.jsonb_int_array_sum(hole_pars)
 WHERE jsonb_typeof(hole_pars) = 'array'
   AND jsonb_array_length(hole_pars) IN (9, 18)
   AND public.jsonb_int_array_valid(
         hole_pars, jsonb_array_length(hole_pars), 3, 6
       );

DO $$
DECLARE
  invalid_ids TEXT;
BEGIN
  SELECT string_agg(id::text, ', ' ORDER BY id::text)
    INTO invalid_ids
    FROM public.courses
   WHERE hole_pars IS NULL
      OR num_holes IS NULL
      OR num_holes NOT IN (9, 18)
      OR NOT public.jsonb_int_array_valid(hole_pars, num_holes, 3, 6)
      OR total_par IS DISTINCT FROM public.jsonb_int_array_sum(hole_pars);

  IF invalid_ids IS NOT NULL THEN
    RAISE EXCEPTION
      'Phase 1 requires valid hole_pars before constraints can be installed. Fix courses: %',
      invalid_ids;
  END IF;
END $$;

ALTER TABLE public.courses
  ALTER COLUMN num_holes SET NOT NULL,
  ALTER COLUMN hole_pars SET NOT NULL,
  ALTER COLUMN total_par SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.courses'::regclass
       AND conname = 'courses_hole_pars_integrity'
  ) THEN
    ALTER TABLE public.courses
      ADD CONSTRAINT courses_hole_pars_integrity
      CHECK (
        num_holes IN (9, 18)
        AND public.jsonb_int_array_valid(hole_pars, num_holes, 3, 6)
        AND total_par = public.jsonb_int_array_sum(hole_pars)
      );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.validate_score_row()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  course_holes INTEGER;
BEGIN
  -- Do not force unrelated backfills (team_id/status metadata) to revalidate
  -- historical score payloads. Any score-bearing change is fully validated.
  IF TG_OP = 'UPDATE'
     AND NEW.event_id IS NOT DISTINCT FROM OLD.event_id
     AND NEW.entry_type IS NOT DISTINCT FROM OLD.entry_type
     AND NEW.hole_scores IS NOT DISTINCT FROM OLD.hole_scores
     AND NEW.gross_total IS NOT DISTINCT FROM OLD.gross_total
     AND NEW.net_total IS NOT DISTINCT FROM OLD.net_total
     AND NEW.handicap_used IS NOT DISTINCT FROM OLD.handicap_used THEN
    RETURN NEW;
  END IF;

  IF NEW.entry_type = 'played' THEN
    SELECT c.num_holes
      INTO course_holes
      FROM public.events e
      JOIN public.courses c ON c.id = e.course_id
     WHERE e.id = NEW.event_id;

    IF course_holes IS NULL THEN
      RAISE EXCEPTION 'Played scores require an event with a valid course';
    END IF;
    IF NOT public.int_array_valid(NEW.hole_scores, course_holes, 1, 20) THEN
      RAISE EXCEPTION 'hole_scores must contain exactly % integer scores from 1 to 20', course_holes;
    END IF;
    IF NEW.gross_total IS DISTINCT FROM public.int_array_sum(NEW.hole_scores) THEN
      RAISE EXCEPTION 'gross_total must equal the sum of hole_scores';
    END IF;
    IF NEW.handicap_used IS NULL OR NEW.net_total IS DISTINCT FROM NEW.gross_total - NEW.handicap_used THEN
      RAISE EXCEPTION 'net_total must equal gross_total minus handicap_used';
    END IF;
  ELSIF NEW.entry_type = 'missed_penalty' THEN
    IF NEW.hole_scores IS NOT NULL OR NEW.gross_total IS NOT NULL THEN
      RAISE EXCEPTION 'missed_penalty rows cannot contain hole_scores or gross_total';
    END IF;
    IF NEW.net_total IS NULL OR NEW.handicap_used IS NULL THEN
      RAISE EXCEPTION 'missed_penalty rows require net_total and handicap_used';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unknown score entry_type: %', NEW.entry_type;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS scores_validate_payload ON public.scores;
CREATE TRIGGER scores_validate_payload
  BEFORE INSERT OR UPDATE ON public.scores
  FOR EACH ROW EXECUTE FUNCTION public.validate_score_row();

ALTER TABLE public.score_duplicate_quarantine ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "score quarantine: location admins read" ON public.score_duplicate_quarantine;
CREATE POLICY "score quarantine: location admins read" ON public.score_duplicate_quarantine
  FOR SELECT TO authenticated
  USING (public.is_admin_of_location(location_id));

REVOKE ALL ON public.score_duplicate_quarantine FROM anon, authenticated;
GRANT SELECT ON public.score_duplicate_quarantine TO authenticated;
REVOKE ALL ON FUNCTION public.jsonb_int_array_valid(JSONB, INTEGER, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jsonb_int_array_sum(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.int_array_valid(INTEGER[], INTEGER, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.int_array_sum(INTEGER[]) FROM PUBLIC;


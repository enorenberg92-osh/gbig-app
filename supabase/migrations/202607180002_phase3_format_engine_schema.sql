-- Phase 3.2: format engine schema + stroke index.
-- events.format / events.format_config (versioned, strictly validated),
-- league_config default format, courses.stroke_index (permutation of 1..n).
-- Result computation lands with matchups (3.3); this migration is the
-- validated data contract everything downstream trusts.

BEGIN;

-- ── courses.stroke_index ─────────────────────────────────────────────────────
-- NULL = no index entered; engines fall back to even-spread allocation
-- (documented in UI). When present it must be a permutation of 1..num_holes.

CREATE OR REPLACE FUNCTION public.jsonb_stroke_index_valid(value JSONB, hole_count INTEGER)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT value IS NULL OR (
    jsonb_typeof(value) = 'array'
    AND jsonb_array_length(value) = hole_count
    AND (
      SELECT count(DISTINCT raw::integer) = hole_count
        FROM jsonb_array_elements_text(value) AS item(raw)
       WHERE raw ~ '^\d+$' AND raw::integer BETWEEN 1 AND hole_count
    )
  );
$$;

ALTER TABLE public.courses ADD COLUMN IF NOT EXISTS stroke_index JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.courses'::regclass
       AND conname = 'courses_stroke_index_valid'
  ) THEN
    ALTER TABLE public.courses
      ADD CONSTRAINT courses_stroke_index_valid
      CHECK (public.jsonb_stroke_index_valid(stroke_index, num_holes));
  END IF;
END $$;

-- ── format_config validation ─────────────────────────────────────────────────
-- Strict, versioned contract: unknown keys are rejected so a typo'd option can
-- never silently change scoring. version is required and must be 1.

CREATE OR REPLACE FUNCTION public.validate_format_config(p_format TEXT, p_config JSONB)
RETURNS VOID
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  allowed TEXT[];
  key TEXT;
  pts JSONB;
  pts_key TEXT;
BEGIN
  IF p_format IS NULL OR p_format NOT IN
     ('stroke', 'match_team', 'match_individual', 'stableford', 'scramble', 'best_ball') THEN
    RAISE EXCEPTION 'Unknown event format: %', COALESCE(p_format, '(null)');
  END IF;
  IF p_config IS NULL OR jsonb_typeof(p_config) <> 'object' THEN
    RAISE EXCEPTION 'format_config must be a JSON object';
  END IF;
  IF (p_config->>'version')::numeric IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'format_config.version must be 1';
  END IF;

  allowed := ARRAY['version', 'no_show', 'net'];
  allowed := allowed || CASE p_format
    WHEN 'match_team'       THEN ARRAY['points_win', 'points_tie', 'points_loss', 'allowance_pct']
    WHEN 'match_individual' THEN ARRAY['points_win', 'points_tie', 'points_loss', 'allowance_pct']
    WHEN 'stableford'       THEN ARRAY['points', 'quota_basis']
    WHEN 'scramble'         THEN ARRAY['team_handicap_pct', 'exclude_from_handicap']
    WHEN 'best_ball'        THEN ARRAY['balls_counted', 'allowance_pct']
    ELSE ARRAY[]::TEXT[]
  END;

  FOR key IN SELECT jsonb_object_keys(p_config)
  LOOP
    IF NOT key = ANY(allowed) THEN
      RAISE EXCEPTION 'format_config key "%" is not valid for format %', key, p_format;
    END IF;
  END LOOP;

  IF p_config ? 'no_show' AND p_config->>'no_show' NOT IN ('forfeit', 'zero_points', 'half_points') THEN
    RAISE EXCEPTION 'no_show must be forfeit, zero_points or half_points';
  END IF;
  IF p_config ? 'net' AND jsonb_typeof(p_config->'net') <> 'boolean' THEN
    RAISE EXCEPTION 'net must be a boolean';
  END IF;

  IF p_format IN ('match_team', 'match_individual') THEN
    FOREACH key IN ARRAY ARRAY['points_win', 'points_tie', 'points_loss']
    LOOP
      IF p_config ? key AND ((p_config->>key)::numeric IS NULL OR (p_config->>key)::numeric < 0) THEN
        RAISE EXCEPTION '% must be a number >= 0', key;
      END IF;
    END LOOP;
  END IF;

  IF p_config ? 'allowance_pct' AND
     ((p_config->>'allowance_pct')::numeric IS NULL OR
      (p_config->>'allowance_pct')::numeric NOT BETWEEN 0 AND 100) THEN
    RAISE EXCEPTION 'allowance_pct must be between 0 and 100';
  END IF;

  IF p_format = 'stableford' THEN
    IF p_config ? 'quota_basis' AND p_config->>'quota_basis' NOT IN ('none', 'handicap') THEN
      RAISE EXCEPTION 'quota_basis must be none or handicap';
    END IF;
    IF p_config ? 'points' THEN
      pts := p_config->'points';
      IF jsonb_typeof(pts) <> 'object' THEN RAISE EXCEPTION 'points must be an object'; END IF;
      FOR pts_key IN SELECT jsonb_object_keys(pts)
      LOOP
        IF pts_key NOT IN ('albatross', 'eagle', 'birdie', 'par', 'bogey', 'double_bogey_plus') THEN
          RAISE EXCEPTION 'points key "%" is not a valid score name', pts_key;
        END IF;
        IF (pts->>pts_key)::numeric IS NULL THEN
          RAISE EXCEPTION 'points.% must be a number', pts_key;
        END IF;
      END LOOP;
    END IF;
  END IF;

  IF p_format = 'scramble' THEN
    IF p_config ? 'team_handicap_pct' AND
       ((p_config->>'team_handicap_pct')::numeric IS NULL OR
        (p_config->>'team_handicap_pct')::numeric NOT BETWEEN 0 AND 100) THEN
      RAISE EXCEPTION 'team_handicap_pct must be between 0 and 100';
    END IF;
    IF p_config ? 'exclude_from_handicap' AND jsonb_typeof(p_config->'exclude_from_handicap') <> 'boolean' THEN
      RAISE EXCEPTION 'exclude_from_handicap must be a boolean';
    END IF;
  END IF;

  IF p_format = 'best_ball' AND p_config ? 'balls_counted' AND
     ((p_config->>'balls_counted')::numeric IS NULL OR
      (p_config->>'balls_counted')::numeric NOT IN (1, 2)) THEN
    RAISE EXCEPTION 'balls_counted must be 1 or 2';
  END IF;
END;
$$;

-- Boolean wrapper so the CHECK constraint can use the strict validator.
CREATE OR REPLACE FUNCTION public.format_config_valid(p_format TEXT, p_config JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
BEGIN
  PERFORM public.validate_format_config(p_format, p_config);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

-- ── events + league_config columns ───────────────────────────────────────────

ALTER TABLE public.events
  ADD COLUMN IF NOT EXISTS format TEXT NOT NULL DEFAULT 'stroke',
  ADD COLUMN IF NOT EXISTS format_config JSONB NOT NULL DEFAULT '{"version": 1}'::jsonb;

ALTER TABLE public.league_config
  ADD COLUMN IF NOT EXISTS default_format TEXT NOT NULL DEFAULT 'stroke',
  ADD COLUMN IF NOT EXISTS default_format_config JSONB NOT NULL DEFAULT '{"version": 1}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.events'::regclass AND conname = 'events_format_config_valid'
  ) THEN
    ALTER TABLE public.events
      ADD CONSTRAINT events_format_config_valid
      CHECK (public.format_config_valid(format, format_config));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.league_config'::regclass AND conname = 'league_default_format_config_valid'
  ) THEN
    ALTER TABLE public.league_config
      ADD CONSTRAINT league_default_format_config_valid
      CHECK (public.format_config_valid(default_format, default_format_config));
  END IF;
END $$;

-- ── admin_upsert_event: accept format override ───────────────────────────────
-- Create: league default unless the payload overrides. Update: format may only
-- change while the event is not closed (closed events stay immutable).

CREATE OR REPLACE FUNCTION public.admin_upsert_event(p_event_id UUID, p_league_id UUID, p_payload JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  league_row public.league_config%ROWTYPE;
  event_id_value UUID;
  requested_status TEXT;
  before_row JSONB;
  format_value TEXT;
  format_config_value JSONB;
BEGIN
  SELECT * INTO league_row FROM public.league_config WHERE id = p_league_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(league_row.location_id);
  requested_status := COALESCE(NULLIF(p_payload->>'status', ''), 'draft');
  IF requested_status NOT IN ('draft', 'open', 'cancelled', 'closed') THEN RAISE EXCEPTION 'Invalid event status'; END IF;
  IF requested_status = 'closed' AND NOT COALESCE((p_payload->>'is_bye')::boolean, false) THEN
    RAISE EXCEPTION 'Only publish_week may close a playable event';
  END IF;

  IF p_event_id IS NULL THEN
    format_value := COALESCE(NULLIF(p_payload->>'format', ''), league_row.default_format, 'stroke');
    format_config_value := COALESCE(p_payload->'format_config',
                                    league_row.default_format_config,
                                    '{"version": 1}'::jsonb);
    PERFORM public.validate_format_config(format_value, format_config_value);
    INSERT INTO public.events (
      name, start_date, end_date, status, notes, course_id, hole_event_hole,
      hole_event_name, is_bye, week_number, format, format_config, league_id, location_id
    ) VALUES (
      trim(p_payload->>'name'), NULLIF(p_payload->>'start_date', '')::date,
      NULLIF(p_payload->>'end_date', '')::date, requested_status,
      NULLIF(trim(p_payload->>'notes'), ''), NULLIF(p_payload->>'course_id', '')::uuid,
      NULLIF(p_payload->>'hole_event_hole', '')::integer,
      NULLIF(trim(p_payload->>'hole_event_name'), ''),
      COALESCE((p_payload->>'is_bye')::boolean, false),
      NULLIF(p_payload->>'week_number', '')::integer,
      format_value, format_config_value,
      p_league_id, league_row.location_id
    ) RETURNING id INTO event_id_value;
  ELSE
    SELECT to_jsonb(e) INTO before_row FROM public.events e
     WHERE id = p_event_id AND league_id = p_league_id AND location_id = league_row.location_id FOR UPDATE;
    IF before_row IS NULL THEN RAISE EXCEPTION 'Event not found in league'; END IF;
    IF before_row->>'status' = 'closed' AND requested_status <> 'closed' THEN
      RAISE EXCEPTION 'Published events are immutable';
    END IF;
    format_value := COALESCE(NULLIF(p_payload->>'format', ''), before_row->>'format');
    format_config_value := COALESCE(p_payload->'format_config', before_row->'format_config');
    IF before_row->>'status' = 'closed' AND
       (format_value IS DISTINCT FROM before_row->>'format' OR
        format_config_value IS DISTINCT FROM before_row->'format_config') THEN
      RAISE EXCEPTION 'The format of a published event cannot change';
    END IF;
    PERFORM public.validate_format_config(format_value, format_config_value);
    event_id_value := p_event_id;
    UPDATE public.events SET
      name = trim(p_payload->>'name'),
      start_date = NULLIF(p_payload->>'start_date', '')::date,
      end_date = NULLIF(p_payload->>'end_date', '')::date,
      status = requested_status,
      notes = NULLIF(trim(p_payload->>'notes'), ''),
      course_id = NULLIF(p_payload->>'course_id', '')::uuid,
      hole_event_hole = NULLIF(p_payload->>'hole_event_hole', '')::integer,
      hole_event_name = NULLIF(trim(p_payload->>'hole_event_name'), ''),
      is_bye = COALESCE((p_payload->>'is_bye')::boolean, false),
      week_number = COALESCE(NULLIF(p_payload->>'week_number', '')::integer, week_number),
      format = format_value,
      format_config = format_config_value
    WHERE id = event_id_value;
  END IF;
  PERFORM public.write_audit_event(
    league_row.location_id,
    CASE WHEN p_event_id IS NULL THEN 'event.create' ELSE 'event.update' END,
    'events', event_id_value, before_row,
    (SELECT to_jsonb(e) FROM public.events e WHERE e.id = event_id_value)
  );
  RETURN event_id_value;
END;
$$;

COMMIT;

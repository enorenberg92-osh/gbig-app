-- Phase 3.4: standings v2 support.
-- league_config.segments — validated [{name, start_week, end_week}] ranges for
-- per-segment standings/winners. admin_upsert_event learns is_playoff so
-- playoff events can be flagged from the schedule UI (bracket = matchups on
-- playoff events; seeding via admin_set_matchups).

BEGIN;

CREATE OR REPLACE FUNCTION public.segments_valid(p_segments JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE seg JSONB;
BEGIN
  IF p_segments IS NULL THEN RETURN true; END IF;
  IF jsonb_typeof(p_segments) <> 'array' THEN RETURN false; END IF;
  FOR seg IN SELECT value FROM jsonb_array_elements(p_segments)
  LOOP
    IF jsonb_typeof(seg) <> 'object'
       OR COALESCE(trim(seg->>'name'), '') = ''
       OR (seg->>'start_week')::integer IS NULL
       OR (seg->>'end_week')::integer IS NULL
       OR (seg->>'start_week')::integer < 1
       OR (seg->>'end_week')::integer < (seg->>'start_week')::integer THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END;
$$;

ALTER TABLE public.league_config
  ADD COLUMN IF NOT EXISTS segments JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.league_config'::regclass AND conname = 'league_segments_valid'
  ) THEN
    ALTER TABLE public.league_config
      ADD CONSTRAINT league_segments_valid CHECK (public.segments_valid(segments));
  END IF;
END $$;

-- admin_upsert_event: add is_playoff passthrough (body otherwise unchanged
-- from 202607180002).
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
      hole_event_name, is_bye, is_playoff, week_number, format, format_config, league_id, location_id
    ) VALUES (
      trim(p_payload->>'name'), NULLIF(p_payload->>'start_date', '')::date,
      NULLIF(p_payload->>'end_date', '')::date, requested_status,
      NULLIF(trim(p_payload->>'notes'), ''), NULLIF(p_payload->>'course_id', '')::uuid,
      NULLIF(p_payload->>'hole_event_hole', '')::integer,
      NULLIF(trim(p_payload->>'hole_event_name'), ''),
      COALESCE((p_payload->>'is_bye')::boolean, false),
      COALESCE((p_payload->>'is_playoff')::boolean, false),
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
      is_playoff = COALESCE((p_payload->>'is_playoff')::boolean, is_playoff),
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

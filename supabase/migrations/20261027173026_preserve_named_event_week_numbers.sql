-- Schedule's manual event form can send week_number = null for "Week 2".
-- Numeric order, the score-entry label, and publish_week all require this value.
BEGIN;

CREATE OR REPLACE FUNCTION public.preserve_named_event_week_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.week_number IS NULL THEN
    IF TG_OP = 'UPDATE' AND OLD.week_number IS NOT NULL THEN
      NEW.week_number := OLD.week_number;
    ELSE
      -- Infer only an explicit Week N prefix, never arbitrary event dates/names.
      NEW.week_number := substring(NEW.name FROM
        '(?i)^[[:space:]]*week[[:space:]]+([1-9][0-9]{0,3})(?:[[:space:]:–—-]|$)')::integer;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.preserve_named_event_week_number() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS events_preserve_week_number ON public.events;
CREATE TRIGGER events_preserve_week_number
BEFORE INSERT OR UPDATE OF name, week_number ON public.events
FOR EACH ROW EXECUTE FUNCTION public.preserve_named_event_week_number();

-- Repair the working season without changing statuses, dates, or score records.
UPDATE public.events e
SET week_number = substring(e.name FROM
  '(?i)^[[:space:]]*week[[:space:]]+([1-9][0-9]{0,3})(?:[[:space:]:–—-]|$)')::integer
WHERE e.week_number IS NULL
  AND e.name ~* '^[[:space:]]*week[[:space:]]+[1-9][0-9]{0,3}([[:space:]:–—-]|$)'
  AND EXISTS (
    SELECT 1 FROM public.league_config l
    WHERE l.id = e.league_id AND l.location_id = e.location_id AND l.is_working
  );

COMMIT;

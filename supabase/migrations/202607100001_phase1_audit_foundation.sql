-- Phase 1 / apply first: audit foundation used by every mutation RPC below.
-- File-only migration. Do not apply this from the client application.

CREATE TABLE IF NOT EXISTS public.audit_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID,
  location_id UUID NOT NULL REFERENCES public.locations(id),
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   UUID,
  before_data JSONB,
  after_data  JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_location_created
  ON public.audit_events(location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_events_entity
  ON public.audit_events(entity, entity_id, created_at DESC);

COMMENT ON TABLE public.audit_events IS
  'Append-only mutation audit trail. Retain approximately 24 months; call purge_expired_audit_events from a trusted scheduled job.';

CREATE OR REPLACE FUNCTION public.redact_audit_payload(payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  result JSONB;
BEGIN
  IF payload IS NULL THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(payload) = 'object' THEN
    SELECT COALESCE(
      jsonb_object_agg(
        key,
        CASE
          WHEN lower(key) IN (
            'email', 'phone', 'sub_email', 'sub_phone', 'password',
            'league_password', 'access_token', 'refresh_token', 'secret'
          ) OR lower(key) LIKE '%password%'
            OR lower(key) LIKE '%secret%'
            OR lower(key) LIKE '%token%'
          THEN '"[REDACTED]"'::jsonb
          ELSE public.redact_audit_payload(value)
        END
      ),
      '{}'::jsonb
    ) INTO result
    FROM jsonb_each(payload);
    RETURN result;
  END IF;

  IF jsonb_typeof(payload) = 'array' THEN
    SELECT COALESCE(jsonb_agg(public.redact_audit_payload(value)), '[]'::jsonb)
      INTO result
      FROM jsonb_array_elements(payload);
    RETURN result;
  END IF;

  RETURN payload;
END;
$$;

CREATE OR REPLACE FUNCTION public.write_audit_event(
  p_location_id UUID,
  p_action TEXT,
  p_entity TEXT,
  p_entity_id UUID DEFAULT NULL,
  p_before JSONB DEFAULT NULL,
  p_after JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  audit_id UUID;
BEGIN
  INSERT INTO public.audit_events (
    actor_id, location_id, action, entity, entity_id, before_data, after_data
  ) VALUES (
    auth.uid(), p_location_id, p_action, p_entity, p_entity_id,
    public.redact_audit_payload(p_before),
    public.redact_audit_payload(p_after)
  )
  RETURNING id INTO audit_id;
  RETURN audit_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.purge_expired_audit_events()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count BIGINT;
BEGIN
  DELETE FROM public.audit_events
   WHERE created_at < now() - INTERVAL '24 months';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

ALTER TABLE public.audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "audit_events: location admins read" ON public.audit_events;
CREATE POLICY "audit_events: location admins read" ON public.audit_events
  FOR SELECT TO authenticated
  USING (public.is_admin_of_location(location_id));

-- RPCs may write through the SECURITY DEFINER helper; clients cannot forge audit rows.
REVOKE ALL ON public.audit_events FROM anon, authenticated;
GRANT SELECT ON public.audit_events TO authenticated;
REVOKE ALL ON FUNCTION public.redact_audit_payload(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.write_audit_event(UUID, TEXT, TEXT, UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_expired_audit_events() FROM PUBLIC, anon, authenticated;


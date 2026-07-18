-- Smoke-test finding (pre-Phase 3): legacy public policies on push_subscriptions
-- ("Anyone can subscribe" / "Anyone can unsubscribe" / "Service role reads", all
-- roles=public) let anonymous clients SELECT every row — leaking endpoint,
-- p256dh, and auth_key for every subscriber — and DELETE the whole table.
-- Phase 1 added the scoped authenticated policy but never dropped these.
--
-- Constraint: /alerts is reachable pre-auth, so anonymous subscribe/unsubscribe
-- must keep working. Direct anon upsert can't work without table SELECT (ON
-- CONFLICT DO UPDATE requires it), which would leak the keys — so the write
-- path moves into security-definer RPCs per the Phase 1 hardening template.
-- The endpoint URL is the capability: only the subscribing browser knows it.

BEGIN;

DROP POLICY IF EXISTS "Anyone can subscribe"   ON public.push_subscriptions;
DROP POLICY IF EXISTS "Anyone can unsubscribe" ON public.push_subscriptions;
DROP POLICY IF EXISTS "Service role reads"     ON public.push_subscriptions;
-- Interim policies from the first cut of this fix, if present.
DROP POLICY IF EXISTS "push_subscriptions: anon subscribe"            ON public.push_subscriptions;
DROP POLICY IF EXISTS "push_subscriptions: anon upsert"               ON public.push_subscriptions;
DROP POLICY IF EXISTS "push_subscriptions: anon unsubscribe"          ON public.push_subscriptions;
DROP POLICY IF EXISTS "push_subscriptions: anon conflict visibility"  ON public.push_subscriptions;

REVOKE ALL ON public.push_subscriptions FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON public.push_subscriptions FROM authenticated;
-- Location members (incl. admin sub count) keep the Phase 1 scoped FOR ALL policy.

CREATE OR REPLACE FUNCTION public.subscribe_push(
  p_endpoint TEXT, p_p256dh TEXT, p_auth_key TEXT, p_location_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(p_endpoint, '') = '' OR coalesce(p_p256dh, '') = '' OR coalesce(p_auth_key, '') = '' THEN
    RAISE EXCEPTION 'endpoint, p256dh and auth_key are required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.locations WHERE id = p_location_id) THEN
    RAISE EXCEPTION 'unknown location';
  END IF;
  INSERT INTO public.push_subscriptions (endpoint, p256dh, auth_key, user_id, location_id)
  VALUES (p_endpoint, p_p256dh, p_auth_key, auth.uid(), p_location_id)
  ON CONFLICT (endpoint) DO UPDATE
    SET p256dh      = excluded.p256dh,
        auth_key    = excluded.auth_key,
        user_id     = excluded.user_id,
        location_id = excluded.location_id;
END $$;

CREATE OR REPLACE FUNCTION public.unsubscribe_push(p_endpoint TEXT) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM public.push_subscriptions WHERE endpoint = p_endpoint;
END $$;

REVOKE ALL ON FUNCTION public.subscribe_push(TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.unsubscribe_push(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.subscribe_push(TEXT, TEXT, TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.unsubscribe_push(TEXT) TO anon, authenticated;

COMMIT;

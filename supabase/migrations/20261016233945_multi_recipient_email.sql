BEGIN;

ALTER TABLE public.weekly_email_campaigns DROP CONSTRAINT weekly_email_campaigns_check;
ALTER TABLE public.weekly_email_campaigns ADD CONSTRAINT weekly_email_campaigns_check CHECK (
  (mode = 'league' AND event_id IS NOT NULL AND league_id IS NOT NULL AND compose_id IS NULL)
  OR (mode = 'direct' AND event_id IS NULL AND league_id IS NULL AND compose_id IS NOT NULL
      AND jsonb_array_length(recipients) BETWEEN 1 AND 50)
);

ALTER TABLE public.weekly_email_direct_quota
  ADD COLUMN recipient_count smallint NOT NULL DEFAULT 1 CHECK (recipient_count BETWEEN 1 AND 50);

-- All writers, including an older deployed function, are charged the size of
-- the saved campaign. One transaction lock per user/venue/day prevents races.
CREATE FUNCTION public.enforce_direct_email_allowance() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
  audience_size integer;
  used integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    NEW.quota_day::text || ':' || NEW.location_id::text || ':' || NEW.user_id::text, 0));
  -- Let the existing unique constraint handle repeated reservation attempts.
  IF EXISTS (SELECT 1 FROM public.weekly_email_direct_quota q WHERE q.quota_day=NEW.quota_day
      AND q.location_id=NEW.location_id AND q.user_id=NEW.user_id AND q.campaign_id=NEW.campaign_id) THEN
    RETURN NEW;
  END IF;
  SELECT pg_catalog.jsonb_array_length(c.recipients) INTO audience_size
    FROM public.weekly_email_campaigns c WHERE c.id=NEW.campaign_id AND c.mode='direct'
      AND c.location_id=NEW.location_id AND c.created_by=NEW.user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'DIRECT_EMAIL_CAMPAIGN_NOT_FOUND'; END IF;
  SELECT COALESCE(SUM(q.recipient_count),0) INTO used FROM public.weekly_email_direct_quota q
    WHERE q.quota_day=NEW.quota_day AND q.location_id=NEW.location_id AND q.user_id=NEW.user_id;
  IF used + audience_size > 50 THEN RAISE EXCEPTION 'DIRECT_EMAIL_DAILY_LIMIT'; END IF;
  NEW.recipient_count := audience_size;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.enforce_direct_email_allowance() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_direct_email_allowance() TO service_role;
CREATE TRIGGER weekly_email_direct_recipient_allowance BEFORE INSERT ON public.weekly_email_direct_quota
  FOR EACH ROW EXECUTE FUNCTION public.enforce_direct_email_allowance();

COMMENT ON TABLE public.weekly_email_direct_quota IS 'Private atomic 50-recipient daily direct-email allowance per user and venue. Each campaign reserves its entire saved audience before any provider send.';
COMMENT ON TABLE public.weekly_email_campaigns IS 'Private saved emails through the verified venue-admin endpoint. Direct campaigns have 1–50 explicit recipients receiving separate private copies; league campaigns use the scoped roster.';
COMMIT;

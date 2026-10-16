BEGIN;
ALTER TABLE public.weekly_email_campaigns DROP CONSTRAINT weekly_email_campaigns_check;
ALTER TABLE public.weekly_email_campaigns ADD CONSTRAINT weekly_email_campaigns_check CHECK (
  (mode = 'league' AND event_id IS NOT NULL AND league_id IS NOT NULL AND compose_id IS NULL)
  OR (mode = 'direct' AND event_id IS NULL AND league_id IS NULL AND compose_id IS NOT NULL
      AND jsonb_array_length(recipients) BETWEEN 1 AND 1000)
);
ALTER TABLE public.weekly_email_campaigns DROP CONSTRAINT weekly_email_campaigns_recipients_check;
ALTER TABLE public.weekly_email_campaigns ADD CONSTRAINT weekly_email_campaigns_recipients_check CHECK (
  jsonb_typeof(recipients) = 'array' AND jsonb_array_length(recipients) BETWEEN 1 AND 1000
);

-- Keep the historical allowance ledger, but retire the app's 50/day restriction.
REVOKE INSERT ON public.weekly_email_direct_quota FROM service_role;
COMMENT ON TABLE public.weekly_email_direct_quota IS 'Historical direct-send allowance reservations. Retired: current email delivery follows Google mailbox quotas without an app daily cap.';
COMMENT ON TABLE public.weekly_email_campaigns IS 'Private saved emails. Direct campaigns support 1–1000 explicit private copies at any time, independently of rounds. Only the authenticated venue-admin Edge Function accesses campaigns.';

-- Serialize batches across every campaign/user using the same Gmail sender,
-- so two browser sessions cannot multiply the mailbox sending pace.
CREATE FUNCTION public.claim_email_send_batch(target_campaign uuid, expected_location uuid, expected_creator uuid, claim_token uuid)
RETURNS SETOF public.weekly_email_campaigns
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' ROWS 1 AS $$
DECLARE mailbox_sender uuid;
BEGIN
  SELECT c.sender_id INTO mailbox_sender FROM public.weekly_email_campaigns c
    WHERE c.id=target_campaign AND c.location_id=expected_location
      AND (expected_creator IS NULL OR c.created_by=expected_creator);
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('email-sender:' || mailbox_sender::text,0));
  RETURN QUERY UPDATE public.weekly_email_campaigns c
    SET lease_token=claim_token, lease_until=pg_catalog.clock_timestamp()+interval '3 minutes',
        started_at=COALESCE(c.started_at,pg_catalog.clock_timestamp())
    WHERE c.id=target_campaign AND c.location_id=expected_location AND c.sender_id=mailbox_sender
      AND (expected_creator IS NULL OR c.created_by=expected_creator)
      AND (c.lease_until IS NULL OR c.lease_until<pg_catalog.clock_timestamp())
      AND NOT EXISTS (SELECT 1 FROM public.weekly_email_campaigns other
        WHERE other.sender_id=mailbox_sender AND other.id<>c.id
          AND other.lease_until>=pg_catalog.clock_timestamp())
    RETURNING c.*;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_email_send_batch(uuid,uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_email_send_batch(uuid,uuid,uuid,uuid) TO service_role;
CREATE INDEX weekly_email_sender_leases ON public.weekly_email_campaigns(sender_id,lease_until) WHERE lease_until IS NOT NULL;

-- Heartbeats share the sender lock with claims and cannot revive an expired
-- batch. A worker that lost its lease must stop before its next provider call.
CREATE FUNCTION public.save_email_send_progress(target_campaign uuid,claim_token uuid,new_recipients jsonb,new_error text)
RETURNS TABLE(id uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' ROWS 1 AS $$
DECLARE mailbox_sender uuid;
BEGIN
  SELECT c.sender_id INTO mailbox_sender FROM public.weekly_email_campaigns c WHERE c.id=target_campaign;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('email-sender:' || mailbox_sender::text,0));
  RETURN QUERY UPDATE public.weekly_email_campaigns c
    SET recipients=new_recipients,last_error=new_error,lease_until=pg_catalog.clock_timestamp()+interval '3 minutes'
    WHERE c.id=target_campaign AND c.lease_token=claim_token AND c.lease_until>pg_catalog.clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM public.weekly_email_campaigns other
        WHERE other.sender_id=mailbox_sender AND other.id<>c.id
          AND other.lease_until>=pg_catalog.clock_timestamp())
    RETURNING c.id;
END;
$$;
REVOKE ALL ON FUNCTION public.save_email_send_progress(uuid,uuid,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_email_send_progress(uuid,uuid,jsonb,text) TO service_role;

CREATE FUNCTION public.list_email_history(expected_location uuid,expected_creator uuid)
RETURNS TABLE(compose_id uuid,subject text,created_at timestamptz,recipient_count integer,accepted_count integer,review_count integer,pending_count integer)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT c.compose_id,c.subject,c.created_at,pg_catalog.jsonb_array_length(c.recipients),
    counts.accepted::integer,counts.review::integer,
    (pg_catalog.jsonb_array_length(c.recipients)-counts.accepted-counts.review)::integer
  FROM public.weekly_email_campaigns c
  CROSS JOIN LATERAL (SELECT count(*) FILTER(WHERE item->>'status'='accepted') AS accepted,
    count(*) FILTER(WHERE item->>'status'='review') AS review
    FROM pg_catalog.jsonb_array_elements(c.recipients) item) counts
  WHERE c.mode='direct' AND c.location_id=expected_location AND c.created_by=expected_creator
  ORDER BY c.created_at DESC,c.id DESC LIMIT 100;
$$;
REVOKE ALL ON FUNCTION public.list_email_history(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.list_email_history(uuid,uuid) TO service_role;
COMMIT;

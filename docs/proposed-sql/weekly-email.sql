-- REVIEW ONLY. Not applied. Generate a migration with `supabase migration new weekly_email`
-- after owner approval, then copy this SQL into that generated file.
BEGIN;
CREATE TABLE public.weekly_email_senders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 100),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254),
  reply_to text NOT NULL CHECK (char_length(reply_to) BETWEEN 3 AND 254),
  is_default boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT false,
  UNIQUE(location_id, email),
  UNIQUE(location_id, id)
);
CREATE UNIQUE INDEX weekly_email_one_default_per_location
  ON public.weekly_email_senders(location_id) WHERE is_default;
CREATE TABLE public.weekly_email_sender_users (
  sender_id uuid NOT NULL REFERENCES public.weekly_email_senders(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  PRIMARY KEY(sender_id, user_id)
);
ALTER TABLE public.weekly_email_senders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weekly_email_sender_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.weekly_email_senders, public.weekly_email_sender_users FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.weekly_email_senders, public.weekly_email_sender_users TO service_role;
COMMENT ON TABLE public.weekly_email_sender_users IS 'Owner-managed sender assignments; endpoint also requires current venue-admin authority. No automatic cross-venue permission.';

-- Exact initial defaults requested by owner. Disabled until provider/domain review
-- and explicit staff assignment. No email address implies an app account identity.
INSERT INTO public.weekly_email_senders(location_id, display_name, email, reply_to, is_default)
SELECT id, 'Trent', 'trent@greenbayindoorgolf.com', 'trent@greenbayindoorgolf.com', true
FROM public.locations WHERE slug = 'gbig';
INSERT INTO public.weekly_email_senders(location_id, display_name, email, reply_to, is_default)
SELECT id, 'Jordan', 'jordan@appletonindoorgolf.com', 'jordan@appletonindoorgolf.com', true
FROM public.locations WHERE slug = 'appleton';

CREATE TABLE public.weekly_email_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL CHECK (mode IN ('league', 'direct')),
  compose_id uuid UNIQUE,
  event_id uuid UNIQUE REFERENCES public.events(id),
  location_id uuid NOT NULL REFERENCES public.locations(id),
  league_id uuid REFERENCES public.league_config(id),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  sender_id uuid NOT NULL,
  sender text NOT NULL,
  reply_to text NOT NULL,
  FOREIGN KEY(location_id, sender_id) REFERENCES public.weekly_email_senders(location_id, id),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  recipients jsonb NOT NULL CHECK (jsonb_typeof(recipients) = 'array' AND jsonb_array_length(recipients) BETWEEN 1 AND 500),
  missing_count integer NOT NULL DEFAULT 0 CHECK (missing_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  CHECK ((mode = 'league' AND event_id IS NOT NULL AND league_id IS NOT NULL AND compose_id IS NULL)
      OR (mode = 'direct' AND event_id IS NULL AND league_id IS NULL AND compose_id IS NOT NULL AND jsonb_array_length(recipients) = 1))
);
CREATE INDEX weekly_email_direct_history ON public.weekly_email_campaigns(location_id, created_by, created_at DESC) WHERE mode = 'direct';
ALTER TABLE public.weekly_email_campaigns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.weekly_email_campaigns FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.weekly_email_campaigns TO service_role;
COMMENT ON TABLE public.weekly_email_campaigns IS 'Private immutable-after-send weekly emails; access only through venue-admin-verified weekly-email Edge Function. One league campaign per round; direct campaigns use a unique compose key and one explicit recipient.';
-- No campaign FK: a reserved but unstarted preview may be replaced. Its slot
-- remains consumed conservatively until the UTC day ends.
CREATE TABLE public.weekly_email_direct_quota (
  quota_day date NOT NULL,
  location_id uuid NOT NULL REFERENCES public.locations(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  slot smallint NOT NULL CHECK (slot >= 0 AND slot < 50),
  campaign_id uuid NOT NULL,
  PRIMARY KEY(quota_day, location_id, user_id, slot),
  UNIQUE(quota_day, location_id, user_id, campaign_id)
);
ALTER TABLE public.weekly_email_direct_quota ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.weekly_email_direct_quota FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.weekly_email_direct_quota TO service_role;
COMMENT ON TABLE public.weekly_email_direct_quota IS 'Atomic 50-new-direct-send-attempt allowance per user and venue per UTC day. No client access or quota-reset endpoint.';
COMMIT;

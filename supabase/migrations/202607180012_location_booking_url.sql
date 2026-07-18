-- Per-location booking URL: the Reservations iframe pointed every location at
-- GBIG's WordPress booking page (build-wide env var). The URL now lives on the
-- location row and rides the public boot payload.

BEGIN;

ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS booking_url TEXT;

UPDATE public.locations SET booking_url = 'https://greenbayindoorgolf.com/app-page-booking/'
 WHERE slug = 'gbig' AND booking_url IS NULL;

DROP VIEW IF EXISTS public.location_public;
CREATE VIEW public.location_public
WITH (security_invoker = false, security_barrier = true)
AS
SELECT id, slug, name, primary_color, logo_url, logo_icon_url, timezone, booking_url
  FROM public.locations;

REVOKE ALL ON public.location_public FROM PUBLIC;
GRANT SELECT ON public.location_public TO anon, authenticated;

COMMENT ON VIEW public.location_public IS
  'Public-safe location resolver for pre-authentication branding and timezone boot.';

COMMIT;

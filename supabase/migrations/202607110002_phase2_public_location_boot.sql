-- Phase 2 item 14: anonymous-safe hostname boot data.

DROP VIEW IF EXISTS public.location_public;
CREATE VIEW public.location_public
WITH (security_invoker = false, security_barrier = true)
AS
SELECT id, slug, name, primary_color, logo_url, logo_icon_url, timezone
FROM public.locations;

REVOKE ALL ON public.location_public FROM PUBLIC;
GRANT SELECT ON public.location_public TO anon, authenticated;

COMMENT ON VIEW public.location_public IS
  'Public-safe location resolver for pre-authentication branding and timezone boot.';


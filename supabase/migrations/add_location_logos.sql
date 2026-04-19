-- =============================================================================
-- Migration: Add logo URL columns to locations
-- =============================================================================
-- Lets each location point at its own white-wordmark (splash + login) and
-- small-icon (in-app header) logo without rebuilding the bundle. Stored as
-- TEXT so we can keep files anywhere -- Supabase Storage, Vercel /public,
-- or an external CDN.
--
-- Nullable on purpose: if the row has no value the app falls back to the
-- /public/logo-full-white.png and /public/logo-icon-white.png files that
-- ship with the build. That means GBIG keeps working untouched until we
-- backfill, and new locations can be onboarded with a single UPDATE.
-- =============================================================================

ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS logo_url      TEXT,
  ADD COLUMN IF NOT EXISTS logo_icon_url TEXT;

COMMENT ON COLUMN public.locations.logo_url
  IS 'URL to the full white wordmark logo (splash screen + login). Falls back to /logo-full-white.png.';
COMMENT ON COLUMN public.locations.logo_icon_url
  IS 'URL to the small white icon logo (in-app header). Falls back to /logo-icon-white.png.';

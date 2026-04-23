-- ============================================================
--  Add capacity to app_events + create event_signups table.
--
--  Why: Events (tournaments, socials, clinics) now support player
--  RSVPs. Each event has an optional capacity (nullable = unlimited),
--  and signups are tracked in a dedicated join table with unique
--  (event_id, player_id) so a player can only sign up once per event.
--
--  Safe to re-run — all statements use IF NOT EXISTS / IF EXISTS.
-- ============================================================

-- ── 1. capacity column on app_events ────────────────────────────────────────
-- Nullable INT. NULL = unlimited capacity. Non-negative check so a value
-- can't accidentally be stored as negative.
ALTER TABLE public.app_events
  ADD COLUMN IF NOT EXISTS capacity INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'app_events_capacity_nonneg'
      AND conrelid = 'public.app_events'::regclass
  ) THEN
    ALTER TABLE public.app_events
      ADD CONSTRAINT app_events_capacity_nonneg
      CHECK (capacity IS NULL OR capacity >= 0);
  END IF;
END $$;

-- ── 2. event_signups table ──────────────────────────────────────────────────
-- One row per (event, player). location_id is copied in to keep the RLS
-- policy consistent with every other tenant-scoped table. We also enforce
-- ON DELETE CASCADE from app_events so deleting an event cleans up its
-- signups automatically.
CREATE TABLE IF NOT EXISTS public.event_signups (
  id          UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID      NOT NULL REFERENCES public.app_events(id) ON DELETE CASCADE,
  player_id   UUID      NOT NULL REFERENCES public.players(id)    ON DELETE CASCADE,
  location_id UUID      NOT NULL REFERENCES public.locations(id)  ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_event_signups_event    ON public.event_signups(event_id);
CREATE INDEX IF NOT EXISTS idx_event_signups_player   ON public.event_signups(player_id);
CREATE INDEX IF NOT EXISTS idx_event_signups_location ON public.event_signups(location_id);

-- ── 3. RLS — match the tenant-scoped pattern used for app_events itself ─────
ALTER TABLE public.event_signups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "event_signups: location members all" ON public.event_signups;
CREATE POLICY "event_signups: location members all" ON public.event_signups
  FOR ALL TO authenticated
  USING (public.is_in_location(location_id))
  WITH CHECK (public.is_in_location(location_id));

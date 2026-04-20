-- =============================================================================
-- Migration: Data-model cleanup (ecosystem-wide social)
-- =============================================================================
-- Philosophy: league data (scores, events, handicaps, teams) lives inside a
-- location. The social graph (players, follows, messages) lives across the
-- whole ecosystem -- a GBIG member can follow a friend who plays at the
-- Appleton location, watch a star player from another club, or DM a friend
-- who travels between locations. So we deliberately do NOT add location_id
-- to follows/messages. Instead we loosen the players SELECT policy to allow
-- any authenticated user to read any player row, while keeping writes
-- location-locked. That's the cleanest line.
--
-- This migration:
--   1. Adds `locations.timezone` so close-week dates, event labels, and
--      anything else time-of-day sensitive can be evaluated in the league's
--      home zone rather than the admin's browser zone. Column exists now,
--      application code will consume it in a follow-up pass.
--
--   2. Splits the `players` RLS policies: SELECT is open to any authenticated
--      user across the ecosystem; INSERT / UPDATE / DELETE remain restricted
--      to members of the player's own location via is_in_location().
--      This enables cross-location follow + DM without weakening write safety.
--
--   3. Leaves follows + messages RLS as-is (identity-based only -- the
--      follower / sender must be the authenticated user, and that's enough).
--
-- Idempotent: every ALTER / CREATE POLICY is guarded. Safe to re-run.
-- =============================================================================


-- ── 1. locations.timezone ─────────────────────────────────────────────────
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Chicago';

COMMENT ON COLUMN public.locations.timezone
  IS 'IANA timezone for this location (e.g. America/Chicago). Used for week-start, close-week, and event date rendering.';


-- ── 2. players: split SELECT (ecosystem) from writes (location-locked) ────
-- The old "players: location members all" policy (created in enable_rls_phase1.sql
-- via the scoped_tables DO block) covered ALL commands with is_in_location,
-- which made player rows invisible across locations. Replace it with two
-- policies: ecosystem-wide SELECT, same-location writes.
DROP POLICY IF EXISTS "players: location members all"              ON public.players;
DROP POLICY IF EXISTS "players: read anyone in ecosystem"          ON public.players;
DROP POLICY IF EXISTS "players: write same location"               ON public.players;

-- Any authenticated user can read any player in the ecosystem. This is what
-- powers cross-location search, follow, and DM. Player rows are deliberately
-- low-sensitivity (name, handicap, avatar). No emails, phone numbers, or
-- anything private is exposed by the `players` table.
CREATE POLICY "players: read anyone in ecosystem" ON public.players
  FOR SELECT TO authenticated
  USING (true);

-- Writes (insert/update/delete) still require the actor to be a member of
-- the row's location. An admin at GBIG cannot edit a player row at Appleton,
-- and a player can only be created in a location the actor belongs to.
CREATE POLICY "players: write same location" ON public.players
  FOR ALL TO authenticated
  USING (public.is_in_location(location_id))
  WITH CHECK (public.is_in_location(location_id));


-- ── 3. follows + messages: deliberately left unchanged ────────────────────
-- The existing identity-only policies from enable_rls_phase1.sql are the
-- correct shape for ecosystem-wide social:
--   - follows INSERT: follower must be the authenticated user
--   - messages INSERT: sender must be the authenticated user
-- Both are already in place; no changes needed here.


-- ── 4. Verify (run these after the migration) ─────────────────────────────
--    Confirm the new policies are active and the old combined policy is gone:
--
--    SELECT policyname, cmd FROM pg_policies
--    WHERE tablename = 'players' AND schemaname = 'public'
--    ORDER BY policyname;
--
--    Expected rows:
--      players: read anyone in ecosystem   SELECT
--      players: write same location        ALL
--
--    Smoke test cross-location read as a regular user (not service role):
--
--    SELECT id, name, location_id FROM players
--    WHERE location_id <> '<your VITE_LOCATION_ID>'
--    LIMIT 3;
--
--    Before this migration: 0 rows. After: up to 3 rows from other locations.

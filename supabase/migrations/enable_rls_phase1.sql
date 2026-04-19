-- ============================================================
--  Phase 1: Row Level Security (RLS) enforcement
--
--  Goal: make it IMPOSSIBLE for the client to read or write data
--  from a location other than its own, as a defense-in-depth
--  backstop on top of the `.eq('location_id', locationId)`
--  filters the app code already applies.
--
--  Scope of this migration (v1 — "location boundary strict,
--  within-location loose"):
--    - Tight: cross-location reads/writes blocked everywhere.
--    - Loose: within a location, any authenticated member can
--      read and write tenant-scoped tables. Role separation
--      (admin vs regular user) remains enforced by the app layer
--      and the Edge Functions, as it is today.
--
--  Follow-up work (future migration, not tonight):
--    - Tighten writes on players/scores/news_posts/etc. so that
--      only admins or the row's owner can modify.
--    - Add row-ownership policies for PlayerProfile self-update
--      once we've audited every edit path in the app.
--
--  Edge Functions use the service role key, which BYPASSES RLS
--  entirely. send-alert, send-social-push, create-player-account
--  continue to work exactly as they do now — their caller auth
--  is enforced inside each function.
--
--  Safe to re-run (every CREATE/ALTER guarded or idempotent).
-- ============================================================

-- ── 1. Helper functions ─────────────────────────────────────────────────────
-- SECURITY DEFINER so they run with elevated privileges and
-- don't trigger recursive RLS checks when called from policies.

CREATE OR REPLACE FUNCTION public.is_admin_of_location(target_loc UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM location_admins
    WHERE user_id = auth.uid() AND location_id = target_loc
  );
$$;

CREATE OR REPLACE FUNCTION public.is_in_location(target_loc UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM location_admins
    WHERE user_id = auth.uid() AND location_id = target_loc
  ) OR EXISTS (
    SELECT 1 FROM players
    WHERE user_id = auth.uid() AND location_id = target_loc
  );
$$;

-- ── 2. Tenant-scoped tables (have location_id) ──────────────────────────────
-- Policy pattern for every one of these: ALL actions require
-- the caller to be in the row's location.

-- Generic helper DO block: enable RLS + create ALL-policy for each scoped table.
-- If a policy with the same name already exists, we drop-and-recreate.

DO $$
DECLARE
  t TEXT;
  scoped_tables TEXT[] := ARRAY[
    'players', 'teams', 'events', 'scores', 'league_config',
    'courses', 'news_posts', 'alerts', 'push_subscriptions',
    'subs', 'handicap_history', 'app_events'
  ];
BEGIN
  FOREACH t IN ARRAY scoped_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "%s: location members all" ON public.%I', t, t);
    EXECUTE format(
      'CREATE POLICY "%s: location members all" ON public.%I '
      'FOR ALL TO authenticated '
      'USING (public.is_in_location(location_id)) '
      'WITH CHECK (public.is_in_location(location_id))',
      t, t
    );
  END LOOP;
END $$;

-- ── 3. locations table ──────────────────────────────────────────────────────
-- Authenticated users can SELECT all rows (it's branding/config, small table).
-- No client-side writes — super_admin management comes in Phase 3.

ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "locations: select all authenticated" ON public.locations;
CREATE POLICY "locations: select all authenticated" ON public.locations
  FOR SELECT TO authenticated
  USING (true);

-- (No INSERT/UPDATE/DELETE policies = no client writes allowed.
--  Service role still works for our migrations and admin scripts.)

-- ── 4. location_admins table ────────────────────────────────────────────────
-- Users must be able to SELECT their OWN row (useIsAdmin hook).
-- Everything else blocked at the client tier. Admin promotion happens
-- via a service-role path (future super-admin console).

ALTER TABLE public.location_admins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "location_admins: select own" ON public.location_admins;
CREATE POLICY "location_admins: select own" ON public.location_admins
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- ── 5. Social tables: follows, messages ─────────────────────────────────────
-- These don't have location_id. Gate on sender/recipient identity.
-- Reads: either party. Writes: you can only create rows where YOU are
-- the sender / follower.

-- follows
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "follows: read if involved" ON public.follows;
CREATE POLICY "follows: read if involved" ON public.follows
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM players p WHERE p.id IN (follower_id, following_id) AND p.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "follows: insert own" ON public.follows;
CREATE POLICY "follows: insert own" ON public.follows
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM players p WHERE p.id = follower_id AND p.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "follows: delete own" ON public.follows;
CREATE POLICY "follows: delete own" ON public.follows
  FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM players p WHERE p.id = follower_id AND p.user_id = auth.uid())
  );

-- messages
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "messages: read if involved" ON public.messages;
CREATE POLICY "messages: read if involved" ON public.messages
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM players p WHERE p.id IN (sender_id, recipient_id) AND p.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "messages: send own" ON public.messages;
CREATE POLICY "messages: send own" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (SELECT 1 FROM players p WHERE p.id = sender_id AND p.user_id = auth.uid())
  );

-- ── 6. Legacy / unused tables ───────────────────────────────────────────────
-- `admins` (replaced by location_admins), `leagues`, `skins` — no client
-- code touches these. Enable RLS with no policies = only the service
-- role can read/write. If we discover real usage later, we add policies.

ALTER TABLE public.admins  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leagues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.skins   ENABLE ROW LEVEL SECURITY;

-- ============================================================
--  After running this:
--    1. Refresh the app and log in. Everything should look
--       identical — same data, same admin tab, same permissions.
--    2. If a tab comes up empty or a write fails, copy the
--       Network tab error and we'll adjust the policy.
-- ============================================================

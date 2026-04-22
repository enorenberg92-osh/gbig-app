-- =============================================================================
-- Migration: Super-admin role + ecosystem-wide management policies
-- =============================================================================
-- Introduces a global super-admin concept for operating the whole ecosystem --
-- creating new locations, inviting location admins, editing branding, viewing
-- cross-location state. Distinct from `location_admins` (scoped to one
-- location). A super-admin is the person running the platform (Erich); a
-- location admin runs their own indoor-golf location.
--
-- Why a new table instead of a flag on location_admins: a super-admin is not
-- inherently tied to any location. If we stored the role on location_admins,
-- we'd either have to pick a location to park them under (gross) or have
-- location-less rows (which the UNIQUE (user_id, location_id) constraint
-- forbids). A dedicated `super_admins` table keeps the concepts clean.
--
-- Idempotent: every CREATE / INSERT / DROP+CREATE is guarded. Safe to re-run.
-- =============================================================================


-- ── 1. super_admins table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.super_admins (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.super_admins
  IS 'Users with ecosystem-wide admin powers: create locations, invite location admins, edit branding cross-location. Distinct from location_admins.';

ALTER TABLE public.super_admins ENABLE ROW LEVEL SECURITY;

-- A super-admin can read their own row (needed by the useIsSuperAdmin hook).
-- No client-side writes -- adding/removing super-admins is a privileged op
-- done manually via SQL for now. Future: a super-admin-only RPC.
DROP POLICY IF EXISTS "super_admins: read own" ON public.super_admins;
CREATE POLICY "super_admins: read own" ON public.super_admins
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());


-- ── 2. is_super_admin() helper ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.super_admins
    WHERE user_id = auth.uid()
  );
$$;

COMMENT ON FUNCTION public.is_super_admin()
  IS 'TRUE if the current auth.uid() is an ecosystem super-admin. SECURITY DEFINER so RLS policies can call it without triggering their own recursion.';


-- ── 3. Seed the first super-admin (Erich) ─────────────────────────────────
INSERT INTO public.super_admins (user_id)
VALUES ('acd6c8a3-35e1-4892-a928-0a8996c02d10')
ON CONFLICT (user_id) DO NOTHING;


-- ── 4. locations: add super-admin read/write policies ─────────────────────
-- Existing "locations: select all authenticated" stays -- every signed-in
-- user can read their branding. We're adding INSERT/UPDATE/DELETE for
-- super-admins only; regular clients still can't write.
DROP POLICY IF EXISTS "locations: super admins all"     ON public.locations;
DROP POLICY IF EXISTS "locations: super admins insert"  ON public.locations;
DROP POLICY IF EXISTS "locations: super admins update"  ON public.locations;
DROP POLICY IF EXISTS "locations: super admins delete"  ON public.locations;

-- One ALL policy is cleaner than three separate ones for this table.
CREATE POLICY "locations: super admins all" ON public.locations
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());


-- ── 5. location_admins: let super-admins read + write everything ──────────
-- Existing "location_admins: select own" stays (each user can see their own
-- admin row, needed for useIsAdmin). Add a broader super-admin policy so
-- the console can list every admin across every location, and invite new
-- ones by inserting rows.
DROP POLICY IF EXISTS "location_admins: super admins all" ON public.location_admins;

CREATE POLICY "location_admins: super admins all" ON public.location_admins
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());


-- ── 6. Verify (run these after the migration) ─────────────────────────────
--    Confirm the seed row landed and the helper works:
--
--    SELECT user_id, created_at FROM super_admins;
--    -- Should return one row: acd6c8a3-...
--
--    SELECT public.is_super_admin();
--    -- Returns TRUE when run as the seeded user (e.g. via Supabase dashboard
--    -- while impersonating that user), FALSE otherwise.
--
--    Confirm the new policies are active:
--
--    SELECT policyname, cmd FROM pg_policies
--    WHERE schemaname = 'public'
--      AND policyname LIKE '%super admins%'
--    ORDER BY policyname;
--
--    Expected rows:
--      location_admins: super admins all   ALL
--      locations: super admins all         ALL

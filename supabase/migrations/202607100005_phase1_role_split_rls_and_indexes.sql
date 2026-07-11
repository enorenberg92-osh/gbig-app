-- Phase 1 / apply fifth: role-split RLS cutover and query indexes.
-- RPC-owned invariant tables have no direct client write policy.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_players_name_trgm
  ON public.players USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_players_first_name_trgm
  ON public.players USING gin (first_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_players_last_name_trgm
  ON public.players USING gin (last_name gin_trgm_ops);

-- Remove every historical blanket member policy before installing the split.
DO $$
DECLARE
  table_name TEXT;
  policy_row RECORD;
  scoped_tables TEXT[] := ARRAY[
    'players', 'teams', 'events', 'scores', 'league_config', 'courses',
    'news_posts', 'alerts', 'subs', 'handicap_history', 'app_events',
    'team_memberships', 'score_duplicate_quarantine', 'team_membership_conflicts'
  ];
BEGIN
  FOREACH table_name IN ARRAY scoped_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    FOR policy_row IN
      SELECT policyname FROM pg_policies
       WHERE schemaname = 'public' AND tablename = table_name
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy_row.policyname, table_name);
    END LOOP;
  END LOOP;
END $$;

-- Players are readable only inside the caller's location in Phase 1. Phase 2
-- introduces the cross-location sanitized player_public view.
CREATE POLICY "players: location members read" ON public.players
  FOR SELECT TO authenticated USING (public.is_in_location(location_id));
CREATE POLICY "players: update own profile" ON public.players
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
-- First-login claim: the authenticated email may link only its matching,
-- currently-unclaimed player row to auth.uid().
CREATE POLICY "players: claim own profile" ON public.players
  FOR UPDATE TO authenticated
  USING (
    user_id IS NULL
    AND lower(email) = lower(COALESCE(auth.jwt()->>'email', ''))
  )
  WITH CHECK (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.guard_player_profile_updates()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.player_write', true) = 'on'
     OR current_setting('app.roster_write', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.team_id IS DISTINCT FROM OLD.team_id
     OR NEW.handicap IS DISTINCT FROM OLD.handicap
     OR NEW.handicap_locked IS DISTINCT FROM OLD.handicap_locked
     OR NEW.in_skins IS DISTINCT FROM OLD.in_skins
     OR NEW.is_sub IS DISTINCT FROM OLD.is_sub THEN
    RAISE EXCEPTION 'Protected player fields must be changed by an admin RPC';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS players_guard_profile_updates ON public.players;
CREATE TRIGGER players_guard_profile_updates
  BEFORE UPDATE ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.guard_player_profile_updates();

-- Read-only-to-members, RPC-write-only tables.
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'teams', 'events', 'scores', 'subs', 'handicap_history', 'team_memberships'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_in_location(location_id))',
      table_name || ': location members read', table_name
    );
  END LOOP;
END $$;

-- Admin direct CRUD allowlist. These are settings/content tables without the
-- score, roster, event-status, or audit invariants owned by RPCs.
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'league_config', 'courses', 'news_posts', 'alerts', 'app_events'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_in_location(location_id))',
      table_name || ': location members read', table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_admin_of_location(location_id)) WITH CHECK (public.is_admin_of_location(location_id))',
      table_name || ': location admins write', table_name
    );
  END LOOP;
END $$;

CREATE POLICY "score quarantine: location admins read" ON public.score_duplicate_quarantine
  FOR SELECT TO authenticated USING (public.is_admin_of_location(location_id));
CREATE POLICY "membership conflicts: location admins read" ON public.team_membership_conflicts
  FOR SELECT TO authenticated USING (public.is_admin_of_location(location_id));

-- audit_events was created first and remains append-only from the client.
DROP POLICY IF EXISTS "audit_events: location admins read" ON public.audit_events;
CREATE POLICY "audit_events: location admins read" ON public.audit_events
  FOR SELECT TO authenticated USING (public.is_admin_of_location(location_id));

-- Preserve the existing push-subscription path (explicitly outside this phase)
-- while keeping its location boundary. No push/VAPID code or schema is changed.
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "push_subscriptions: location members all" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions: location members all" ON public.push_subscriptions
  FOR ALL TO authenticated
  USING (public.is_in_location(location_id))
  WITH CHECK (public.is_in_location(location_id));

-- RPC-owned tables: defense in depth at both privilege and RLS layers.
REVOKE INSERT, UPDATE, DELETE ON public.scores FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.events FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.teams FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.team_memberships FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.subs FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.handicap_history FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.audit_events FROM authenticated;

GRANT SELECT ON public.scores, public.events, public.teams, public.team_memberships,
  public.subs, public.handicap_history, public.roster_at TO authenticated;

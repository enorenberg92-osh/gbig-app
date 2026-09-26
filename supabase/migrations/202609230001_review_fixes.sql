-- ============================================================================
-- Pre-season review fixes (2026-09-23)
-- ----------------------------------------------------------------------------
-- Findings from a full-app review. Each section names the bug it fixes.
-- Idempotent: safe to run more than once. Run the whole file in the Supabase
-- SQL editor (it is one transaction).
-- ============================================================================

BEGIN;

-- ── 1. events.is_playoff ─────────────────────────────────────────────────────
-- admin_upsert_event (202607180004) writes is_playoff but no migration ever
-- created the column, so creating/editing any week failed at runtime.
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS is_playoff BOOLEAN NOT NULL DEFAULT false;


-- ── 2. Stop storing login passwords ─────────────────────────────────────────
-- players.league_password held real auth passwords in plaintext and every
-- player at the location could SELECT it. Passwords now live only in Supabase
-- Auth: wipe the column and keep it empty forever. Admin resets go through the
-- create-player-account edge function instead.
CREATE OR REPLACE FUNCTION public.strip_player_password()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.league_password := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS players_strip_password ON public.players;
CREATE TRIGGER players_strip_password
  BEFORE INSERT OR UPDATE ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.strip_player_password();

SELECT set_config('app.player_write', 'on', true);
UPDATE public.players SET league_password = NULL WHERE league_password IS NOT NULL;
SELECT set_config('app.player_write', '', true);

COMMENT ON COLUMN public.players.league_password IS
  'Retired 2026-09: always NULL (trigger players_strip_password). Passwords live only in Supabase Auth.';

-- Players may only change their avatar directly; identity fields (name, email)
-- are admin-managed so nobody can impersonate another member. Edge functions
-- (service role) link accounts and set the email, so they pass through.
CREATE OR REPLACE FUNCTION public.guard_player_profile_updates()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_setting('app.player_write', true) = 'on'
     OR current_setting('app.roster_write', true) = 'on'
     OR current_user = 'service_role' THEN
    RETURN NEW;
  END IF;
  IF NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.team_id IS DISTINCT FROM OLD.team_id
     OR NEW.handicap IS DISTINCT FROM OLD.handicap
     OR NEW.handicap_locked IS DISTINCT FROM OLD.handicap_locked
     OR NEW.in_skins IS DISTINCT FROM OLD.in_skins
     OR NEW.is_sub IS DISTINCT FROM OLD.is_sub
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.first_name IS DISTINCT FROM OLD.first_name
     OR NEW.last_name IS DISTINCT FROM OLD.last_name
     OR lower(NEW.email) IS DISTINCT FROM lower(OLD.email) THEN
    RAISE EXCEPTION 'Protected player fields must be changed by an admin RPC';
  END IF;
  RETURN NEW;
END;
$$;


-- First-login self-claim by email never matched (the update also needs SELECT
-- visibility), and making it work would let any login whose email matches an
-- unclaimed row, at any location, adopt it. create-player-account already
-- links accounts server-side, so the policy is removed.
DROP POLICY IF EXISTS "players: claim own profile" ON public.players;


-- ── 3. Push subscriptions: owners only ──────────────────────────────────────
-- The old FOR ALL location-member policy let any player read every endpoint
-- and key at the location, delete them, or repoint them to themselves.
DROP POLICY IF EXISTS "push_subscriptions: location members all" ON public.push_subscriptions;
DROP POLICY IF EXISTS "push_subscriptions: own rows" ON public.push_subscriptions;
DROP POLICY IF EXISTS "push_subscriptions: admins read" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions: own rows" ON public.push_subscriptions
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
-- Writes go only through subscribe_push/unsubscribe_push (endpoint allowlist);
-- a direct insert/update would bypass it.
REVOKE INSERT, UPDATE ON public.push_subscriptions FROM authenticated;
-- Admins still need the subscriber count on the Alerts screen.
CREATE POLICY "push_subscriptions: admins read" ON public.push_subscriptions
  FOR SELECT TO authenticated
  USING (public.is_admin_of_location(location_id));

-- subscribe_push is callable pre-login, so only accept real push-service
-- endpoints (no arbitrary hosts for the alert fan-out to POST to).
CREATE OR REPLACE FUNCTION public.subscribe_push(
  p_endpoint TEXT, p_p256dh TEXT, p_auth_key TEXT, p_location_id UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF coalesce(p_endpoint, '') = '' OR coalesce(p_p256dh, '') = '' OR coalesce(p_auth_key, '') = '' THEN
    RAISE EXCEPTION 'endpoint, p256dh and auth_key are required';
  END IF;
  IF length(p_endpoint) > 1024 OR length(p_p256dh) > 256 OR length(p_auth_key) > 128 THEN
    RAISE EXCEPTION 'push subscription fields are too long';
  END IF;
  IF p_endpoint !~* '^https://([a-z0-9-]+\.)*(googleapis\.com|mozilla\.com|mozaws\.net|push\.apple\.com|notify\.windows\.com)(:443)?/' THEN
    RAISE EXCEPTION 'unsupported push service';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.locations WHERE id = p_location_id) THEN
    RAISE EXCEPTION 'unknown location';
  END IF;
  -- The endpoint is the device's capability: whoever holds it is that device,
  -- so re-subscribing moves the row to the current (or no) signed-in user.
  INSERT INTO public.push_subscriptions (endpoint, p256dh, auth_key, user_id, location_id)
  VALUES (p_endpoint, p_p256dh, p_auth_key, auth.uid(), p_location_id)
  ON CONFLICT (endpoint) DO UPDATE
    SET p256dh      = excluded.p256dh,
        auth_key    = excluded.auth_key,
        user_id     = excluded.user_id,
        location_id = excluded.location_id;
END $$;


-- ── 4. Follows: let a player remove their own followers ─────────────────────
-- FriendsTab's "Remove follower" deleted 0 rows under the old policy.
DROP POLICY IF EXISTS "follows: followed can remove" ON public.follows;
CREATE POLICY "follows: followed can remove" ON public.follows
  FOR DELETE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.players p WHERE p.id = following_id AND p.user_id = auth.uid())
  );


-- ── 5. Event RSVPs: own row only, capacity enforced ─────────────────────────
-- Any member could RSVP or cancel for anyone; capacity was client-side only.
DROP POLICY IF EXISTS "event_signups: location members all" ON public.event_signups;
DROP POLICY IF EXISTS "event_signups: location members read" ON public.event_signups;
DROP POLICY IF EXISTS "event_signups: own insert" ON public.event_signups;
DROP POLICY IF EXISTS "event_signups: own delete" ON public.event_signups;
CREATE POLICY "event_signups: location members read" ON public.event_signups
  FOR SELECT TO authenticated
  USING (public.is_in_location(location_id));
CREATE POLICY "event_signups: own insert" ON public.event_signups
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin_of_location(location_id)
    OR EXISTS (
      SELECT 1 FROM public.players p
       WHERE p.id = player_id AND p.user_id = auth.uid() AND p.location_id = event_signups.location_id
    )
  );
CREATE POLICY "event_signups: own delete" ON public.event_signups
  FOR DELETE TO authenticated
  USING (
    public.is_admin_of_location(location_id)
    OR EXISTS (SELECT 1 FROM public.players p WHERE p.id = player_id AND p.user_id = auth.uid())
  );

CREATE OR REPLACE FUNCTION public.enforce_event_signup_capacity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE cap INTEGER; taken INTEGER;
BEGIN
  -- Row lock serializes concurrent RSVPs for the same event.
  SELECT capacity INTO cap FROM public.app_events WHERE id = NEW.event_id FOR UPDATE;
  IF cap IS NOT NULL THEN
    SELECT count(*) INTO taken FROM public.event_signups WHERE event_id = NEW.event_id;
    IF taken >= cap THEN RAISE EXCEPTION 'This event is full'; END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS event_signups_capacity ON public.event_signups;
CREATE TRIGGER event_signups_capacity
  BEFORE INSERT ON public.event_signups
  FOR EACH ROW EXECUTE FUNCTION public.enforce_event_signup_capacity();


-- ── 6. Handicap engine ──────────────────────────────────────────────────────
-- a) floor(avg(x) * 0.90) lost a stroke whenever 90% of the average was a
--    whole number (avg of 3,3,4 → 2.99999… → 2). Now exact: floor(sum*9/(n*10)).
-- b) "Most recent N" ordered by week_number, which restarts each season and
--    interleaves concurrent leagues. Now ordered by event date.
-- c) Sub profiles clamp at -2..40 like everywhere else.
-- (N stays the league's week count, as before.)
CREATE OR REPLACE FUNCTION public.recalculate_player_handicap_core(p_player_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  player_row public.players%ROWTYPE;
  score_limit INTEGER;
  diffs NUMERIC[];
  sorted_diffs NUMERIC[];
  n INTEGER;
  low_discard INTEGER;
  high_discard INTEGER;
  used_diffs NUMERIC[];
  new_handicap INTEGER;
  max_handicap INTEGER;
BEGIN
  SELECT * INTO player_row FROM public.players WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not found'; END IF;
  IF COALESCE(player_row.handicap_locked, false) THEN RETURN jsonb_build_object('skipped', true, 'reason', 'locked'); END IF;
  SELECT COALESCE(num_weeks, 12) INTO score_limit FROM public.league_config
   WHERE location_id = player_row.location_id AND is_working ORDER BY id LIMIT 1;
  score_limit := greatest(1, COALESCE(score_limit, 12));
  max_handicap := CASE WHEN COALESCE(player_row.is_sub, false) THEN 40 ELSE 27 END;

  SELECT array_agg(diff)
    INTO diffs
    FROM (
      SELECT s.gross_total - c.total_par AS diff
        FROM public.scores s
        JOIN public.events e ON e.id = s.event_id
        JOIN public.courses c ON c.id = e.course_id
       WHERE s.player_id = p_player_id
         AND s.location_id = player_row.location_id
         AND s.entry_type = 'played'
         AND s.status = 'verified'
         AND NOT COALESCE(s.sub_played, false)
         AND s.gross_total IS NOT NULL
         AND NOT (
           COALESCE((e.format_config->>'exclude_from_handicap')::boolean,
                    e.format = 'scramble')
         )
       ORDER BY COALESCE(e.start_date, e.event_date) DESC NULLS LAST,
                e.week_number DESC NULLS LAST,
                s.created_at DESC
       LIMIT score_limit
    ) recent;
  IF diffs IS NULL OR cardinality(diffs) = 0 THEN RETURN jsonb_build_object('skipped', true, 'reason', 'no_scores'); END IF;
  SELECT array_agg(value ORDER BY value) INTO sorted_diffs FROM unnest(diffs) value;
  n := cardinality(sorted_diffs);
  high_discard := CASE WHEN n >= 4 THEN 1 ELSE 0 END;
  low_discard := CASE WHEN n >= 5 THEN 1 ELSE 0 END;
  used_diffs := sorted_diffs[(1 + low_discard):(n - high_discard)];
  SELECT greatest(-2, least(max_handicap, floor((sum(value) * 9) / (count(*) * 10))::integer))
    INTO new_handicap FROM unnest(used_diffs) value;
  IF new_handicap IS NOT DISTINCT FROM player_row.handicap THEN
    RETURN jsonb_build_object('skipped', true, 'newHcp', new_handicap);
  END IF;
  PERFORM set_config('app.player_write', 'on', true);
  UPDATE public.players SET handicap = new_handicap WHERE id = p_player_id;
  INSERT INTO public.handicap_history (player_id, handicap, scores_used, location_id)
  VALUES (p_player_id, new_handicap, cardinality(used_diffs), player_row.location_id);
  PERFORM public.write_audit_event(
    player_row.location_id, 'handicap.recalculate', 'players', p_player_id,
    jsonb_build_object('handicap', player_row.handicap),
    jsonb_build_object('handicap', new_handicap, 'scores_used', cardinality(used_diffs))
  );
  RETURN jsonb_build_object('updated', true, 'oldHcp', player_row.handicap, 'newHcp', new_handicap);
END;
$$;

-- Internal (no caller check): also used by server-side paths with no signed-in
-- admin, e.g. simulator rounds that post as verified.
REVOKE ALL ON FUNCTION public.recalculate_player_handicap_core(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.recalculate_player_handicap(p_player_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE loc UUID;
BEGIN
  SELECT location_id INTO loc FROM public.players WHERE id = p_player_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not found'; END IF;
  PERFORM public.require_location_admin(loc);
  RETURN public.recalculate_player_handicap_core(p_player_id);
END;
$$;

-- "Recalculate All" picked the admin's oldest location, not the one they were
-- working in. Takes the location now (NULL keeps the old single-location path).
DROP FUNCTION IF EXISTS public.recalculate_handicaps();
CREATE OR REPLACE FUNCTION public.recalculate_handicaps(p_location_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE admin_location UUID; admin_count INTEGER; player_id_value UUID; result JSONB; updated_count INTEGER := 0;
BEGIN
  IF p_location_id IS NOT NULL THEN
    PERFORM public.require_location_admin(p_location_id);
    admin_location := p_location_id;
  ELSE
    SELECT count(*), min(location_id::text)::uuid INTO admin_count, admin_location
      FROM public.location_admins WHERE user_id = auth.uid();
    IF admin_count = 0 THEN RAISE EXCEPTION 'Admin access required' USING ERRCODE = '42501'; END IF;
    IF admin_count > 1 THEN RAISE EXCEPTION 'Specify which location to recalculate'; END IF;
  END IF;
  FOR player_id_value IN SELECT id FROM public.players WHERE location_id = admin_location AND NOT COALESCE(handicap_locked, false)
  LOOP
    result := public.recalculate_player_handicap(player_id_value);
    IF COALESCE((result->>'updated')::boolean, false) THEN updated_count := updated_count + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('updated', updated_count);
END;
$$;
REVOKE ALL ON FUNCTION public.recalculate_handicaps(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_handicaps(UUID) TO authenticated;


-- ── 7. Player-submitted scores in a sub week ────────────────────────────────
-- A team self-submitting while an approved sub played stored the sub's round
-- as the absent player's own (sub_played=false, player's handicap), feeding
-- the absent player's handicap once approved. Now tagged like admin entry.
CREATE OR REPLACE FUNCTION public.submit_scores(p_event_id UUID, p_entries JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  caller_player public.players%ROWTYPE;
  caller_team_id UUID;
  course_row public.courses%ROWTYPE;
  entry JSONB;
  entry_player public.players%ROWTYPE;
  sub_row public.subs%ROWTYPE;
  sub_flag BOOLEAN;
  holes JSONB;
  holes_int INTEGER[];
  stats JSONB;
  gross INTEGER;
  handicap_value INTEGER;
  inserted_count INTEGER := 0;
  affected INTEGER;
  roster_count INTEGER;
  distinct_entry_count INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  -- Shared lock with publish_week: submission and publishing serialize.
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;
  IF event_row.status <> 'open' THEN RAISE EXCEPTION 'This event is no longer open'; END IF;

  SELECT * INTO caller_player
    FROM public.players
   WHERE user_id = auth.uid() AND location_id = event_row.location_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'No player profile is linked to this account'; END IF;

  SELECT r.team_id INTO caller_team_id
    FROM public.roster_at r
   WHERE r.event_id = p_event_id AND r.player_id = caller_player.id;
  IF caller_team_id IS NULL THEN RAISE EXCEPTION 'You are not rostered for this event'; END IF;

  IF jsonb_typeof(p_entries) <> 'array' THEN RAISE EXCEPTION 'entries must be a JSON array'; END IF;
  SELECT count(*) INTO roster_count FROM public.roster_at
   WHERE event_id = p_event_id AND team_id = caller_team_id;
  SELECT count(DISTINCT value->>'player_id') INTO distinct_entry_count
    FROM jsonb_array_elements(p_entries);
  IF jsonb_array_length(p_entries) <> roster_count OR distinct_entry_count <> roster_count THEN
    RAISE EXCEPTION 'Submit exactly one score for each rostered teammate';
  END IF;

  SELECT c.* INTO course_row
    FROM public.courses c WHERE c.id = event_row.course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This event has no valid course'; END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_entries)
  LOOP
    SELECT p.* INTO entry_player
      FROM public.players p
      JOIN public.roster_at r ON r.player_id = p.id
     WHERE r.event_id = p_event_id
       AND r.team_id = caller_team_id
       AND p.id = (entry->>'player_id')::uuid
       AND p.location_id = event_row.location_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'A submitted player is not on your event roster'; END IF;

    holes := entry->'hole_scores';
    IF NOT public.jsonb_int_array_valid(holes, course_row.num_holes, 1, 20) THEN
      RAISE EXCEPTION 'Scores must include % holes with values from 1 to 20', course_row.num_holes;
    END IF;
    holes_int := ARRAY(SELECT elem::integer FROM jsonb_array_elements_text(holes) AS t(elem));
    gross := public.jsonb_int_array_sum(holes);

    -- An approved sub played this slot: the round is the sub's, at the sub's
    -- handicap, and never feeds the absent player's handicap.
    SELECT * INTO sub_row FROM public.subs
     WHERE event_id = p_event_id AND player_id = entry_player.id AND status = 'approved'
     ORDER BY created_at DESC NULLS LAST
     LIMIT 1;
    sub_flag := FOUND;
    IF sub_flag THEN
      handicap_value := COALESCE(
        (SELECT round(sp.handicap)::integer FROM public.players sp WHERE sp.id = sub_row.sub_player_id),
        round(COALESCE(sub_row.sub_handicap, 0))::integer
      );
    ELSE
      handicap_value := round(COALESCE(entry_player.handicap, 0))::integer;
    END IF;

    stats := CASE WHEN jsonb_typeof(entry->'hole_stats') = 'array' THEN entry->'hole_stats' ELSE NULL END;
    IF stats IS NOT NULL THEN
      IF jsonb_array_length(stats) <> course_row.num_holes OR NOT public.hole_stats_valid(stats) THEN
        RAISE EXCEPTION 'hole_stats must be % per-hole objects with putts/fir/gir/penalties', course_row.num_holes;
      END IF;
    END IF;

    INSERT INTO public.scores (
      event_id, player_id, team_id, hole_scores, hole_stats, gross_total, net_total,
      handicap_used, sub_played, entry_type, status, location_id
    ) VALUES (
      p_event_id, entry_player.id, caller_team_id, holes_int, stats, gross,
      gross - handicap_value, handicap_value, sub_flag, 'played', 'pending',
      event_row.location_id
    )
    ON CONFLICT (event_id, player_id, entry_type) WHERE status <> 'rejected'
    DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT;
    inserted_count := inserted_count + affected;
  END LOOP;

  IF inserted_count > 0 THEN
    PERFORM public.write_audit_event(
      event_row.location_id, 'score.submit', 'events', p_event_id, NULL,
      jsonb_build_object(
        'team_id', caller_team_id,
        'submitted_player_ids', (
          SELECT jsonb_agg(value->>'player_id') FROM jsonb_array_elements(p_entries)
        ),
        'status', 'pending'
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'inserted', inserted_count,
    'already_submitted', inserted_count = 0,
    'status', 'pending'
  );
END;
$$;


-- ── 8. Closed-week corrections keep results and penalties consistent ────────
-- Correcting a published week never re-ran matchup/format results (the UI had
-- no rescore button), and removing a played score on a closed week left the
-- player with neither a score nor a missed-week penalty.

-- Re-issue the missed-week penalty for a rostered player who no longer has a
-- verified played score on a closed event. Mirrors publish_week.
CREATE OR REPLACE FUNCTION public.restore_missed_penalty(p_event_id UUID, p_player_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE affected INTEGER;
BEGIN
  INSERT INTO public.scores (
    event_id, player_id, team_id, hole_scores, gross_total, net_total,
    handicap_used, sub_played, entry_type, status, location_id
  )
  SELECT
    e.id, r.player_id, r.team_id, NULL, NULL,
    COALESCE(c.total_par, 36) + round(COALESCE(p.handicap, 0))::integer + 7,
    round(COALESCE(p.handicap, 0))::integer,
    false, 'missed_penalty', 'verified', e.location_id
  FROM public.events e
  JOIN public.roster_at r ON r.event_id = e.id AND r.player_id = p_player_id
  JOIN public.players p ON p.id = r.player_id
  LEFT JOIN public.courses c ON c.id = e.course_id
  WHERE e.id = p_event_id
    AND e.status = 'closed'
    AND NOT COALESCE(e.is_bye, false)
    AND NOT EXISTS (
      SELECT 1 FROM public.scores s
       WHERE s.event_id = e.id AND s.player_id = p_player_id
         AND s.entry_type = 'played' AND s.status = 'verified'
    )
  ON CONFLICT (event_id, player_id, entry_type) WHERE status <> 'rejected'
  DO NOTHING;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;
REVOKE ALL ON FUNCTION public.restore_missed_penalty(UUID, UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.admin_upsert_score(p_event_id UUID, p_entries JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  course_row public.courses%ROWTYPE;
  entry JSONB;
  target_player public.players%ROWTYPE;
  before_row JSONB;
  after_row JSONB;
  holes JSONB;
  holes_int INTEGER[];
  gross INTEGER;
  handicap_value INTEGER;
  target_team_id UUID;
  changed_count INTEGER := 0;
  penalties_superseded INTEGER;
  results JSONB;
BEGIN
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Event not found'; END IF;
  PERFORM public.require_location_admin(event_row.location_id);
  -- Closed weeks stay editable by admins: life happens and scores get fixed
  -- late. The event itself never reopens; every correction is audited and any
  -- missed-week penalty for the corrected player is superseded below.
  IF jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) = 0 THEN
    RAISE EXCEPTION 'entries must be a non-empty JSON array';
  END IF;

  SELECT * INTO course_row FROM public.courses WHERE id = event_row.course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'This event has no valid course'; END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_entries)
  LOOP
    SELECT * INTO target_player FROM public.players
     WHERE id = (entry->>'player_id')::uuid
       AND location_id = event_row.location_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Player is not in the event location'; END IF;

    holes := entry->'hole_scores';
    IF NOT public.jsonb_int_array_valid(holes, course_row.num_holes, 1, 20) THEN
      RAISE EXCEPTION 'Scores must include % holes with values from 1 to 20', course_row.num_holes;
    END IF;
    holes_int := ARRAY(SELECT elem::integer FROM jsonb_array_elements_text(holes) AS t(elem));
    gross := public.jsonb_int_array_sum(holes);
    handicap_value := COALESCE(
      NULLIF(entry->>'handicap_used', '')::integer,
      round(COALESCE(target_player.handicap, 0))::integer
    );
    SELECT r.team_id INTO target_team_id FROM public.roster_at r
     WHERE r.event_id = p_event_id AND r.player_id = target_player.id;

    SELECT to_jsonb(s) INTO before_row FROM public.scores s
     WHERE s.event_id = p_event_id
       AND s.player_id = target_player.id
       AND s.entry_type = 'played'
       AND s.status <> 'rejected';

    INSERT INTO public.scores (
      event_id, player_id, team_id, hole_scores, gross_total, net_total,
      handicap_used, sub_played, entry_type, status, location_id
    ) VALUES (
      p_event_id, target_player.id, target_team_id, holes_int, gross,
      gross - handicap_value, handicap_value,
      COALESCE((entry->>'sub_played')::boolean, false),
      'played', 'verified', event_row.location_id
    )
    ON CONFLICT (event_id, player_id, entry_type) WHERE status <> 'rejected'
    DO UPDATE SET
      team_id = EXCLUDED.team_id,
      hole_scores = EXCLUDED.hole_scores,
      gross_total = EXCLUDED.gross_total,
      net_total = EXCLUDED.net_total,
      handicap_used = EXCLUDED.handicap_used,
      sub_played = EXCLUDED.sub_played,
      status = 'verified';

    SELECT to_jsonb(s) INTO after_row FROM public.scores s
     WHERE s.event_id = p_event_id
       AND s.player_id = target_player.id
       AND s.entry_type = 'played'
       AND s.status <> 'rejected';

    DELETE FROM public.scores penalty
     WHERE penalty.event_id = p_event_id
       AND penalty.player_id = target_player.id
       AND penalty.entry_type = 'missed_penalty';
    GET DIAGNOSTICS penalties_superseded = ROW_COUNT;

    PERFORM public.write_audit_event(
      event_row.location_id, 'score.admin_upsert', 'scores',
      (after_row->>'id')::uuid, before_row,
      after_row || jsonb_build_object(
        'event_status', event_row.status,
        'penalty_superseded', penalties_superseded > 0
      )
    );
    changed_count := changed_count + 1;
  END LOOP;

  -- A correction on a published week re-scores its matchups/format results.
  IF event_row.status = 'closed' THEN
    results := public.compute_event_results(p_event_id);
  END IF;

  RETURN jsonb_build_object('updated', changed_count, 'status', 'verified', 'results', results);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_review_score(p_score_id UUID, p_status TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  score_row public.scores%ROWTYPE;
  event_row public.events%ROWTYPE;
  before_row JSONB;
  after_row JSONB;
BEGIN
  IF p_status NOT IN ('verified', 'rejected') THEN
    RAISE EXCEPTION 'Review status must be verified or rejected';
  END IF;
  SELECT * INTO score_row FROM public.scores WHERE id = p_score_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Score not found'; END IF;
  -- Take the event lock first (same order as submit/publish), then the row.
  SELECT * INTO event_row FROM public.events WHERE id = score_row.event_id FOR UPDATE;
  SELECT * INTO score_row FROM public.scores WHERE id = p_score_id FOR UPDATE;
  PERFORM public.require_location_admin(score_row.location_id);
  before_row := to_jsonb(score_row);
  UPDATE public.scores SET status = p_status WHERE id = p_score_id RETURNING to_jsonb(scores) INTO after_row;
  PERFORM public.write_audit_event(
    score_row.location_id,
    CASE WHEN p_status = 'verified' THEN 'score.approve' ELSE 'score.reject' END,
    'scores', p_score_id, before_row, after_row
  );
  IF event_row.status = 'closed' THEN
    IF p_status = 'rejected' AND score_row.entry_type = 'played' THEN
      PERFORM public.restore_missed_penalty(score_row.event_id, score_row.player_id);
    END IF;
    PERFORM public.compute_event_results(score_row.event_id);
  END IF;
  RETURN after_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_score(p_score_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  score_row public.scores%ROWTYPE;
  event_row public.events%ROWTYPE;
BEGIN
  SELECT * INTO score_row FROM public.scores WHERE id = p_score_id;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO event_row FROM public.events WHERE id = score_row.event_id FOR UPDATE;
  SELECT * INTO score_row FROM public.scores WHERE id = p_score_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.require_location_admin(score_row.location_id);
  DELETE FROM public.scores WHERE id = p_score_id;
  PERFORM public.write_audit_event(
    score_row.location_id, 'score.delete', 'scores', p_score_id,
    to_jsonb(score_row), NULL
  );
  IF event_row.status = 'closed' THEN
    IF score_row.entry_type = 'played' THEN
      PERFORM public.restore_missed_penalty(score_row.event_id, score_row.player_id);
    END IF;
    PERFORM public.compute_event_results(score_row.event_id);
  END IF;
  RETURN true;
END;
$$;


-- ── 9. Match play / best ball: a short-handed side can't win by default ─────
-- A team with one verified score was compared hole-by-hole (one net) against
-- a full team (two nets summed) and won nearly every hole. A missing teammate
-- now plays their missed-week penalty: net par + their handicap + 7 for the
-- round, spread evenly across the holes. A side with NO scores is still a
-- no-show handled by the week's no-show policy.
CREATE OR REPLACE FUNCTION public.per_hole_net_sum(
  p_event_id UUID,
  p_team_id UUID,
  p_player_id UUID,
  p_stroke_index JSONB,
  p_num_holes INTEGER,
  p_allowance NUMERIC
)
RETURNS NUMERIC[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s RECORD;
  strokes INTEGER[];
  totals NUMERIC[];
  pars INTEGER[];
  i INTEGER;
  found_count INTEGER := 0;
  missing_count INTEGER := 0;
  missing_over_par INTEGER := 0;
BEGIN
  totals := array_fill(0::numeric, ARRAY[p_num_holes]);
  FOR s IN
    SELECT sc.hole_scores, sc.handicap_used
      FROM public.scores sc
     WHERE sc.event_id = p_event_id
       AND sc.entry_type = 'played'
       AND sc.status = 'verified'
       AND sc.hole_scores IS NOT NULL
       AND ((p_player_id IS NOT NULL AND sc.player_id = p_player_id)
         OR (p_player_id IS NULL AND sc.team_id = p_team_id))
  LOOP
    -- Sub rounds count for the team they played for; mirrored sub-profile rows
    -- carry the sub's own player_id and a NULL/foreign team_id, so the
    -- team_id filter above naturally excludes them.
    found_count := found_count + 1;
    strokes := public.format_strokes_received(s.handicap_used, p_stroke_index, p_num_holes, p_allowance);
    FOR i IN 1..p_num_holes LOOP
      totals[i] := totals[i] + s.hole_scores[i] - strokes[i];
    END LOOP;
  END LOOP;
  IF found_count = 0 THEN RETURN NULL; END IF;

  IF p_player_id IS NULL THEN
    -- Each rostered teammate with no verified round plays their penalty:
    -- par + (handicap + 7) over the round, using the handicap stored on
    -- their penalty row when publish already issued one.
    SELECT count(*), COALESCE(sum(
             COALESCE(pen.handicap_used, round(COALESCE(p.handicap, 0))::integer) + 7
           ), 0)
      INTO missing_count, missing_over_par
      FROM public.roster_at r
      JOIN public.players p ON p.id = r.player_id
      LEFT JOIN public.scores pen
        ON pen.event_id = p_event_id AND pen.player_id = r.player_id
       AND pen.entry_type = 'missed_penalty' AND pen.status = 'verified'
     WHERE r.event_id = p_event_id AND r.team_id = p_team_id
       AND NOT EXISTS (
         SELECT 1 FROM public.scores sc
          WHERE sc.event_id = p_event_id AND sc.player_id = r.player_id
            AND sc.entry_type = 'played' AND sc.status = 'verified'
       );
    IF missing_count > 0 THEN
      SELECT ARRAY(SELECT jsonb_array_elements_text(c.hole_pars)::integer)
        INTO pars
        FROM public.events e JOIN public.courses c ON c.id = e.course_id
       WHERE e.id = p_event_id;
      FOR i IN 1..p_num_holes LOOP
        totals[i] := totals[i]
          + missing_count * COALESCE(pars[i], 4)
          + missing_over_par::numeric / p_num_holes;
      END LOOP;
    END IF;
  END IF;
  RETURN totals;
END;
$$;
REVOKE ALL ON FUNCTION public.per_hole_net_sum(UUID, UUID, UUID, JSONB, INTEGER, NUMERIC) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.compute_team_night_results(p_event_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  course_row public.courses%ROWTYPE;
  cfg JSONB;
  team RECORD;
  s RECORD;
  team_result NUMERIC;
  best NUMERIC;
  hole_sum NUMERIC;
  i INTEGER;
  member_count INTEGER;
  missing_count INTEGER;
  missing_over_par INTEGER;
  combined_hcp NUMERIC;
  strokes INTEGER[];
  teams_scored INTEGER := 0;
  balls INTEGER;
BEGIN
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id;
  cfg := COALESCE(event_row.format_config, '{"version":1}'::jsonb);
  SELECT * INTO course_row FROM public.courses WHERE id = event_row.course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Team night scoring requires a course'; END IF;

  FOR team IN
    SELECT DISTINCT sc.team_id
      FROM public.scores sc
     WHERE sc.event_id = p_event_id
       AND sc.entry_type = 'played' AND sc.status = 'verified'
       AND sc.hole_scores IS NOT NULL AND sc.team_id IS NOT NULL
  LOOP
    IF event_row.format = 'scramble' THEN
      -- Teammates share one ball: rows are duplicates of the team score.
      SELECT min(sc.gross_total), sum(sc.handicap_used), count(*)
        INTO team_result, combined_hcp, member_count
        FROM public.scores sc
       WHERE sc.event_id = p_event_id AND sc.team_id = team.team_id
         AND sc.entry_type = 'played' AND sc.status = 'verified';
      team_result := team_result
        - round(COALESCE(combined_hcp, 0) * COALESCE((cfg->>'team_handicap_pct')::numeric, 35) / 100.0);
    ELSE
      -- best_ball: per-hole best net (balls_counted=1) or both nets summed (=2).
      balls := COALESCE((cfg->>'balls_counted')::integer, 1);
      -- Missing teammates (no verified round) play their penalty, handicap + 7
      -- over par, spread across the holes like match play.
      SELECT count(*), COALESCE(sum(
               COALESCE(pen.handicap_used, round(COALESCE(p.handicap, 0))::integer) + 7
             ), 0)
        INTO missing_count, missing_over_par
        FROM public.roster_at r
        JOIN public.players p ON p.id = r.player_id
        LEFT JOIN public.scores pen
          ON pen.event_id = p_event_id AND pen.player_id = r.player_id
         AND pen.entry_type = 'missed_penalty' AND pen.status = 'verified'
       WHERE r.event_id = p_event_id AND r.team_id = team.team_id
         AND NOT EXISTS (
           SELECT 1 FROM public.scores sc
            WHERE sc.event_id = p_event_id AND sc.player_id = r.player_id
              AND sc.entry_type = 'played' AND sc.status = 'verified'
         );
      team_result := 0;
      FOR i IN 1..course_row.num_holes LOOP
        best := NULL; hole_sum := 0;
        FOR s IN
          SELECT sc.hole_scores, sc.handicap_used
            FROM public.scores sc
           WHERE sc.event_id = p_event_id AND sc.team_id = team.team_id
             AND sc.entry_type = 'played' AND sc.status = 'verified'
             AND sc.hole_scores IS NOT NULL
        LOOP
          strokes := public.format_strokes_received(
            s.handicap_used, course_row.stroke_index, course_row.num_holes,
            COALESCE((cfg->>'allowance_pct')::numeric, 100));
          hole_sum := hole_sum + (s.hole_scores[i] - strokes[i]);
          IF best IS NULL OR (s.hole_scores[i] - strokes[i]) < best THEN
            best := s.hole_scores[i] - strokes[i];
          END IF;
        END LOOP;
        -- Counting both balls: each missing teammate plays their penalty.
        IF balls = 2 AND missing_count > 0 THEN
          hole_sum := hole_sum
            + missing_count * (course_row.hole_pars->>(i - 1))::integer
            + missing_over_par::numeric / course_row.num_holes;
        END IF;
        team_result := team_result + CASE WHEN balls = 2 THEN hole_sum ELSE COALESCE(best, 0) END;
      END LOOP;
    END IF;

    UPDATE public.scores SET format_points = team_result
     WHERE event_id = p_event_id AND team_id = team.team_id
       AND entry_type = 'played' AND status = 'verified';
    teams_scored := teams_scored + 1;
  END LOOP;
  RETURN teams_scored;
END;
$$;
REVOKE ALL ON FUNCTION public.compute_team_night_results(UUID) FROM PUBLIC, anon, authenticated;


-- ── 10. Rosters ─────────────────────────────────────────────────────────────
-- admin_save_team on edit deleted both active memberships and re-inserted
-- both players from the league start date. After a mid-season swap that put
-- three players on the team for early weeks (or failed on the overlap
-- constraint), and a removed player kept players.team_id and was stuck out of
-- every team picker. Now only a player who actually changed is touched: the
-- replacement takes over the removed player's slot from the same date.
CREATE OR REPLACE FUNCTION public.admin_save_team(
  p_team_id UUID,
  p_league_id UUID,
  p_name TEXT,
  p_player_ids JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  league_row public.league_config%ROWTYPE;
  team_id_value UUID;
  player_one UUID;
  player_two UUID;
  before_row JSONB;
  removed RECORD;
  new_player UUID;
  slot_from DATE;
  season_start DATE;
BEGIN
  SELECT * INTO league_row FROM public.league_config WHERE id = p_league_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(league_row.location_id);
  IF jsonb_typeof(p_player_ids) <> 'array' OR jsonb_array_length(p_player_ids) <> 2 THEN
    RAISE EXCEPTION 'A team requires exactly two players';
  END IF;
  player_one := (p_player_ids->>0)::uuid;
  player_two := (p_player_ids->>1)::uuid;
  IF player_one = player_two THEN RAISE EXCEPTION 'Team players must be different'; END IF;
  IF (SELECT count(*) FROM public.players WHERE id IN (player_one, player_two) AND location_id = league_row.location_id) <> 2 THEN
    RAISE EXCEPTION 'Both players must belong to the league location';
  END IF;
  season_start := COALESCE(league_row.start_date, DATE '1900-01-01');

  PERFORM set_config('app.roster_write', 'on', true);
  IF p_team_id IS NULL THEN
    INSERT INTO public.teams (
      name, player1_id, player2_id, league_id, location_id
    ) VALUES (
      trim(p_name), player_one, player_two, p_league_id, league_row.location_id
    ) RETURNING id INTO team_id_value;
    INSERT INTO public.team_memberships (
      location_id, league_id, player_id, team_id, effective_from
    ) VALUES
      (league_row.location_id, p_league_id, player_one, team_id_value, season_start),
      (league_row.location_id, p_league_id, player_two, team_id_value, season_start);
  ELSE
    SELECT to_jsonb(t) INTO before_row FROM public.teams t
     WHERE id = p_team_id AND location_id = league_row.location_id AND league_id = p_league_id FOR UPDATE;
    IF before_row IS NULL THEN RAISE EXCEPTION 'Team not found in league'; END IF;
    team_id_value := p_team_id;
    UPDATE public.teams SET name = trim(p_name), player1_id = player_one, player2_id = player_two
     WHERE id = team_id_value;

    -- Replace only the players who changed; each newcomer inherits the
    -- removed player's start date (a correction, not a dated swap).
    FOR removed IN
      SELECT * FROM public.team_memberships
       WHERE team_id = team_id_value AND effective_to IS NULL
         AND player_id NOT IN (player_one, player_two)
       ORDER BY effective_from, id
    LOOP
      SELECT pid INTO new_player FROM unnest(ARRAY[player_one, player_two]) pid
       WHERE NOT EXISTS (
         SELECT 1 FROM public.team_memberships tm
          WHERE tm.team_id = team_id_value AND tm.effective_to IS NULL AND tm.player_id = pid
       )
       LIMIT 1;
      slot_from := removed.effective_from;
      DELETE FROM public.team_memberships WHERE id = removed.id;
      UPDATE public.players SET team_id = NULL WHERE id = removed.player_id AND team_id = team_id_value;
      IF new_player IS NOT NULL THEN
        -- Don't overlap an earlier stint this player had elsewhere in the league.
        SELECT greatest(slot_from, COALESCE(max(tm.effective_to) + 1, slot_from)) INTO slot_from
          FROM public.team_memberships tm
         WHERE tm.player_id = new_player AND tm.league_id = p_league_id AND tm.effective_to IS NOT NULL;
        INSERT INTO public.team_memberships (
          location_id, league_id, player_id, team_id, effective_from
        ) VALUES (league_row.location_id, p_league_id, new_player, team_id_value, slot_from);
      END IF;
    END LOOP;

    -- A team that somehow had fewer than two active members gets topped up.
    FOR new_player IN
      SELECT pid FROM unnest(ARRAY[player_one, player_two]) pid
       WHERE NOT EXISTS (
         SELECT 1 FROM public.team_memberships tm
          WHERE tm.team_id = team_id_value AND tm.effective_to IS NULL AND tm.player_id = pid
       )
    LOOP
      SELECT COALESCE(max(tm.effective_to) + 1, season_start) INTO slot_from
        FROM public.team_memberships tm
       WHERE tm.player_id = new_player AND tm.league_id = p_league_id AND tm.effective_to IS NOT NULL;
      INSERT INTO public.team_memberships (
        location_id, league_id, player_id, team_id, effective_from
      ) VALUES (league_row.location_id, p_league_id, new_player, team_id_value, greatest(slot_from, season_start));
    END LOOP;
  END IF;

  UPDATE public.players SET team_id = team_id_value WHERE id IN (player_one, player_two);

  PERFORM public.write_audit_event(
    league_row.location_id,
    CASE WHEN p_team_id IS NULL THEN 'roster.team_create' ELSE 'roster.team_update' END,
    'teams', team_id_value, before_row,
    jsonb_build_object('name', trim(p_name), 'league_id', p_league_id, 'player_ids', p_player_ids)
  );
  RETURN team_id_value;
END;
$$;

-- A swap dated inside already-published weeks rewrote who played them.
CREATE OR REPLACE FUNCTION public.admin_swap_team_member(
  p_team_id UUID,
  p_out_player_id UUID,
  p_in_player_id UUID,
  p_effective_date DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  team_row public.teams%ROWTYPE;
  out_membership public.team_memberships%ROWTYPE;
  last_closed DATE;
BEGIN
  SELECT * INTO team_row FROM public.teams WHERE id = p_team_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Team not found'; END IF;
  PERFORM public.require_location_admin(team_row.location_id);
  IF p_effective_date IS NULL THEN RAISE EXCEPTION 'An effective date is required'; END IF;
  IF p_out_player_id = p_in_player_id THEN RAISE EXCEPTION 'Choose two different players'; END IF;

  SELECT * INTO out_membership FROM public.team_memberships
   WHERE team_id = p_team_id AND player_id = p_out_player_id AND effective_to IS NULL
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'The outgoing player has no active spot on this team'; END IF;
  IF p_effective_date <= out_membership.effective_from THEN
    RAISE EXCEPTION 'Effective date must be after the outgoing player joined (%). Use team edit to correct a roster from the start.',
      out_membership.effective_from;
  END IF;

  SELECT max(COALESCE(start_date, event_date)) INTO last_closed
    FROM public.events
   WHERE league_id = team_row.league_id AND location_id = team_row.location_id AND status = 'closed'
     AND NOT COALESCE(is_bye, false);  -- bye weeks are created already closed
  IF last_closed IS NOT NULL AND p_effective_date <= last_closed THEN
    RAISE EXCEPTION 'Effective date must be after the last published week (%) so past results stay intact', last_closed;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.players
     WHERE id = p_in_player_id AND location_id = team_row.location_id
  ) THEN RAISE EXCEPTION 'The incoming player must belong to this location'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.team_memberships
     WHERE player_id = p_in_player_id AND league_id = team_row.league_id AND effective_to IS NULL
  ) THEN RAISE EXCEPTION 'The incoming player is already on a team in this league'; END IF;

  PERFORM set_config('app.roster_write', 'on', true);

  UPDATE public.team_memberships
     SET effective_to = p_effective_date - 1
   WHERE id = out_membership.id;

  INSERT INTO public.team_memberships (
    location_id, league_id, player_id, team_id, effective_from
  ) VALUES (
    team_row.location_id, team_row.league_id, p_in_player_id, p_team_id, p_effective_date
  );

  UPDATE public.teams SET
    player1_id = CASE WHEN player1_id = p_out_player_id THEN p_in_player_id ELSE player1_id END,
    player2_id = CASE WHEN player2_id = p_out_player_id THEN p_in_player_id ELSE player2_id END
  WHERE id = p_team_id;
  UPDATE public.players SET team_id = NULL WHERE id = p_out_player_id;
  UPDATE public.players SET team_id = p_team_id WHERE id = p_in_player_id;

  PERFORM public.write_audit_event(
    team_row.location_id, 'roster.mid_season_swap', 'teams', p_team_id,
    jsonb_build_object('out_player_id', p_out_player_id),
    jsonb_build_object('in_player_id', p_in_player_id, 'effective_from', p_effective_date)
  );

  RETURN jsonb_build_object(
    'team_id', p_team_id,
    'out_player_id', p_out_player_id,
    'in_player_id', p_in_player_id,
    'effective_from', p_effective_date
  );
END;
$$;


-- ── 11. Players ─────────────────────────────────────────────────────────────
-- CSV import sends decimal handicaps ("8.5") which failed the ::integer cast.
CREATE OR REPLACE FUNCTION public.admin_create_player(p_location_id UUID, p_payload JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  player_id_value UUID;
  is_sub_value BOOLEAN := COALESCE((p_payload->>'is_sub')::boolean, false);
  max_handicap INTEGER;
  clamped_handicap INTEGER;
BEGIN
  PERFORM public.require_location_admin(p_location_id);
  max_handicap := CASE WHEN is_sub_value THEN 40 ELSE 27 END;
  clamped_handicap := greatest(-2, least(
    max_handicap,
    round(COALESCE(NULLIF(p_payload->>'handicap', '')::numeric, 0))::integer
  ));

  INSERT INTO public.players (
    first_name, last_name, name, email, handicap, in_skins,
    handicap_locked, is_sub, location_id
  ) VALUES (
    NULLIF(trim(p_payload->>'first_name'), ''),
    NULLIF(trim(p_payload->>'last_name'), ''),
    COALESCE(
      NULLIF(trim(p_payload->>'name'), ''),
      NULLIF(trim((p_payload->>'first_name') || ' ' || (p_payload->>'last_name')), '')
    ),
    CASE WHEN p_payload ? 'email' THEN NULLIF(lower(trim(p_payload->>'email')), '') ELSE NULL END,
    clamped_handicap,
    COALESCE((p_payload->>'in_skins')::boolean, false),
    COALESCE((p_payload->>'handicap_locked')::boolean, false),
    is_sub_value,
    p_location_id
  ) RETURNING id INTO player_id_value;

  PERFORM public.write_audit_event(
    p_location_id, 'player.create', 'players', player_id_value,
    NULL, jsonb_build_object('id', player_id_value, 'name', p_payload->>'name')
  );
  RETURN player_id_value;
END;
$$;

-- Renames left first_name/last_name stale, and several screens prefer those.
CREATE OR REPLACE FUNCTION public.admin_update_player(p_player_id UUID, p_payload JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  player_row public.players%ROWTYPE;
  new_handicap INTEGER;
  new_name TEXT;
  after_row JSONB;
BEGIN
  SELECT * INTO player_row FROM public.players WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Player not found'; END IF;
  PERFORM public.require_location_admin(player_row.location_id);
  new_handicap := greatest(-2, least(
    CASE WHEN COALESCE(player_row.is_sub, false) THEN 40 ELSE 27 END,
    round(COALESCE(NULLIF(p_payload->>'handicap', '')::numeric, player_row.handicap, 0))::integer
  ));
  new_name := COALESCE(NULLIF(regexp_replace(trim(p_payload->>'name'), '\s+', ' ', 'g'), ''), player_row.name);
  PERFORM set_config('app.player_write', 'on', true);
  UPDATE public.players SET
    name = new_name,
    first_name = CASE WHEN new_name IS DISTINCT FROM player_row.name
                      THEN split_part(new_name, ' ', 1) ELSE first_name END,
    last_name  = CASE WHEN new_name IS DISTINCT FROM player_row.name
                      THEN NULLIF(substr(new_name, length(split_part(new_name, ' ', 1)) + 2), '')
                      ELSE last_name END,
    email = CASE WHEN p_payload ? 'email' THEN NULLIF(lower(trim(p_payload->>'email')), '') ELSE email END,
    handicap = new_handicap,
    in_skins = COALESCE((p_payload->>'in_skins')::boolean, in_skins),
    handicap_locked = COALESCE((p_payload->>'handicap_locked')::boolean, handicap_locked)
  WHERE id = p_player_id
  RETURNING to_jsonb(players) INTO after_row;
  PERFORM public.write_audit_event(
    player_row.location_id, 'player.update', 'players', p_player_id,
    to_jsonb(player_row), after_row
  );
  RETURN after_row;
END;
$$;


-- ── 12. Subs ────────────────────────────────────────────────────────────────
-- request_sub trusted a client-supplied sub_player_id: approving could flip a
-- regular league player to is_sub and overwrite their handicap. Sub handicaps
-- also clamped at 27 here while subs are allowed up to 40 everywhere else.
CREATE OR REPLACE FUNCTION public.request_sub(p_event_id UUID, p_sub JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  event_row public.events%ROWTYPE;
  player_row public.players%ROWTYPE;
  request_id UUID;
  handicap_value INTEGER;
  sub_profile UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT * INTO event_row FROM public.events WHERE id = p_event_id AND status = 'open';
  IF NOT FOUND THEN RAISE EXCEPTION 'Sub requests require an open event'; END IF;
  SELECT * INTO player_row FROM public.players
   WHERE user_id = auth.uid() AND location_id = event_row.location_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'No player profile is linked to this account'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.roster_at WHERE event_id = p_event_id AND player_id = player_row.id) THEN
    RAISE EXCEPTION 'You are not rostered for this event';
  END IF;
  sub_profile := NULLIF(p_sub->>'sub_player_id', '')::uuid;
  IF sub_profile IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.players
     WHERE id = sub_profile AND location_id = event_row.location_id AND COALESCE(is_sub, false)
  ) THEN
    RAISE EXCEPTION 'That sub profile is not available';
  END IF;
  handicap_value := greatest(-2, least(40, round(COALESCE(NULLIF(p_sub->>'sub_handicap', '')::numeric, 0))::integer));
  INSERT INTO public.subs (
    event_id, player_id, sub_first_name, sub_last_name, sub_email, sub_phone,
    sub_handicap, sub_player_id, status, location_id
  ) VALUES (
    p_event_id, player_row.id, trim(p_sub->>'sub_first_name'), trim(p_sub->>'sub_last_name'),
    NULLIF(trim(p_sub->>'sub_email'), ''), NULLIF(trim(p_sub->>'sub_phone'), ''),
    handicap_value, sub_profile, 'pending', event_row.location_id
  ) RETURNING id INTO request_id;
  PERFORM public.write_audit_event(
    event_row.location_id, 'sub.request', 'subs', request_id, NULL,
    jsonb_build_object('event_id', p_event_id, 'player_id', player_row.id, 'status', 'pending')
  );
  RETURN request_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_sub_status(p_sub_id UUID, p_status TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  sub_row public.subs%ROWTYPE;
  profile_id UUID;
  before_row JSONB;
BEGIN
  IF p_status NOT IN ('approved', 'denied') THEN RAISE EXCEPTION 'Invalid sub status'; END IF;
  SELECT * INTO sub_row FROM public.subs WHERE id = p_sub_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sub request not found'; END IF;
  PERFORM public.require_location_admin(sub_row.location_id);
  before_row := to_jsonb(sub_row);

  profile_id := sub_row.sub_player_id;
  -- Never adopt a league player as a sub profile. An unflagged legacy sub
  -- profile (no login, not on any active team) is still adopted, so the
  -- AdminSubs repair of pre-fix rows keeps working without duplicating it.
  IF profile_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.players p
     WHERE p.id = profile_id AND p.location_id = sub_row.location_id
       AND (COALESCE(p.is_sub, false)
            OR (p.user_id IS NULL AND NOT EXISTS (
                  SELECT 1 FROM public.team_memberships tm
                   WHERE tm.player_id = p.id AND tm.effective_to IS NULL)))
  ) THEN
    profile_id := NULL;
  END IF;
  IF p_status = 'approved' THEN
    IF profile_id IS NULL THEN
      SELECT id INTO profile_id FROM public.players
       WHERE location_id = sub_row.location_id
         AND is_sub = true
         AND lower(first_name) = lower(trim(sub_row.sub_first_name))
         AND lower(last_name) = lower(trim(sub_row.sub_last_name))
       ORDER BY id LIMIT 1;
    END IF;
    IF profile_id IS NULL THEN
      INSERT INTO public.players (
        first_name, last_name, name, handicap, email, is_sub, location_id
      ) VALUES (
        trim(sub_row.sub_first_name), trim(sub_row.sub_last_name),
        trim(sub_row.sub_first_name || ' ' || sub_row.sub_last_name),
        greatest(-2, least(40, round(COALESCE(sub_row.sub_handicap, 0))::integer)),
        sub_row.sub_email, true, sub_row.location_id
      ) RETURNING id INTO profile_id;
    ELSE
      PERFORM set_config('app.player_write', 'on', true);
      UPDATE public.players
         SET handicap = greatest(-2, least(40, round(COALESCE(sub_row.sub_handicap, 0))::integer)),
             is_sub = true
       WHERE id = profile_id AND location_id = sub_row.location_id;
    END IF;
  END IF;

  UPDATE public.subs
     SET status = p_status,
         sub_player_id = CASE WHEN p_status = 'approved' THEN profile_id ELSE sub_player_id END
   WHERE id = p_sub_id;
  PERFORM public.write_audit_event(
    sub_row.location_id, 'sub.' || p_status, 'subs', p_sub_id, before_row,
    jsonb_build_object('status', p_status, 'sub_player_id', profile_id)
  );
  RETURN jsonb_build_object('status', p_status, 'sub_player_id', profile_id);
END;
$$;


-- ── 13. Schedule ────────────────────────────────────────────────────────────
-- a) Form-created weeks had week_number NULL: publish_week never auto-opened
--    them and standings/handicaps mis-ordered them. Default to next number.
-- b) Editing a published week always failed ("Only publish_week may close").
--    Name/notes/hole event are now editable; format, course, dates and bye
--    status stay frozen because results and rosters depend on them.
-- c) course_id wasn't checked against the league's location.
CREATE OR REPLACE FUNCTION public.admin_upsert_event(p_event_id UUID, p_league_id UUID, p_payload JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  league_row public.league_config%ROWTYPE;
  event_id_value UUID;
  requested_status TEXT;
  before_row JSONB;
  format_value TEXT;
  format_config_value JSONB;
  course_value UUID;
  week_value INTEGER;
BEGIN
  SELECT * INTO league_row FROM public.league_config WHERE id = p_league_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(league_row.location_id);
  requested_status := COALESCE(NULLIF(p_payload->>'status', ''), 'draft');
  IF requested_status NOT IN ('draft', 'open', 'cancelled', 'closed') THEN RAISE EXCEPTION 'Invalid event status'; END IF;

  course_value := NULLIF(p_payload->>'course_id', '')::uuid;
  IF course_value IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.courses WHERE id = course_value AND location_id = league_row.location_id
  ) THEN
    RAISE EXCEPTION 'Course is not in this location';
  END IF;

  IF p_event_id IS NULL THEN
    IF requested_status = 'closed' AND NOT COALESCE((p_payload->>'is_bye')::boolean, false) THEN
      RAISE EXCEPTION 'Only publish_week may close a playable event';
    END IF;
    week_value := NULLIF(p_payload->>'week_number', '')::integer;
    IF week_value IS NULL THEN
      SELECT COALESCE(max(week_number), 0) + 1 INTO week_value
        FROM public.events WHERE league_id = p_league_id AND location_id = league_row.location_id;
    END IF;
    format_value := COALESCE(NULLIF(p_payload->>'format', ''), league_row.default_format, 'stroke');
    format_config_value := COALESCE(p_payload->'format_config',
                                    league_row.default_format_config,
                                    '{"version": 1}'::jsonb);
    PERFORM public.validate_format_config(format_value, format_config_value);
    INSERT INTO public.events (
      name, start_date, end_date, status, notes, course_id, hole_event_hole,
      hole_event_name, is_bye, is_playoff, week_number, format, format_config, league_id, location_id
    ) VALUES (
      trim(p_payload->>'name'), NULLIF(p_payload->>'start_date', '')::date,
      NULLIF(p_payload->>'end_date', '')::date, requested_status,
      NULLIF(trim(p_payload->>'notes'), ''), course_value,
      NULLIF(p_payload->>'hole_event_hole', '')::integer,
      NULLIF(trim(p_payload->>'hole_event_name'), ''),
      COALESCE((p_payload->>'is_bye')::boolean, false),
      COALESCE((p_payload->>'is_playoff')::boolean, false),
      week_value,
      format_value, format_config_value,
      p_league_id, league_row.location_id
    ) RETURNING id INTO event_id_value;
  ELSE
    SELECT to_jsonb(e) INTO before_row FROM public.events e
     WHERE id = p_event_id AND league_id = p_league_id AND location_id = league_row.location_id FOR UPDATE;
    IF before_row IS NULL THEN RAISE EXCEPTION 'Event not found in league'; END IF;
    IF before_row->>'status' = 'closed' AND requested_status <> 'closed' THEN
      RAISE EXCEPTION 'Published events are immutable';
    END IF;
    IF requested_status = 'closed' AND before_row->>'status' <> 'closed'
       AND NOT COALESCE((p_payload->>'is_bye')::boolean, false) THEN
      RAISE EXCEPTION 'Only publish_week may close a playable event';
    END IF;
    format_value := COALESCE(NULLIF(p_payload->>'format', ''), before_row->>'format');
    format_config_value := COALESCE(p_payload->'format_config', before_row->'format_config');
    IF before_row->>'status' = 'closed' AND
       (format_value IS DISTINCT FROM before_row->>'format' OR
        format_config_value IS DISTINCT FROM before_row->'format_config') THEN
      RAISE EXCEPTION 'The format of a published event cannot change';
    END IF;
    IF before_row->>'status' = 'closed' AND
       course_value IS DISTINCT FROM NULLIF(before_row->>'course_id', '')::uuid THEN
      RAISE EXCEPTION 'The course of a published event cannot change';
    END IF;
    -- Dates decide who was rostered (roster_at), so they're frozen too.
    IF before_row->>'status' = 'closed' AND (
         NULLIF(p_payload->>'start_date', '')::date IS DISTINCT FROM NULLIF(before_row->>'start_date', '')::date
      OR NULLIF(p_payload->>'end_date', '')::date IS DISTINCT FROM NULLIF(before_row->>'end_date', '')::date
      OR COALESCE((p_payload->>'is_bye')::boolean, false) IS DISTINCT FROM COALESCE((before_row->>'is_bye')::boolean, false)
    ) THEN
      RAISE EXCEPTION 'The dates and bye status of a published event cannot change';
    END IF;
    PERFORM public.validate_format_config(format_value, format_config_value);
    event_id_value := p_event_id;
    UPDATE public.events SET
      name = trim(p_payload->>'name'),
      start_date = NULLIF(p_payload->>'start_date', '')::date,
      end_date = NULLIF(p_payload->>'end_date', '')::date,
      status = requested_status,
      notes = NULLIF(trim(p_payload->>'notes'), ''),
      course_id = course_value,
      hole_event_hole = NULLIF(p_payload->>'hole_event_hole', '')::integer,
      hole_event_name = NULLIF(trim(p_payload->>'hole_event_name'), ''),
      is_bye = COALESCE((p_payload->>'is_bye')::boolean, false),
      is_playoff = COALESCE((p_payload->>'is_playoff')::boolean, is_playoff),
      week_number = COALESCE(NULLIF(p_payload->>'week_number', '')::integer, week_number),
      format = format_value,
      format_config = format_config_value
    WHERE id = event_id_value;
  END IF;
  PERFORM public.write_audit_event(
    league_row.location_id,
    CASE WHEN p_event_id IS NULL THEN 'event.create' ELSE 'event.update' END,
    'events', event_id_value, before_row,
    (SELECT to_jsonb(e) FROM public.events e WHERE e.id = event_id_value)
  );
  RETURN event_id_value;
END;
$$;

-- Generated weeks ignored the league's default scoring format.
CREATE OR REPLACE FUNCTION public.admin_generate_schedule(p_league_id UUID, p_weeks JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  league_row public.league_config%ROWTYPE;
  week JSONB;
  inserted_count INTEGER := 0;
  affected INTEGER;
  format_value TEXT;
  format_config_value JSONB;
BEGIN
  SELECT * INTO league_row FROM public.league_config WHERE id = p_league_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(league_row.location_id);
  IF jsonb_typeof(p_weeks) <> 'array' THEN RAISE EXCEPTION 'weeks must be an array'; END IF;
  format_value := COALESCE(league_row.default_format, 'stroke');
  format_config_value := COALESCE(league_row.default_format_config, '{"version": 1}'::jsonb);
  PERFORM public.validate_format_config(format_value, format_config_value);
  FOR week IN SELECT value FROM jsonb_array_elements(p_weeks)
  LOOP
    INSERT INTO public.events (
      name, week_number, start_date, end_date, status, league_id, location_id, is_bye,
      format, format_config
    ) VALUES (
      COALESCE(NULLIF(week->>'name', ''), 'Week ' || (week->>'week_number')),
      (week->>'week_number')::integer, (week->>'start_date')::date,
      (week->>'end_date')::date, 'draft', p_league_id, league_row.location_id, false,
      format_value, format_config_value
    ) ON CONFLICT (location_id, league_id, week_number) DO NOTHING;
    GET DIAGNOSTICS affected = ROW_COUNT;
    inserted_count := inserted_count + affected;
  END LOOP;
  PERFORM public.write_audit_event(
    league_row.location_id, 'event.schedule_generate', 'league_config', p_league_id,
    NULL, jsonb_build_object('inserted', inserted_count, 'weeks', p_weeks)
  );
  RETURN inserted_count;
END;
$$;


-- ── 14. Money list ──────────────────────────────────────────────────────────
-- a) Signs weren't enforced: an entry fee typed as +50 showed the player owed.
-- b) Deleting a player/team silently cascaded away their ledger history.
-- c) Deleting a team with scores, or a player with handicap history, failed
--    with a raw foreign-key error.
CREATE OR REPLACE FUNCTION public.admin_add_ledger_entries(p_league_id UUID, p_entries JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  league_row public.league_config%ROWTYPE;
  entry JSONB;
  inserted INTEGER := 0;
  entry_player UUID;
  entry_team UUID;
  entry_event UUID;
  entry_amount NUMERIC;
BEGIN
  SELECT * INTO league_row FROM public.league_config WHERE id = p_league_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'League not found'; END IF;
  PERFORM public.require_location_admin(league_row.location_id);
  PERFORM public.require_feature_enabled(league_row.location_id, p_league_id, 'money');
  IF jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) = 0 THEN
    RAISE EXCEPTION 'entries must be a non-empty JSON array';
  END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(p_entries)
  LOOP
    IF entry->>'type' NOT IN ('entry_fee', 'skins', 'match_points', 'event_prize', 'payout', 'adjustment') THEN
      RAISE EXCEPTION 'Invalid ledger type: %', entry->>'type';
    END IF;
    entry_amount := round(NULLIF(entry->>'amount', '')::numeric, 2);
    IF entry_amount IS NULL OR entry_amount = 0 THEN
      RAISE EXCEPTION 'Each entry needs a non-zero numeric amount';
    END IF;
    IF entry->>'type' IN ('entry_fee', 'payout') AND entry_amount > 0 THEN
      RAISE EXCEPTION '% entries are money out and must be negative', entry->>'type';
    END IF;
    IF entry->>'type' IN ('skins', 'match_points', 'event_prize') AND entry_amount < 0 THEN
      RAISE EXCEPTION '% entries are winnings and must be positive', entry->>'type';
    END IF;
    entry_player := NULLIF(entry->>'player_id', '')::uuid;
    entry_team   := NULLIF(entry->>'team_id', '')::uuid;
    entry_event  := NULLIF(entry->>'event_id', '')::uuid;
    IF entry_player IS NULL AND entry_team IS NULL THEN
      RAISE EXCEPTION 'Each entry needs a player or a team';
    END IF;
    IF entry_player IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.players WHERE id = entry_player AND location_id = league_row.location_id
    ) THEN RAISE EXCEPTION 'Player is not in this location'; END IF;
    IF entry_team IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.teams WHERE id = entry_team AND location_id = league_row.location_id
    ) THEN RAISE EXCEPTION 'Team is not in this location'; END IF;
    IF entry_event IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.events WHERE id = entry_event AND location_id = league_row.location_id
    ) THEN RAISE EXCEPTION 'Event is not in this location'; END IF;

    INSERT INTO public.ledger (
      location_id, league_id, event_id, player_id, team_id, type, amount, note, created_by
    ) VALUES (
      league_row.location_id, p_league_id, entry_event,
      entry_player, entry_team,
      entry->>'type', entry_amount,
      NULLIF(trim(entry->>'note'), ''), auth.uid()
    );
    inserted := inserted + 1;
  END LOOP;

  PERFORM public.write_audit_event(
    league_row.location_id, 'ledger.add', 'league_config', p_league_id,
    NULL, jsonb_build_object('entries', p_entries, 'inserted', inserted)
  );
  RETURN inserted;
END;
$$;

ALTER TABLE public.ledger DROP CONSTRAINT IF EXISTS ledger_player_id_fkey;
ALTER TABLE public.ledger ADD CONSTRAINT ledger_player_id_fkey
  FOREIGN KEY (player_id) REFERENCES public.players(id) ON DELETE RESTRICT;
ALTER TABLE public.ledger DROP CONSTRAINT IF EXISTS ledger_team_id_fkey;
ALTER TABLE public.ledger ADD CONSTRAINT ledger_team_id_fkey
  FOREIGN KEY (team_id) REFERENCES public.teams(id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public.admin_delete_player(p_player_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE player_row public.players%ROWTYPE; score_count INTEGER;
BEGIN
  SELECT * INTO player_row FROM public.players WHERE id = p_player_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.require_location_admin(player_row.location_id);
  IF EXISTS (SELECT 1 FROM public.team_memberships WHERE player_id = p_player_id AND effective_to IS NULL) THEN
    RAISE EXCEPTION 'Remove or replace this player on their active team before deleting the profile';
  END IF;
  IF EXISTS (SELECT 1 FROM public.ledger WHERE player_id = p_player_id) THEN
    RAISE EXCEPTION 'This player has money-list entries. Delete those first (Money section) so the ledger stays accurate.';
  END IF;
  SELECT count(*) INTO score_count FROM public.scores WHERE player_id = p_player_id;
  DELETE FROM public.scores WHERE player_id = p_player_id;
  DELETE FROM public.handicap_history WHERE player_id = p_player_id;
  DELETE FROM public.subs WHERE player_id = p_player_id OR sub_player_id = p_player_id;
  DELETE FROM public.follows WHERE follower_id = p_player_id OR following_id = p_player_id;
  DELETE FROM public.messages WHERE sender_id = p_player_id OR recipient_id = p_player_id;
  DELETE FROM public.players WHERE id = p_player_id;
  PERFORM public.write_audit_event(
    player_row.location_id, 'player.delete', 'players', p_player_id, to_jsonb(player_row),
    jsonb_build_object('deleted', true, 'score_rows_deleted', score_count)
  );
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_team(p_team_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE team_row public.teams%ROWTYPE;
BEGIN
  SELECT * INTO team_row FROM public.teams WHERE id = p_team_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.require_location_admin(team_row.location_id);
  IF EXISTS (SELECT 1 FROM public.ledger WHERE team_id = p_team_id) THEN
    RAISE EXCEPTION 'This team has money-list entries. Delete those first (Money section) so the ledger stays accurate.';
  END IF;
  -- Scores reference their team; deleting a team that played would break
  -- standings history (and failed with a raw foreign-key error before).
  IF EXISTS (SELECT 1 FROM public.scores WHERE team_id = p_team_id) THEN
    RAISE EXCEPTION 'This team has recorded scores, so deleting it would erase standings history. Use a mid-season swap to change its players instead.';
  END IF;
  PERFORM set_config('app.roster_write', 'on', true);
  UPDATE public.players SET team_id = NULL WHERE team_id = p_team_id;
  DELETE FROM public.teams WHERE id = p_team_id;
  PERFORM public.write_audit_event(team_row.location_id, 'roster.team_delete', 'teams', p_team_id, to_jsonb(team_row), NULL);
  RETURN true;
END;
$$;

COMMIT;

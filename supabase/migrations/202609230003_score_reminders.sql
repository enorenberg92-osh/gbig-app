-- ============================================================================
-- Weekly "scores due" push reminder (2026-09-23)
-- ----------------------------------------------------------------------------
-- League nights run Mon–Thu; on a set morning (default Friday 09:00 local)
-- players whose team hasn't turned in the open week's scores get a push.
--
--   score_reminder_settings  one row per location (no row = defaults below)
--   score_reminder_log       one row per send; UNIQUE (location, event, kind,
--                            local_date) is the dedupe key, claimed BEFORE the
--                            push fan-out so re-runs can never double-send
--
-- Settings live in their own table rather than on `locations` because
-- locations is readable by every member and resolved publicly at boot; a
-- separate admin-only table keeps the RLS surface small, and "no row" cleanly
-- means "defaults" for locations created later.
--
-- The send-score-reminders edge function is the only sender:
--   * hourly scheduler (service role) -> score_reminders_claim_due()
--   * admin "Send now" (user JWT)     -> admin_start_score_reminder()
-- Both return the claimed sends (title, body, user_ids); the function pushes
-- and then records the outcome with score_reminder_finish().
--
-- Scheduling (pg_cron + pg_net) is deliberately NOT in this migration — see
-- supabase/functions/send-score-reminders/index.ts for the cron SQL.
--
-- Idempotent: safe to run more than once. Run the whole file in the Supabase
-- SQL editor (it is one transaction).
-- ============================================================================

BEGIN;

-- ── 1. Settings ─────────────────────────────────────────────────────────────
-- day_of_week follows Postgres EXTRACT(DOW) and JS Date#getDay (0 = Sunday).
-- The scheduler runs hourly, so the local send time is a whole hour.
CREATE TABLE IF NOT EXISTS public.score_reminder_settings (
  location_id UUID PRIMARY KEY REFERENCES public.locations(id) ON DELETE CASCADE,
  enabled     BOOLEAN  NOT NULL DEFAULT true,
  day_of_week SMALLINT NOT NULL DEFAULT 5  CHECK (day_of_week BETWEEN 0 AND 6),
  send_hour   SMALLINT NOT NULL DEFAULT 9  CHECK (send_hour BETWEEN 0 AND 23),
  audience    TEXT     NOT NULL DEFAULT 'missing' CHECK (audience IN ('missing', 'all')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  UUID
);

ALTER TABLE public.score_reminder_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "score_reminder_settings: admins read" ON public.score_reminder_settings;
CREATE POLICY "score_reminder_settings: admins read" ON public.score_reminder_settings
  FOR SELECT TO authenticated
  USING (public.is_admin_of_location(location_id) OR public.is_super_admin());
-- Writes only through admin_set_score_reminder_settings().
REVOKE ALL ON public.score_reminder_settings FROM anon, authenticated;
GRANT SELECT ON public.score_reminder_settings TO authenticated;


-- ── 2. Send log / dedupe ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.score_reminder_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  event_id    UUID NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('scheduled', 'manual')),
  local_date  DATE NOT NULL,
  audience    TEXT NOT NULL CHECK (audience IN ('missing', 'all')),
  recipients  INTEGER NOT NULL DEFAULT 0,   -- audience players with an app account
  devices     INTEGER,
  sent        INTEGER,
  failed      INTEGER,
  status      TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'sent', 'empty', 'failed')),
  sent_by     UUID,                         -- admin for 'manual', NULL for 'scheduled'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  CONSTRAINT score_reminder_log_once UNIQUE (location_id, event_id, kind, local_date)
);
CREATE INDEX IF NOT EXISTS score_reminder_log_location_created_idx
  ON public.score_reminder_log (location_id, created_at DESC);

ALTER TABLE public.score_reminder_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "score_reminder_log: admins read" ON public.score_reminder_log;
CREATE POLICY "score_reminder_log: admins read" ON public.score_reminder_log
  FOR SELECT TO authenticated
  USING (public.is_admin_of_location(location_id) OR public.is_super_admin());
REVOKE ALL ON public.score_reminder_log FROM anon, authenticated;
GRANT SELECT ON public.score_reminder_log TO authenticated;


-- ── 3. Internal helpers (not callable by clients) ───────────────────────────

-- Location timezone, falling back to Central if someone saved a bad name
-- (AT TIME ZONE would otherwise abort the whole hourly run).
CREATE OR REPLACE FUNCTION public.score_reminder_tz(p_tz TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = p_tz) THEN p_tz
    ELSE 'America/Chicago'
  END;
$$;

-- Open, non-bye weeks of player-visible leagues that have already started by
-- p_local_date. A week opened early for next Monday is not "due" yet.
CREATE OR REPLACE FUNCTION public.score_reminder_events(p_location_id UUID, p_local_date DATE)
RETURNS TABLE (event_id UUID, league_id UUID, league_name TEXT, week_number INTEGER)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.id, e.league_id, lc.name, e.week_number
    FROM public.events e
    JOIN public.league_config lc ON lc.id = e.league_id AND lc.location_id = e.location_id
   WHERE e.location_id = p_location_id
     AND e.status = 'open'
     AND NOT COALESCE(e.is_bye, false)
     AND COALESCE(lc.is_active, false)
     AND COALESCE(e.start_date, e.event_date, p_local_date) <= p_local_date
   ORDER BY lc.name, e.week_number;
$$;

-- Who a reminder for this event goes to.
--   'all'     everyone rostered for the event (roster_at)
--   'missing' rostered players whose team has no non-rejected played score
--             for the event yet (pending counts as submitted)
CREATE OR REPLACE FUNCTION public.score_reminder_audience(p_event_id UUID, p_audience TEXT)
RETURNS TABLE (player_id UUID, user_id UUID, team_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH roster AS (
    SELECT r.player_id, r.team_id FROM public.roster_at r WHERE r.event_id = p_event_id
  ), submitted AS (
    -- By the score's team tag, or by any rostered teammate's row (admin-entered
    -- rows may predate team tagging).
    SELECT s.team_id FROM public.scores s
     WHERE s.event_id = p_event_id AND s.entry_type = 'played' AND s.status <> 'rejected'
       AND s.team_id IS NOT NULL
    UNION
    SELECT r.team_id FROM roster r
      JOIN public.scores s ON s.event_id = p_event_id AND s.player_id = r.player_id
     WHERE s.entry_type = 'played' AND s.status <> 'rejected'
  )
  SELECT r.player_id, p.user_id, r.team_id
    FROM roster r
    JOIN public.players p ON p.id = r.player_id
   WHERE p_audience = 'all'
      OR r.team_id NOT IN (SELECT t.team_id FROM submitted t WHERE t.team_id IS NOT NULL);
$$;

CREATE OR REPLACE FUNCTION public.score_reminder_message(p_week_number INTEGER, p_audience TEXT)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'title', 'Scores due',
    'body', CASE WHEN p_week_number IS NULL THEN 'This week''s' ELSE 'Week ' || p_week_number END
      || CASE WHEN p_audience = 'all'
           THEN ' scores are due — if your team hasn''t submitted yet, enter your round in the app.'
           ELSE ' scores are due — submit your team''s round in the app.'
         END
  );
$$;

-- Claim one (location, event, kind, local_date) slot. Returns the send payload,
-- or NULL when that slot was already claimed (the dedupe path).
CREATE OR REPLACE FUNCTION public.score_reminder_claim(
  p_location_id UUID,
  p_event_id UUID,
  p_kind TEXT,
  p_local_date DATE,
  p_audience TEXT,
  p_sent_by UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  log_id UUID;
  week INTEGER;
  user_ids UUID[];
BEGIN
  SELECT e.week_number INTO week FROM public.events e WHERE e.id = p_event_id;
  SELECT COALESCE(array_agg(DISTINCT a.user_id) FILTER (WHERE a.user_id IS NOT NULL), '{}')
    INTO user_ids
    FROM public.score_reminder_audience(p_event_id, p_audience) a;

  INSERT INTO public.score_reminder_log (location_id, event_id, kind, local_date, audience, recipients, status, sent_by)
  VALUES (p_location_id, p_event_id, p_kind, p_local_date, p_audience, cardinality(user_ids),
          CASE WHEN cardinality(user_ids) = 0 THEN 'empty' ELSE 'claimed' END, p_sent_by)
  ON CONFLICT ON CONSTRAINT score_reminder_log_once DO NOTHING
  RETURNING id INTO log_id;

  IF log_id IS NULL THEN RETURN NULL; END IF;

  RETURN jsonb_build_object(
    'log_id', log_id,
    'location_id', p_location_id,
    'event_id', p_event_id,
    'week_number', week,
    'kind', p_kind,
    'local_date', p_local_date,
    'audience', p_audience,
    'user_ids', to_jsonb(user_ids)
  ) || public.score_reminder_message(week, p_audience);
END;
$$;

REVOKE ALL ON FUNCTION public.score_reminder_tz(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.score_reminder_events(UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.score_reminder_audience(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.score_reminder_message(INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.score_reminder_claim(UUID, UUID, TEXT, DATE, TEXT, UUID) FROM PUBLIC, anon, authenticated;


-- ── 4. Admin RPCs ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.admin_set_score_reminder_settings(
  p_location_id UUID,
  p_enabled BOOLEAN,
  p_day_of_week INTEGER,
  p_send_hour INTEGER,
  p_audience TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  before_row JSONB;
  after_row public.score_reminder_settings%ROWTYPE;
BEGIN
  PERFORM public.require_location_admin(p_location_id);
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'enabled is required'; END IF;
  IF p_day_of_week IS NULL OR p_day_of_week NOT BETWEEN 0 AND 6 THEN
    RAISE EXCEPTION 'day_of_week must be 0 (Sunday) to 6 (Saturday)';
  END IF;
  IF p_send_hour IS NULL OR p_send_hour NOT BETWEEN 0 AND 23 THEN
    RAISE EXCEPTION 'send_hour must be 0 to 23';
  END IF;
  IF p_audience IS NULL OR p_audience NOT IN ('missing', 'all') THEN
    RAISE EXCEPTION 'audience must be missing or all';
  END IF;

  SELECT to_jsonb(s) INTO before_row FROM public.score_reminder_settings s WHERE s.location_id = p_location_id;

  INSERT INTO public.score_reminder_settings AS s
    (location_id, enabled, day_of_week, send_hour, audience, updated_at, updated_by)
  VALUES (p_location_id, p_enabled, p_day_of_week, p_send_hour, p_audience, now(), auth.uid())
  ON CONFLICT (location_id) DO UPDATE
    SET enabled = EXCLUDED.enabled,
        day_of_week = EXCLUDED.day_of_week,
        send_hour = EXCLUDED.send_hour,
        audience = EXCLUDED.audience,
        updated_at = now(),
        updated_by = auth.uid()
  RETURNING * INTO after_row;

  PERFORM public.write_audit_event(
    p_location_id, 'score_reminder.settings', 'score_reminder_settings', p_location_id,
    before_row, to_jsonb(after_row)
  );
  RETURN to_jsonb(after_row);
END;
$$;

-- Everything the settings card needs in one round trip: effective settings,
-- per-event audience counts for BOTH audiences (so flipping the picker needs no
-- refetch), and the most recent send.
CREATE OR REPLACE FUNCTION public.admin_score_reminder_preview(p_location_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tz TEXT;
  local_date DATE;
  settings JSONB;
  events JSONB;
  last_sent JSONB;
BEGIN
  PERFORM public.require_location_admin(p_location_id);

  SELECT public.score_reminder_tz(l.timezone) INTO tz FROM public.locations l WHERE l.id = p_location_id;
  IF tz IS NULL THEN RAISE EXCEPTION 'Location not found'; END IF;
  local_date := (now() AT TIME ZONE tz)::date;

  SELECT jsonb_build_object(
    'enabled',     COALESCE(s.enabled, true),
    'day_of_week', COALESCE(s.day_of_week, 5),
    'send_hour',   COALESCE(s.send_hour, 9),
    'audience',    COALESCE(s.audience, 'missing'),
    'timezone',    tz,
    'saved',       s.location_id IS NOT NULL
  ) INTO settings
  FROM (SELECT 1) one
  LEFT JOIN public.score_reminder_settings s ON s.location_id = p_location_id;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'event_id', ev.event_id,
    'league_name', ev.league_name,
    'week_number', ev.week_number,
    'counts', jsonb_build_object(
      'missing', (
        SELECT jsonb_build_object(
          'players', count(*),
          'with_app', count(a.user_id),
          'devices', (SELECT count(*) FROM public.push_subscriptions ps
                       WHERE ps.location_id = p_location_id AND ps.user_id IN (SELECT a2.user_id FROM public.score_reminder_audience(ev.event_id, 'missing') a2)))
          FROM public.score_reminder_audience(ev.event_id, 'missing') a),
      'all', (
        SELECT jsonb_build_object(
          'players', count(*),
          'with_app', count(a.user_id),
          'devices', (SELECT count(*) FROM public.push_subscriptions ps
                       WHERE ps.location_id = p_location_id AND ps.user_id IN (SELECT a2.user_id FROM public.score_reminder_audience(ev.event_id, 'all') a2)))
          FROM public.score_reminder_audience(ev.event_id, 'all') a)
    )
  )), '[]'::jsonb) INTO events
  FROM public.score_reminder_events(p_location_id, local_date) ev;

  SELECT to_jsonb(x) INTO last_sent FROM (
    SELECT l.kind, l.status, l.recipients, l.devices, l.sent, l.failed, l.local_date,
           COALESCE(l.finished_at, l.created_at) AS sent_at, e.week_number
      FROM public.score_reminder_log l
      LEFT JOIN public.events e ON e.id = l.event_id
     WHERE l.location_id = p_location_id
     ORDER BY l.created_at DESC
     LIMIT 1
  ) x;

  RETURN jsonb_build_object('settings', settings, 'local_date', local_date, 'events', events, 'last_sent', last_sent);
END;
$$;

-- "Send reminder now": claims today's manual slot for every due event at the
-- location. Called by the send-score-reminders function with the admin's JWT
-- (so auth.uid() is the admin); the function then does the push fan-out.
-- Once per event per local day — a second tap returns no sends.
CREATE OR REPLACE FUNCTION public.admin_start_score_reminder(p_location_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tz TEXT;
  local_date DATE;
  aud TEXT;
  ev RECORD;
  claim JSONB;
  sends JSONB := '[]'::jsonb;
  already INTEGER := 0;
BEGIN
  PERFORM public.require_location_admin(p_location_id);

  SELECT public.score_reminder_tz(l.timezone) INTO tz FROM public.locations l WHERE l.id = p_location_id;
  IF tz IS NULL THEN RAISE EXCEPTION 'Location not found'; END IF;
  local_date := (now() AT TIME ZONE tz)::date;
  SELECT COALESCE((SELECT s.audience FROM public.score_reminder_settings s WHERE s.location_id = p_location_id), 'missing')
    INTO aud;

  FOR ev IN SELECT * FROM public.score_reminder_events(p_location_id, local_date) LOOP
    claim := public.score_reminder_claim(p_location_id, ev.event_id, 'manual', local_date, aud, auth.uid());
    IF claim IS NULL THEN
      already := already + 1;
    ELSE
      sends := sends || jsonb_build_array(claim);
      PERFORM public.write_audit_event(
        p_location_id, 'score_reminder.send_now', 'events', ev.event_id, NULL,
        jsonb_build_object('audience', aud, 'recipients', jsonb_array_length(claim->'user_ids'))
      );
    END IF;
  END LOOP;

  RETURN jsonb_build_object('sends', sends, 'already_sent', already);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_score_reminder_settings(UUID, BOOLEAN, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_score_reminder_preview(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_start_score_reminder(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_score_reminder_settings(UUID, BOOLEAN, INTEGER, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_score_reminder_preview(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_start_score_reminder(UUID) TO authenticated;


-- ── 5. Scheduler RPCs (service role only) ───────────────────────────────────

-- Every location whose local weekday + hour match its settings right now:
-- claim the 'scheduled' slot for each due event and return the sends.
-- Skips an event that already got ANY reminder (e.g. an admin's manual one)
-- earlier the same local day. p_now is overridable for tests.
CREATE OR REPLACE FUNCTION public.score_reminders_claim_due(p_now TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  loc RECORD;
  ev RECORD;
  claim JSONB;
  sends JSONB := '[]'::jsonb;
BEGIN
  FOR loc IN
    SELECT x.* FROM (
      SELECT l.id AS location_id,
             (p_now AT TIME ZONE public.score_reminder_tz(l.timezone)) AS local_ts,
             COALESCE(s.enabled, true)        AS enabled,
             COALESCE(s.day_of_week, 5)       AS day_of_week,
             COALESCE(s.send_hour, 9)         AS send_hour,
             COALESCE(s.audience, 'missing')  AS audience
        FROM public.locations l
        LEFT JOIN public.score_reminder_settings s ON s.location_id = l.id
    ) x
    WHERE x.enabled
      AND EXTRACT(DOW FROM x.local_ts) = x.day_of_week
      AND EXTRACT(HOUR FROM x.local_ts) = x.send_hour
  LOOP
    FOR ev IN SELECT * FROM public.score_reminder_events(loc.location_id, loc.local_ts::date) LOOP
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.score_reminder_log g
         WHERE g.location_id = loc.location_id AND g.event_id = ev.event_id
           AND g.local_date = loc.local_ts::date
      );
      claim := public.score_reminder_claim(loc.location_id, ev.event_id, 'scheduled', loc.local_ts::date, loc.audience, NULL);
      IF claim IS NOT NULL THEN sends := sends || jsonb_build_array(claim); END IF;
    END LOOP;
  END LOOP;
  RETURN sends;
END;
$$;

-- Record how the fan-out went for a claimed slot.
CREATE OR REPLACE FUNCTION public.score_reminder_finish(
  p_log_id UUID,
  p_devices INTEGER,
  p_sent INTEGER,
  p_failed INTEGER
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.score_reminder_log
     SET devices = p_devices,
         sent = p_sent,
         failed = p_failed,
         status = CASE
           WHEN COALESCE(p_devices, 0) = 0 THEN 'empty'
           WHEN COALESCE(p_sent, 0) = 0 THEN 'failed'
           ELSE 'sent'
         END,
         finished_at = now()
   WHERE id = p_log_id;
$$;

REVOKE ALL ON FUNCTION public.score_reminders_claim_due(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.score_reminder_finish(UUID, INTEGER, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.score_reminders_claim_due(TIMESTAMPTZ) TO service_role;
GRANT EXECUTE ON FUNCTION public.score_reminder_finish(UUID, INTEGER, INTEGER, INTEGER) TO service_role;

COMMIT;

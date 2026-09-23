-- Targeted tests for supabase/migrations/202609230003_score_reminders.sql
-- Run after 20_seed.sql on a fresh DB.
\set ON_ERROR_STOP 0
\pset pager off
\pset footer off
\pset tuples_only on
\i 29_ids.psql
TRUNCATE harness.results;
-- the scheduler RPCs run as service_role; let it record results too
GRANT USAGE ON SCHEMA harness TO service_role;
-- create-player-account links accounts server-side; mirror that for p1.
UPDATE public.players SET user_id = :u1 WHERE id = :p1;

\set par '''[4,3,4,5,4,3,4,4,5]'''

-- ── setup: open week 1, push devices for u1, u3, u5 (A) and ub1 (B) ─────────
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, jsonb_build_object('name','Week 1','start_date','2026-09-01','end_date','2026-09-07','status','open','course_id',%L,'week_number',1))::text$q$, :e1, :league_a, :course_a)) AS r \gset
SELECT harness.ok('setup: open week 1', :'r' LIKE 'OK%', :'r');
RESET ROLE;
INSERT INTO public.push_subscriptions (endpoint, p256dh, auth_key, user_id, location_id) VALUES
  ('https://fcm.googleapis.com/fcm/send/r1', 'k', 'a', :u1, :loc_a),
  ('https://fcm.googleapis.com/fcm/send/r3', 'k', 'a', :u3, :loc_a),
  ('https://fcm.googleapis.com/fcm/send/r5', 'k', 'a', :u5, :loc_a),
  ('https://fcm.googleapis.com/fcm/send/rb1', 'k', 'a', :ub1, :loc_b);

-- ── 1. defaults + admin gating on preview ───────────────────────────────────
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT admin_score_reminder_preview(:loc_a) AS pv \gset
SELECT harness.ok('preview defaults: enabled, Friday, 9, missing, unsaved',
  (:'pv'::jsonb->'settings') @> '{"enabled":true,"day_of_week":5,"send_hour":9,"audience":"missing","saved":false,"timezone":"America/Chicago"}', :'pv');
SELECT harness.ok('preview lists the open week', jsonb_array_length(:'pv'::jsonb->'events') = 1
  AND (:'pv'::jsonb->'events'->0->>'week_number') = '1', :'pv');
SELECT harness.ok('preview counts before any submission: 8 missing, 8 all, 3 devices',
  (:'pv'::jsonb->'events'->0->'counts') @> '{"missing":{"players":8,"with_app":8,"devices":3},"all":{"players":8,"devices":3}}',
  :'pv'::jsonb->'events'->0->>'counts');
SELECT harness.ok('preview last_sent is null before any send', (:'pv'::jsonb->'last_sent') = 'null'::jsonb OR NOT (:'pv'::jsonb ? 'last_sent') OR :'pv'::jsonb->'last_sent' IS NULL, :'pv');

SELECT harness.login(:u1, 'p1@a.test');
SELECT harness.try(format($q$SELECT admin_score_reminder_preview(%L)::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('player cannot preview', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.login(:admin_b, 'admin@b.test');
SELECT harness.try(format($q$SELECT admin_score_reminder_preview(%L)::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('other-location admin cannot preview', :'r' LIKE 'ERR 42501%', :'r');

-- ── 2. settings writes: RPC only, admin only, validated, audited ────────────
SELECT harness.login(:u1, 'p1@a.test');
SELECT harness.try(format($q$SELECT admin_set_score_reminder_settings(%L, false, 5, 9, 'missing')::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('player cannot change settings', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.login(:admin_b, 'admin@b.test');
SELECT harness.try(format($q$SELECT admin_set_score_reminder_settings(%L, false, 5, 9, 'missing')::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('other-location admin cannot change settings', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.login(:admin_a, 'admin@a.test');
SELECT harness.try(format($q$INSERT INTO public.score_reminder_settings (location_id, enabled) VALUES (%L, false) RETURNING 'x'$q$, :loc_a)) AS r \gset
SELECT harness.ok('admin cannot write settings table directly', :'r' LIKE 'ERR%', :'r');
SELECT harness.try(format($q$SELECT admin_set_score_reminder_settings(%L, true, 7, 9, 'missing')::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('day_of_week 7 rejected', :'r' LIKE 'ERR%', :'r');
SELECT harness.try(format($q$SELECT admin_set_score_reminder_settings(%L, true, 5, 24, 'missing')::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('send_hour 24 rejected', :'r' LIKE 'ERR%', :'r');
SELECT harness.try(format($q$SELECT admin_set_score_reminder_settings(%L, true, 5, 9, 'everyone')::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('bad audience rejected', :'r' LIKE 'ERR%', :'r');
SELECT harness.try(format($q$SELECT admin_set_score_reminder_settings(%L, true, 5, 9, 'missing')::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('admin saves settings', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT admin_set_score_reminder_settings(%L, true, 5, 9, 'missing')::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('admin re-save (upsert) works', :'r' LIKE 'OK%', :'r');
SELECT harness.ok('admin reads own settings row', (SELECT count(*) FROM public.score_reminder_settings) = 1);
SELECT harness.login(:admin_b, 'admin@b.test');
SELECT harness.ok('other admin cannot read A settings', (SELECT count(*) FROM public.score_reminder_settings) = 0);
SELECT harness.login(:u1, 'p1@a.test');
SELECT harness.ok('player cannot read settings', (SELECT count(*) FROM public.score_reminder_settings) = 0);
SELECT harness.ok('player cannot read reminder log', (SELECT count(*) FROM public.score_reminder_log) = 0);
RESET ROLE;
SELECT harness.ok('settings change audited',
  (SELECT count(*) FROM public.audit_events WHERE action = 'score_reminder.settings' AND location_id = :loc_a) = 2);
SET ROLE anon;
SELECT harness.try($q$SELECT count(*)::text FROM public.score_reminder_settings$q$) AS r \gset
SELECT harness.ok('anon cannot read settings', :'r' LIKE 'ERR%', :'r');
RESET ROLE;

-- ── 3. audience: submitted (pending) teams drop out; rejected ones return ──
SELECT harness.login(:u1, 'p1@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT submit_scores(%L, jsonb_build_array(
  jsonb_build_object('player_id', %L, 'hole_scores', %L::jsonb),
  jsonb_build_object('player_id', %L, 'hole_scores', %L::jsonb)))::text$q$, :e1, :p1, :par, :p2, :par)) AS r \gset
SELECT harness.ok('team 1 submits (pending)', :'r' LIKE 'OK%', :'r');
SELECT harness.login(:admin_a, 'admin@a.test');
SELECT admin_score_reminder_preview(:loc_a)->'events'->0->'counts' AS c \gset
SELECT harness.ok('pending team excluded from missing: 6 players, 2 devices; all unchanged',
  :'c'::jsonb @> '{"missing":{"players":6,"devices":2},"all":{"players":8,"devices":3}}', :'c');
RESET ROLE;
UPDATE public.scores SET status = 'rejected' WHERE event_id = :e1;
SELECT harness.ok('rejected submission counts as missing again',
  (SELECT count(*) FROM public.score_reminder_audience(:e1, 'missing')) = 8);
UPDATE public.scores SET status = 'pending' WHERE event_id = :e1;
SELECT harness.ok('audience is rostered players only (p9 unrostered)',
  NOT EXISTS (SELECT 1 FROM public.score_reminder_audience(:e1, 'all') WHERE player_id = :p9));

-- ── 4. scheduler: service role only, local day/hour match, dedupe ──────────
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try($q$SELECT score_reminders_claim_due()::text$q$) AS r \gset
SELECT harness.ok('authenticated cannot call scheduler RPC', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try($q$SELECT score_reminder_audience(gen_random_uuid(), 'all')::text$q$) AS r \gset
SELECT harness.ok('authenticated cannot call internal audience fn', :'r' LIKE 'ERR 42501%', :'r');
SET ROLE service_role;
-- Thu 2026-09-24 09:15 Chicago (CDT = UTC-5) is the wrong day
SELECT score_reminders_claim_due('2026-09-24 14:15+00') AS s \gset
SELECT harness.ok('Thursday 09:15: nothing due', :'s'::jsonb = '[]', :'s');
-- Fri 2026-09-25 08:15 Chicago: wrong hour
SELECT score_reminders_claim_due('2026-09-25 13:15+00') AS s \gset
SELECT harness.ok('Friday 08:15: nothing due', :'s'::jsonb = '[]', :'s');
-- Fri 2026-09-25 09:15 Chicago: due
SELECT score_reminders_claim_due('2026-09-25 14:15+00') AS s \gset
SELECT harness.ok('Friday 09:15 Chicago: one send for loc A week 1',
  jsonb_array_length(:'s'::jsonb) = 1 AND (:'s'::jsonb->0->>'event_id') = :e1
  AND (:'s'::jsonb->0->>'kind') = 'scheduled' AND (:'s'::jsonb->0->>'local_date') = '2026-09-25', :'s');
SELECT harness.ok('send targets the 6 players on unsubmitted teams',
  jsonb_array_length(:'s'::jsonb->0->'user_ids') = 6
  AND NOT (:'s'::jsonb->0->'user_ids') ? :u1 AND NOT (:'s'::jsonb->0->'user_ids') ? :u2
  AND (:'s'::jsonb->0->'user_ids') ? :u3, :'s'::jsonb->0->>'user_ids');
SELECT harness.ok('message: Scores due / Week 1 ...',
  (:'s'::jsonb->0->>'title') = 'Scores due'
  AND (:'s'::jsonb->0->>'body') = 'Week 1 scores are due — submit your team''s round in the app.', :'s'::jsonb->0->>'body');
SELECT :'s'::jsonb->0->>'log_id' AS log_id \gset
SELECT score_reminders_claim_due('2026-09-25 14:45+00') AS s \gset
SELECT harness.ok('re-run same hour: deduped', :'s'::jsonb = '[]', :'s');
SELECT harness.try($q$SELECT score_reminder_finish('$q$ || :'log_id' || $q$', 3, 2, 1)::text$q$) AS r \gset
SELECT harness.ok('service role records outcome', :'r' LIKE 'OK%', :'r');
RESET ROLE;
SELECT harness.ok('one scheduled log row with outcome',
  (SELECT count(*) = 1 AND bool_and(status = 'sent' AND devices = 3 AND sent = 2 AND failed = 1 AND recipients = 6 AND finished_at IS NOT NULL)
     FROM public.score_reminder_log WHERE location_id = :loc_a));
SELECT harness.try(format($q$INSERT INTO public.score_reminder_log (location_id, event_id, kind, local_date, audience) VALUES (%L, %L, 'scheduled', '2026-09-25', 'missing') RETURNING 'x'$q$, :loc_a, :e1)) AS r \gset
SELECT harness.ok('log unique (location,event,kind,local_date)', :'r' LIKE 'ERR 23505%', :'r');
SELECT harness.try(format($q$INSERT INTO public.score_reminder_log (location_id, event_id, kind, local_date, audience) VALUES (%L, %L, 'manual', '2026-09-25', 'missing') RETURNING 'x'$q$, :loc_a, :e1)) AS r \gset
SELECT harness.ok('different kind same day is a separate slot', :'r' LIKE 'OK%', :'r');
DELETE FROM public.score_reminder_log WHERE kind = 'manual';
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.ok('admin reads own reminder log', (SELECT count(*) FROM public.score_reminder_log) = 1);
SELECT admin_score_reminder_preview(:loc_a)->'last_sent' AS ls \gset
SELECT harness.ok('preview shows last send', (:'ls'::jsonb->>'kind') = 'scheduled' AND (:'ls'::jsonb->>'sent') = '2', :'ls');
SELECT harness.login(:admin_b, 'admin@b.test');
SELECT harness.ok('other admin cannot read A reminder log', (SELECT count(*) FROM public.score_reminder_log) = 0);

-- next Friday: new local date -> sends again (weekly cadence)
SET ROLE service_role;
SELECT score_reminders_claim_due('2026-10-02 14:15+00') AS s \gset
SELECT harness.ok('next Friday sends again', jsonb_array_length(:'s'::jsonb) = 1, :'s');
RESET ROLE;

-- ── 5. settings honoured: disabled, custom day/hour, audience=all ───────────
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT admin_set_score_reminder_settings(:loc_a, false, 5, 9, 'missing') IS NOT NULL AS x \gset
SET ROLE service_role;
SELECT score_reminders_claim_due('2026-10-09 14:15+00') AS s \gset
SELECT harness.ok('disabled: nothing sent', :'s'::jsonb = '[]', :'s');
RESET ROLE;
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT admin_set_score_reminder_settings(:loc_a, true, 6, 18, 'all') IS NOT NULL AS x \gset
SET ROLE service_role;
-- Sat 2026-10-10 18:05 Chicago = 23:05 UTC
SELECT score_reminders_claim_due('2026-10-10 23:05+00') AS s \gset
SELECT harness.ok('custom Saturday 18:00 + audience all: 8 recipients, "all" wording',
  jsonb_array_length(:'s'::jsonb) = 1 AND jsonb_array_length(:'s'::jsonb->0->'user_ids') = 8
  AND (:'s'::jsonb->0->>'body') LIKE '%if your team hasn''t submitted yet%', :'s');
RESET ROLE;

-- ── 6. timezones, inactive leagues, byes, future weeks ──────────────────────
UPDATE public.locations SET timezone = 'America/New_York' WHERE id = :loc_b;
UPDATE public.events SET status = 'open' WHERE id = :eb1;
SET ROLE service_role;
-- Fri 2026-10-16 09:10 New York = 13:10 UTC = 08:10 Chicago
SELECT score_reminders_claim_due('2026-10-16 13:10+00') AS s \gset
SELECT harness.ok('09:10 New York: only loc B is due (A is on Saturdays anyway)',
  jsonb_array_length(:'s'::jsonb) = 1 AND (:'s'::jsonb->0->>'location_id') = :loc_b::text, :'s');
SELECT harness.ok('loc B send targets both B players', jsonb_array_length(:'s'::jsonb->0->'user_ids') = 2, :'s');
RESET ROLE;
UPDATE public.locations SET timezone = 'Mars/Olympus' WHERE id = :loc_b;
SET ROLE service_role;
-- bad tz falls back to Chicago: Fri 2026-10-23 09:20 Chicago = 14:20 UTC
SELECT harness.try($q$SELECT score_reminders_claim_due('2026-10-23 14:20+00')::text$q$) AS r \gset
SELECT harness.ok('invalid timezone falls back to Chicago, run does not abort',
  :'r' LIKE 'OK%' AND :'r' LIKE '%' || :loc_b::text || '%', :'r');
RESET ROLE;
UPDATE public.league_config SET is_active = false WHERE id = :league_b;
SET ROLE service_role;
SELECT score_reminders_claim_due('2026-10-30 14:20+00') AS s \gset
SELECT harness.ok('league hidden from players (is_active=false): no reminder', :'s'::jsonb = '[]', :'s');
RESET ROLE;
UPDATE public.league_config SET is_active = true WHERE id = :league_b;
UPDATE public.events SET is_bye = true WHERE id = :eb1;
SET ROLE service_role;
SELECT score_reminders_claim_due('2026-11-06 15:20+00') AS s \gset
SELECT harness.ok('bye week: no reminder', :'s'::jsonb = '[]', :'s');
RESET ROLE;
UPDATE public.events SET is_bye = false, start_date = '2026-11-16' WHERE id = :eb1;
SET ROLE service_role;
SELECT score_reminders_claim_due('2026-11-13 15:20+00') AS s \gset
SELECT harness.ok('week that has not started yet: no reminder', :'s'::jsonb = '[]', :'s');
RESET ROLE;

-- ── 7. manual "Send now" ────────────────────────────────────────────────────
SELECT harness.login(:u1, 'p1@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_start_score_reminder(%L)::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('player cannot send now', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.login(:admin_b, 'admin@b.test');
SELECT harness.try(format($q$SELECT admin_start_score_reminder(%L)::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('other-location admin cannot send now', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.login(:admin_a, 'admin@a.test');
SELECT admin_start_score_reminder(:loc_a) AS m \gset
SELECT harness.ok('admin send now claims a manual send (audience from settings = all)',
  jsonb_array_length(:'m'::jsonb->'sends') = 1 AND (:'m'::jsonb->'sends'->0->>'kind') = 'manual'
  AND jsonb_array_length(:'m'::jsonb->'sends'->0->'user_ids') = 8, :'m');
SELECT admin_start_score_reminder(:loc_a) AS m2 \gset
SELECT harness.ok('second send now same day: deduped', jsonb_array_length(:'m2'::jsonb->'sends') = 0
  AND (:'m2'::jsonb->>'already_sent') = '1', :'m2');
RESET ROLE;
SELECT harness.ok('manual send audited with sender',
  (SELECT count(*) FROM public.audit_events WHERE action = 'score_reminder.send_now' AND actor_id = :admin_a) = 1
  AND (SELECT sent_by FROM public.score_reminder_log WHERE kind = 'manual') = :admin_a);
-- scheduled run later the same local day skips an event that already got a manual reminder
SELECT (now() AT TIME ZONE 'America/Chicago')::date AS today,
       EXTRACT(DOW FROM (now() AT TIME ZONE 'America/Chicago'))::int AS dow \gset
UPDATE public.score_reminder_settings SET day_of_week = :dow, send_hour = 23 WHERE location_id = :loc_a;
SET ROLE service_role;
SELECT score_reminders_claim_due(((:'today')::date + time '23:30') AT TIME ZONE 'America/Chicago') AS s \gset
SELECT harness.ok('scheduled run skips event already reminded manually today',
  NOT (:'s'::text LIKE '%' || :loc_a::text || '%'), :'s');
RESET ROLE;

-- ── 8. migration re-run is idempotent (checked by re-applying the file) ─────

SELECT count(*) FILTER (WHERE pass) || ' passed, ' || count(*) FILTER (WHERE NOT pass) || ' failed' FROM harness.results;
SELECT 'FAIL ' || label || COALESCE(' :: ' || info, '') FROM harness.results WHERE NOT pass;

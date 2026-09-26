-- Targeted tests for supabase/migrations/202609230006_bay_checkin.sql
-- Runs on a fresh clone of the seeded template (run_all.sh picks it up).
\set ON_ERROR_STOP 0
\pset pager off
\pset footer off
\pset tuples_only on
\i 29_ids.psql
TRUNCATE harness.results;
RESET ROLE;
-- sim_bay is service-role only; let that role use the harness helpers.
GRANT USAGE ON SCHEMA harness TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA harness TO service_role;
GRANT ALL ON harness.results TO service_role;
GRANT ALL ON SEQUENCE harness.results_n_seq TO service_role;

-- ── setup: open week 1 ──────────────────────────────────────────────────────
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, jsonb_build_object('name','Week 1','start_date','2026-09-01','end_date','2026-09-07','status','open','course_id',%L,'week_number',1))::text$q$, :e1, :league_a, :course_a)) AS r \gset
SELECT harness.ok('setup: open week 1', :'r' LIKE 'OK%', :'r');

-- ── 1. migration: realtime + idempotent re-run ──────────────────────────────
RESET ROLE;
SELECT harness.ok('bay_checkins is in supabase_realtime',
  EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'bay_checkins'));
\i /home/user/gbig-app/supabase/migrations/202609230006_bay_checkin.sql
\i /home/user/gbig-app/supabase/migrations/202609230006_bay_checkin.sql
SELECT harness.ok('re-run is idempotent (publication entry once)',
  (SELECT count(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'bay_checkins') = 1);

-- ── 2. admin_set_bays / admin_rename_bay ────────────────────────────────────
SELECT harness.login(:u1, 'p1@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_set_bays(%L, 4)::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('player cannot set bays', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.login(:admin_b, 'admin@b.test');
SELECT harness.try(format($q$SELECT admin_set_bays(%L, 4)::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('other location admin cannot set bays', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.login(:admin_a, 'admin@a.test');
SELECT harness.try(format($q$SELECT jsonb_array_length(admin_set_bays(%L, 4))$q$, :loc_a)) AS r \gset
SELECT harness.ok('admin creates 4 bays', :'r' = 'OK: 4', :'r');
SELECT harness.ok('bays labelled 1..4 in order',
  (SELECT string_agg(label, ',' ORDER BY sort) FROM public.location_bays WHERE location_id = :loc_a AND active) = '1,2,3,4');
SELECT harness.try(format($q$SELECT jsonb_array_length(admin_set_bays(%L, 2))$q$, :loc_a)) AS r \gset
SELECT harness.ok('shrinking to 2 deactivates extras, keeps rows',
  :'r' = 'OK: 2' AND (SELECT count(*) FROM public.location_bays WHERE location_id = :loc_a) = 4
  AND (SELECT count(*) FROM public.location_bays WHERE location_id = :loc_a AND active) = 2, :'r');
SELECT harness.try(format($q$SELECT jsonb_array_length(admin_set_bays(%L, 5))$q$, :loc_a)) AS r \gset
SELECT harness.ok('growing to 5 reactivates 3,4 and creates 5',
  :'r' = 'OK: 5' AND (SELECT string_agg(label, ',' ORDER BY sort) FROM public.location_bays WHERE location_id = :loc_a AND active) = '1,2,3,4,5', :'r');
SELECT harness.try(format($q$SELECT admin_set_bays(%L, 61)::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('bay count capped', :'r' LIKE 'ERR 22023%', :'r');
SELECT harness.try($q$SELECT admin_rename_bay((SELECT id FROM location_bays WHERE label = '5'), 'VIP')->>'label'$q$) AS r \gset
SELECT harness.ok('admin renames a bay', :'r' = 'OK: VIP', :'r');
SELECT harness.try($q$SELECT admin_rename_bay((SELECT id FROM location_bays WHERE label = 'VIP'), ' 1 ')::text$q$) AS r \gset
SELECT harness.ok('rename to a taken label rejected', :'r' LIKE 'ERR 22023%already%', :'r');
SELECT harness.try(format($q$SELECT jsonb_array_length(admin_set_bays(%L, 4))$q$, :loc_a)) AS r \gset
SELECT harness.ok('back to 4 bays (VIP off)',
  :'r' = 'OK: 4' AND NOT (SELECT active FROM public.location_bays WHERE label = 'VIP'), :'r');
RESET ROLE;
SELECT harness.ok('bay changes audited',
  (SELECT count(*) FROM public.audit_events WHERE action IN ('bay.set_count', 'bay.rename')) >= 5);
SELECT id AS b1 FROM public.location_bays WHERE location_id = :loc_a AND label = '1' \gset
SELECT id AS b2 FROM public.location_bays WHERE location_id = :loc_a AND label = '2' \gset
SELECT id AS b3 FROM public.location_bays WHERE location_id = :loc_a AND label = '3' \gset
SELECT id AS b4 FROM public.location_bays WHERE location_id = :loc_a AND label = '4' \gset
SELECT id AS bvip FROM public.location_bays WHERE location_id = :loc_a AND label = 'VIP' \gset
\set b1 '''':b1''''
\set b2 '''':b2''''
\set b3 '''':b3''''
\set b4 '''':b4''''
\set bvip '''':bvip''''

-- ── 3. checkin_team: one tap loads the whole team ───────────────────────────
SELECT harness.login(:u1, 'p1@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT r->'bay'->>'label' || '|' || jsonb_array_length(r->'teams') || '|' || jsonb_array_length(r->'teams'->0->'players') || '|' || (r->'checked_in'->0->>'team_name') FROM (SELECT checkin_team(%L) r) x$q$, :b1)) AS r \gset
SELECT harness.ok('player checks in whole team (bay, 1 team, 2 players)', :'r' = 'OK: 1|1|2|Team 1', :'r');
RESET ROLE;
SELECT harness.ok('check-in row records who and where',
  (SELECT count(*) FROM public.bay_checkins WHERE team_id = :t1 AND bay_id = :b1 AND cleared_at IS NULL
      AND checked_in_by = :u1 AND event_id = :e1 AND location_id = :loc_a) = 1);
SELECT harness.login(:u2, 'p2@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT jsonb_array_length(checkin_team(%L)->'teams')$q$, :b1)) AS r \gset
RESET ROLE;
SELECT harness.ok('teammate re-check-in on same bay is a no-op',
  :'r' = 'OK: 1' AND (SELECT count(*) FROM public.bay_checkins WHERE team_id = :t1) = 1, :'r');
SELECT harness.login(:u2, 'p2@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT checkin_team(%L)::text$q$, :bvip)) AS r \gset
SELECT harness.ok('inactive bay rejected', :'r' LIKE 'ERR 22023%not in use%', :'r');
SELECT harness.try(format($q$INSERT INTO public.bay_checkins (location_id, event_id, team_id, bay_id) VALUES (%L, %L, %L, %L) RETURNING 'x'$q$, :loc_a, :e1, :t1, :b3)) AS r \gset
SELECT harness.ok('direct insert blocked', :'r' LIKE 'ERR%', :'r');
SELECT harness.try($q$UPDATE public.bay_checkins SET cleared_at = now(), clear_reason = 'manual' RETURNING 'x'$q$) AS r \gset
SELECT harness.ok('direct update blocked', :'r' LIKE 'ERR%', :'r');
SELECT harness.try(format($q$INSERT INTO public.location_bays (location_id, label) VALUES (%L, 'X') RETURNING 'x'$q$, :loc_a)) AS r \gset
SELECT harness.ok('direct bay insert blocked', :'r' LIKE 'ERR%', :'r');
SELECT harness.ok('location member reads check-ins and bays',
  (SELECT count(*) FROM public.bay_checkins) = 1 AND (SELECT count(*) FROM public.location_bays) = 5);

-- second team joins the same bay
SELECT harness.login(:u3, 'p3@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT jsonb_array_length(checkin_team(%L)->'teams')$q$, :b1)) AS r \gset
SELECT harness.ok('second team joins the same bay', :'r' = 'OK: 2', :'r');

-- moving bays
SELECT harness.login(:u1, 'p1@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT checkin_team(%L)->>'moved'$q$, :b2)) AS r \gset
RESET ROLE;
SELECT harness.ok('team moves bays (old stint cleared as moved)',
  :'r' = 'OK: 1'
  AND (SELECT bay_id FROM public.bay_checkins WHERE team_id = :t1 AND cleared_at IS NULL) = :b2
  AND (SELECT clear_reason FROM public.bay_checkins WHERE team_id = :t1 AND bay_id = :b1) = 'moved'
  AND (SELECT count(*) FROM public.bay_checkins WHERE bay_id = :b1 AND cleared_at IS NULL) = 1, :'r');
SELECT harness.login(:u1, 'p1@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT checkin_team(%L)->>'moved'$q$, :b1)) AS r \gset
SELECT harness.ok('and back again', :'r' = 'OK: 1', :'r');

-- ── 4. finished-team safety net ─────────────────────────────────────────────
-- Team 1 is mid-round (live holes); Team 2 has both rounds in.
SELECT harness.try(format($q$SELECT record_live_hole(%L, %L, 1, 4)->>'holes_played'$q$, :e1, :p1)) AS r \gset
RESET ROLE;
INSERT INTO public.scores (event_id, player_id, team_id, hole_scores, gross_total, net_total, handicap_used, entry_type, status, location_id)
VALUES (:e1, :p3, :t2, '{4,4,4,4,4,4,4,4,4}', 36, 28, 8, 'played', 'verified', :loc_a),
       (:e1, :p4, :t2, '{5,5,5,5,5,5,5,5,5}', 45, 25, 20, 'played', 'pending', :loc_a);
SELECT harness.ok('finished helper: team 2 finished, team 1 not',
  public.bay_team_finished(:e1, :t2) AND NOT public.bay_team_finished(:e1, :t1));
SELECT harness.login(:u7, 'p7@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT (r->>'cleared_finished') || '|' || (SELECT string_agg(t->>'team_name', ',' ORDER BY t->>'team_name') FROM jsonb_array_elements(r->'teams') t) FROM (SELECT checkin_team(%L) r) x$q$, :b1)) AS r \gset
SELECT harness.ok('new check-in clears finished team, keeps the playing one', :'r' = 'OK: 1|Team 1,Team 4', :'r');
RESET ROLE;
SELECT harness.ok('finished team cleared with reason finished',
  (SELECT clear_reason FROM public.bay_checkins WHERE team_id = :t2 AND bay_id = :b1) = 'finished'
  AND (SELECT cleared_at IS NULL FROM public.bay_checkins WHERE team_id = :t1 AND bay_id = :b1 AND clear_reason IS NULL));
-- a rejected score reopens the round: not finished any more
UPDATE public.scores SET status = 'rejected' WHERE event_id = :e1 AND player_id = :p4;
SELECT harness.ok('rejected score = not finished', NOT public.bay_team_finished(:e1, :t2));
UPDATE public.scores SET status = 'pending' WHERE event_id = :e1 AND player_id = :p4;

-- ── 5. suggestions (frequent partners) + extra team add ─────────────────────
RESET ROLE;
-- History: Team 1 shared bay 3 with Team 3 on weeks 2 and 3 (overlapping),
-- with Team 2 once (week 2), and with Team 4 on week 3 only after Team 1 left.
INSERT INTO public.bay_checkins (location_id, event_id, team_id, bay_id, checked_in_at, cleared_at, clear_reason) VALUES
  (:loc_a, :e2, :t1, :b3, now() - interval '20 days 3 hours', now() - interval '20 days 1 hour', 'clear_all'),
  (:loc_a, :e2, :t3, :b3, now() - interval '20 days 3 hours', now() - interval '20 days 1 hour', 'clear_all'),
  (:loc_a, :e2, :t2, :b3, now() - interval '20 days 2 hours', now() - interval '20 days 1 hour', 'clear_all'),
  (:loc_a, :e3, :t1, :b3, now() - interval '13 days 3 hours', now() - interval '13 days 2 hours', 'finished'),
  (:loc_a, :e3, :t3, :b3, now() - interval '13 days 3 hours', now() - interval '13 days 1 hour', 'clear_all'),
  (:loc_a, :e3, :t4, :b3, now() - interval '13 days 2 hours' + interval '1 minute', now() - interval '13 days', 'clear_all'),
  (:loc_a, :e4, :t4, :b3, now() - interval '120 days', now() - interval '120 days' + interval '2 hours', 'clear_all'),
  (:loc_a, :e4, :t1, :b3, now() - interval '120 days', now() - interval '120 days' + interval '2 hours', 'clear_all');
SELECT harness.login(:u2, 'p2@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT string_agg((s->>'team_name') || ':' || (s->>'nights') || ':' || jsonb_array_length(s->'players'), ',') FROM jsonb_array_elements(checkin_team(%L)->'suggestions') s$q$, :b2)) AS r \gset
SELECT harness.ok('suggests only teams shared on >=2 nights (Team 3)', :'r' = 'OK: Team 3:2:2', :'r');
SELECT harness.try(format($q$SELECT (r->>'moved') || '|' || jsonb_array_length(r->'teams') || '|' || jsonb_array_length(r->'suggestions') FROM (SELECT checkin_team(%L, ARRAY[%L]::uuid[]) r) x$q$, :b2, :t3)) AS r \gset
SELECT harness.ok('one-tap extra team joins the bay; no more suggestions', :'r' = 'OK: 0|2|0', :'r');
RESET ROLE;
SELECT harness.ok('extra team row recorded, checked in by the caller',
  (SELECT checked_in_by FROM public.bay_checkins WHERE team_id = :t3 AND event_id = :e1 AND cleared_at IS NULL) = :u2);
SELECT harness.login(:u2, 'p2@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT checkin_team(%L, ARRAY[%L]::uuid[])::text$q$, :b2, :tb1)) AS r \gset
SELECT harness.ok('extra team from another location rejected', :'r' LIKE 'ERR 22023%', :'r');
SELECT harness.try(format($q$SELECT my_checkin_status(%L)->'bay'->>'label'$q$, :loc_a)) AS r \gset
SELECT harness.ok('my_checkin_status shows the bay', :'r' = 'OK: 2', :'r');

-- ── 6. checkout ─────────────────────────────────────────────────────────────
SELECT harness.try($q$SELECT checkout_my_team()$q$) AS r \gset
RESET ROLE;
SELECT harness.ok('checkout clears only my team',
  :'r' = 'OK: 1'
  AND (SELECT clear_reason FROM public.bay_checkins WHERE team_id = :t1 AND event_id = :e1 ORDER BY checked_in_at DESC LIMIT 1) = 'checkout'
  AND EXISTS (SELECT 1 FROM public.bay_checkins WHERE team_id = :t3 AND event_id = :e1 AND cleared_at IS NULL), :'r');
SELECT harness.login(:u1, 'p1@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT (my_checkin_status(%L)->>'status') || '|' || COALESCE(my_checkin_status(%L)->>'bay', 'none') || '|' || (my_checkin_status(%L)->'team'->>'name')$q$, :loc_a, :loc_a, :loc_a)) AS r \gset
SELECT harness.ok('status after checkout: ok, no bay', :'r' = 'OK: ok|none|Team 1', :'r');

-- ── 7. bay_board ────────────────────────────────────────────────────────────
SELECT harness.login(:u5, 'p5@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT record_live_hole(%L, %L, 1, 4)->>'holes_played'$q$, :e1, :p5)) AS r \gset
SELECT harness.try(format($q$SELECT jsonb_array_length(b->'bays') || '|' || jsonb_array_length(b->'teams') || '|'
  || (SELECT string_agg(bb->>'label' || '=' || jsonb_array_length(bb->'teams'), ',') FROM jsonb_array_elements(b->'bays') bb)
  FROM (SELECT bay_board(%L) b) x$q$, :loc_a)) AS r \gset
SELECT harness.ok('board: 4 active bays, 4 teams, occupants per bay', :'r' = 'OK: 4|4|1=1,2=1,3=0,4=0', :'r');
SELECT harness.try(format($q$SELECT p->>'holes_played' FROM jsonb_array_elements(bay_board(%L)->'bays') bb, jsonb_array_elements(bb->'teams') t, jsonb_array_elements(t->'players') p WHERE p->>'player_id' = %L$q$, :loc_a, :p5)) AS r \gset
SELECT harness.ok('board shows players'' holes played', :'r' = 'OK: 1', :'r');
SELECT harness.try(format($q$SELECT (SELECT t->>'bay_id' FROM jsonb_array_elements(bay_board(%L)->'teams') t WHERE t->>'team_name' = 'Team 3')$q$, :loc_a)) AS r \gset
SELECT harness.ok('board team list says where each team is', :'r' = 'OK: ' || :b2, :'r');

-- other location isolation
SELECT harness.login(:ub1, 'b1@b.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT bay_board(%L)::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('other location player cannot read the board', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.ok('other location sees no check-ins or bays',
  (SELECT count(*) FROM public.bay_checkins) = 0 AND (SELECT count(*) FROM public.location_bays) = 0);
SELECT harness.try(format($q$SELECT checkin_team(%L)::text$q$, :b3)) AS r \gset
SELECT harness.ok('other location player cannot check in here', :'r' LIKE 'ERR 22023%Bay not found%', :'r');
SELECT harness.try(format($q$SELECT my_checkin_status(%L)->>'status'$q$, :loc_a)) AS r \gset
SELECT harness.ok('other location status is not_rostered', :'r' = 'OK: not_rostered', :'r');
SELECT harness.login(:admin_a, 'admin@a.test');
SELECT harness.try(format($q$SELECT checkin_team(%L)::text$q$, :b3)) AS r \gset
SELECT harness.ok('non-player gets a clear not-rostered message', :'r' LIKE 'ERR 22023%not on a team%', :'r');

-- ── 8. admin actions ────────────────────────────────────────────────────────
SELECT harness.login(:u5, 'p5@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_clear_all_bays(%L)$q$, :loc_a)) AS r \gset
SELECT harness.ok('player cannot clear all', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try(format($q$SELECT admin_clear_bay(%L)$q$, :b1)) AS r \gset
SELECT harness.ok('player cannot clear a bay', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try(format($q$SELECT admin_checkin_team(%L, %L)::text$q$, :b3, :t2)) AS r \gset
SELECT harness.ok('player cannot use admin check-in', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.login(:admin_b, 'admin@b.test');
SELECT harness.try(format($q$SELECT admin_clear_all_bays(%L)$q$, :loc_a)) AS r \gset
SELECT harness.ok('other location admin cannot clear all', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try(format($q$SELECT admin_clear_bay(%L)$q$, :b1)) AS r \gset
SELECT harness.ok('other location admin cannot clear a bay', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.login(:admin_a, 'admin@a.test');
SELECT harness.try(format($q$SELECT jsonb_array_length(admin_checkin_team(%L, %L)->'teams')$q$, :b3, :t2)) AS r \gset
SELECT harness.ok('admin checks in a walk-in team', :'r' = 'OK: 1', :'r');
SELECT harness.try(format($q$SELECT admin_checkin_team(%L, %L)::text$q$, :b3, :tb1)) AS r \gset
SELECT harness.ok('admin cannot check in another location''s team', :'r' LIKE 'ERR 22023%', :'r');
SELECT harness.try(format($q$SELECT admin_clear_bay(%L)$q$, :b1)) AS r \gset
RESET ROLE;
SELECT harness.ok('admin clears one bay',
  :'r' = 'OK: 1' AND (SELECT clear_reason FROM public.bay_checkins WHERE team_id = :t4 AND event_id = :e1) = 'manual', :'r');
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_clear_checkin((SELECT id FROM bay_checkins WHERE team_id = %L AND event_id = %L AND cleared_at IS NULL))::text$q$, :t3, :e1)) AS r \gset
SELECT harness.ok('admin clears one team', :'r' = 'OK: true', :'r');
SELECT harness.login(:u1, 'p1@a.test');
SELECT harness.try(format($q$SELECT checkin_team(%L)->>'moved'$q$, :b4)) AS r \gset
SELECT harness.login(:admin_a, 'admin@a.test');
SELECT harness.try(format($q$SELECT admin_clear_all_bays(%L)$q$, :loc_a)) AS r \gset
RESET ROLE;
SELECT harness.ok('clear all empties every bay',
  :'r' = 'OK: 2' AND NOT EXISTS (SELECT 1 FROM public.bay_checkins WHERE location_id = :loc_a AND cleared_at IS NULL)
  AND (SELECT count(*) FROM public.bay_checkins WHERE clear_reason = 'clear_all' AND event_id = :e1) = 2, :'r');
SELECT harness.ok('admin bay actions audited',
  (SELECT count(*) FROM public.audit_events WHERE action IN ('bay.admin_checkin', 'bay.clear', 'bay.clear_team', 'bay.clear_all')) = 4);

-- deactivating a bay empties it
SELECT harness.login(:u7, 'p7@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT checkin_team(%L)->>'moved'$q$, :b4)) AS r \gset
SELECT harness.login(:admin_a, 'admin@a.test');
SELECT harness.try(format($q$SELECT jsonb_array_length(admin_set_bays(%L, 3))$q$, :loc_a)) AS r \gset
RESET ROLE;
SELECT harness.ok('switching a bay off clears its teams',
  :'r' = 'OK: 3' AND NOT EXISTS (SELECT 1 FROM public.bay_checkins WHERE bay_id = :b4 AND cleared_at IS NULL), :'r');
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT jsonb_array_length(admin_set_bays(%L, 4))$q$, :loc_a)) AS r \gset

-- ── 9. stale check-ins expire ───────────────────────────────────────────────
RESET ROLE;
INSERT INTO public.bay_checkins (location_id, event_id, team_id, bay_id, checked_in_at)
VALUES (:loc_a, :e1, :t4, :b4, now() - interval '13 hours');
SELECT harness.login(:u7, 'p7@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT COALESCE(my_checkin_status(%L)->>'bay', 'none')$q$, :loc_a)) AS r \gset
SELECT harness.ok('a 13-hour-old check-in is not shown', :'r' = 'OK: none', :'r');
SELECT harness.try(format($q$SELECT (SELECT jsonb_array_length(bb->'teams') FROM jsonb_array_elements(bay_board(%L)->'bays') bb WHERE bb->>'label' = '4')$q$, :loc_a)) AS r \gset
SELECT harness.ok('board hides stale check-ins', :'r' = 'OK: 0', :'r');
SELECT harness.try(format($q$SELECT checkin_team(%L)->>'moved'$q$, :b4)) AS r \gset
RESET ROLE;
SELECT harness.ok('next check-in expires the stale row',
  :'r' = 'OK: 0'
  AND (SELECT count(*) FROM public.bay_checkins WHERE team_id = :t4 AND event_id = :e1 AND clear_reason = 'expired') = 1
  AND (SELECT count(*) FROM public.bay_checkins WHERE team_id = :t4 AND event_id = :e1 AND cleared_at IS NULL) = 1, :'r');

-- ── 10. no open week ────────────────────────────────────────────────────────
UPDATE public.events SET status = 'draft' WHERE id = :e1;
SELECT harness.login(:u1, 'p1@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT checkin_team(%L)::text$q$, :b1)) AS r \gset
SELECT harness.ok('no open week: clear error', :'r' LIKE 'ERR 22023%no open league week%', :'r');
SELECT harness.try(format($q$SELECT my_checkin_status(%L)->>'status'$q$, :loc_a)) AS r \gset
SELECT harness.ok('no open week: status', :'r' = 'OK: no_open_week', :'r');
SELECT harness.try(format($q$SELECT jsonb_array_length(bay_board(%L)->'teams') || '|' || (SELECT jsonb_array_length(bb->'teams') FROM jsonb_array_elements(bay_board(%L)->'bays') bb WHERE bb->>'label' = '4')$q$, :loc_a, :loc_a)) AS r \gset
SELECT harness.ok('closed week drops off the board', :'r' = 'OK: 0|0', :'r');
RESET ROLE;
UPDATE public.events SET status = 'open' WHERE id = :e1;

-- ── 11. sim_bay ─────────────────────────────────────────────────────────────
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT admin_create_location_api_key(:loc_a, 'sim', 'Bay PCs')->>'key' AS key1 \gset
SELECT encode(sha256(convert_to(:'key1', 'UTF8')), 'hex') AS hash1 \gset
SELECT harness.try(format($q$SELECT sim_bay(%L, '{"action":"bay","bay":"4"}')::text$q$, :'hash1')) AS r \gset
SELECT harness.ok('sim_bay not callable by authenticated', :'r' LIKE 'ERR 42501%', :'r');
-- location B has a bay "1" too; the key only ever sees its own location
SELECT harness.login(:admin_b, 'admin@b.test');
SELECT harness.try(format($q$SELECT jsonb_array_length(admin_set_bays(%L, 1))$q$, :loc_b)) AS r \gset
RESET ROLE;
SELECT harness.logout();
SET ROLE service_role;
SELECT harness.try($q$SELECT sim_bay(repeat('0', 64), '{"action":"bay","bay":"4"}')::text$q$) AS r \gset
SELECT harness.ok('sim bad key -> 28000', :'r' LIKE 'ERR 28000%', :'r');
SELECT harness.try(format($q$SELECT (SELECT string_agg((p->>'name') || ':' || (p->>'handicap') || ':' || (p->>'holes_played'), ',' ORDER BY p->>'name')
  FROM jsonb_array_elements(r->'occupants'->0->'players') p) || '|' || (r->'occupants'->0->>'team_name') || '|' || (r->>'bay')
  FROM (SELECT sim_bay(%L, '{"action":"bay","bay":"4"}') r) x$q$, :'hash1')) AS r \gset
SELECT harness.ok('sim reads bay occupants with player ids, handicaps, progress', :'r' = 'OK: Al Seven:10:0,Bo Eight:18:0|Team 4|4', :'r');
SELECT harness.try(format($q$SELECT jsonb_array_length(sim_bay(%L, '{"action":"bay","bay":"1"}')->'occupants')$q$, :'hash1')) AS r \gset
SELECT harness.ok('sim sees only its own location''s bay 1', :'r' = 'OK: 0', :'r');
SELECT harness.try(format($q$SELECT sim_bay(%L, '{"action":"bay","bay":"99"}')::text$q$, :'hash1')) AS r \gset
SELECT harness.ok('sim unknown bay -> 22023', :'r' LIKE 'ERR 22023%', :'r');
SELECT harness.try(format($q$SELECT sim_bay(%L, '{"action":"dance","bay":"4"}')::text$q$, :'hash1')) AS r \gset
SELECT harness.ok('sim unknown action -> 22023', :'r' LIKE 'ERR 22023%', :'r');
-- finishing the round via the sim does NOT clear the bay (extra holes)
SELECT harness.try(format($q$SELECT (sim_ingest(%L, jsonb_build_object('player_id', %L, 'bay', '4',
  'holes', '[{"hole":1,"strokes":4},{"hole":2,"strokes":3},{"hole":3,"strokes":4},{"hole":4,"strokes":5},{"hole":5,"strokes":4},{"hole":6,"strokes":3},{"hole":7,"strokes":4},{"hole":8,"strokes":4},{"hole":9,"strokes":5}]'::jsonb)))->'live'->>'holes_played'$q$, :'hash1', :p7)) AS r \gset
SELECT harness.try(format($q$SELECT (sim_ingest(%L, jsonb_build_object('player_id', %L, 'bay', '4',
  'holes', '[{"hole":1,"strokes":5},{"hole":2,"strokes":4},{"hole":3,"strokes":5},{"hole":4,"strokes":6},{"hole":5,"strokes":5},{"hole":6,"strokes":4},{"hole":7,"strokes":5},{"hole":8,"strokes":5},{"hole":9,"strokes":6}]'::jsonb,
  'finalize', true))->'finalize'->>'inserted')$q$, :'hash1', :p8)) AS r \gset
SELECT harness.ok('sim finalizes team 4', :'r' = 'OK: 2', :'r');
SELECT harness.try(format($q$SELECT (SELECT string_agg((p->>'holes_played') || ':' || (p->>'submitted'), ',') FROM jsonb_array_elements(sim_bay(%L, '{"action":"bay","bay":"4"}')->'occupants'->0->'players') p)$q$, :'hash1')) AS r \gset
SELECT harness.ok('finalized team stays on the bay (submitted shown)', :'r' = 'OK: 9:true,9:true', :'r');
SELECT harness.try(format($q$SELECT sim_bay(%L, '{"action":"clear_bay","bay":"4"}')->>'cleared'$q$, :'hash1')) AS r \gset
RESET ROLE;
SELECT harness.ok('sim clears its bay (reason sim)',
  :'r' = 'OK: 1' AND (SELECT count(*) FROM public.bay_checkins WHERE bay_id = :b4 AND clear_reason = 'sim') = 1
  AND NOT EXISTS (SELECT 1 FROM public.bay_checkins WHERE bay_id = :b4 AND cleared_at IS NULL), :'r');
SELECT harness.ok('sim clear audited',
  EXISTS (SELECT 1 FROM public.audit_events WHERE action = 'bay.clear' AND after_data->>'source' = 'sim'));

-- ── 12. internals are not client-callable ───────────────────────────────────
SELECT harness.login(:u1, 'p1@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT bay_checkin_internal(%L, %L, ARRAY[%L]::uuid[])::text$q$, :b1, :e1, :t2)) AS r \gset
SELECT harness.ok('bay_checkin_internal not callable by clients', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try(format($q$SELECT bay_team_finished(%L, %L)::text$q$, :e1, :t2)) AS r \gset
SELECT harness.ok('bay_team_finished not callable by clients', :'r' LIKE 'ERR 42501%', :'r');
RESET ROLE;

SELECT 'RESULTS', count(*) FILTER (WHERE pass) AS passed, count(*) FILTER (WHERE NOT pass) AS failed FROM harness.results;
SELECT 'FAIL: ' || label || ' :: ' || COALESCE(info, '') FROM harness.results WHERE NOT pass ORDER BY n;

-- Seed realistic data, as much as possible THROUGH the app's own paths
-- (admin direct-table writes where the client does that, RPCs otherwise).
\set ON_ERROR_STOP 0
\pset pager off
\pset footer off

\set admin_a '''00000000-0000-0000-0000-00000000a0a0'''
\set admin_b '''00000000-0000-0000-0000-00000000b0b0'''
\set super   '''acd6c8a3-35e1-4892-a928-0a8996c02d10'''
\set u1 '''00000000-0000-0000-0000-000000000001'''
\set u2 '''00000000-0000-0000-0000-000000000002'''
\set u3 '''00000000-0000-0000-0000-000000000003'''
\set u4 '''00000000-0000-0000-0000-000000000004'''
\set u5 '''00000000-0000-0000-0000-000000000005'''
\set u6 '''00000000-0000-0000-0000-000000000006'''
\set u7 '''00000000-0000-0000-0000-000000000007'''
\set u8 '''00000000-0000-0000-0000-000000000008'''
\set ub1 '''00000000-0000-0000-0000-000000000b01'''
\set ub2 '''00000000-0000-0000-0000-000000000b02'''
\set loc_b '''bbbbbbbb-0000-0000-0000-000000000000'''

-- ── platform-side setup (service role / dashboard) ──────────────────────────
RESET ROLE;
SELECT id AS loc_a FROM public.locations WHERE slug = 'gbig' \gset
\set loc_a '''':loc_a''''
INSERT INTO public.locations (id, name, slug, app_name) VALUES (:loc_b, 'Appleton Indoor', 'appleton', 'Appleton App');
INSERT INTO auth.users (id, email) VALUES
  (:admin_a, 'admin@a.test'), (:admin_b, 'admin@b.test'),
  (:u1, 'p1@a.test'), (:u2, 'p2@a.test'), (:u3, 'p3@a.test'), (:u4, 'p4@a.test'),
  (:u5, 'p5@a.test'), (:u6, 'p6@a.test'), (:u7, 'p7@a.test'), (:u8, 'p8@a.test'),
  (:ub1, 'b1@b.test'), (:ub2, 'b2@b.test');
INSERT INTO public.location_admins (user_id, location_id) VALUES (:admin_a, :loc_a), (:admin_b, :loc_b);

-- ── admin A: league + course via direct (RLS-allowlisted) table writes ──────
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
INSERT INTO public.league_config (name, num_weeks, start_date, is_active, is_working, location_id)
VALUES ('Fall 2026', 12, '2026-09-01', true, true, :loc_a) RETURNING id AS league_a \gset
INSERT INTO public.courses (name, num_holes, start_hole, hole_pars, total_par, stroke_index, location_id)
VALUES ('Pebble Front', 9, 1, '[4,3,4,5,4,3,4,4,5]', 36, '[3,9,1,5,7,8,2,6,4]', :loc_a) RETURNING id AS course_a \gset
\set league_a '''':league_a''''
\set course_a '''':course_a''''

-- players through admin_create_player (client path)
SELECT admin_create_player(:loc_a, '{"first_name":"Pat","last_name":"One","name":"Pat One","email":"p1@a.test","handicap":5}') AS p1 \gset
SELECT admin_create_player(:loc_a, '{"first_name":"Sam","last_name":"Two","name":"Sam Two","email":"p2@a.test","handicap":12}') AS p2 \gset
SELECT admin_create_player(:loc_a, '{"first_name":"Lee","last_name":"Three","name":"Lee Three","email":"p3@a.test","handicap":8}') AS p3 \gset
SELECT admin_create_player(:loc_a, '{"first_name":"Kim","last_name":"Four","name":"Kim Four","email":"p4@a.test","handicap":20}') AS p4 \gset
SELECT admin_create_player(:loc_a, '{"first_name":"Ray","last_name":"Five","name":"Ray Five","email":"p5@a.test","handicap":3}') AS p5 \gset
SELECT admin_create_player(:loc_a, '{"first_name":"Jo","last_name":"Six","name":"Jo Six","email":"p6@a.test","handicap":15}') AS p6 \gset
SELECT admin_create_player(:loc_a, '{"first_name":"Al","last_name":"Seven","name":"Al Seven","email":"p7@a.test","handicap":10}') AS p7 \gset
SELECT admin_create_player(:loc_a, '{"first_name":"Bo","last_name":"Eight","name":"Bo Eight","email":"p8@a.test","handicap":18}') AS p8 \gset
SELECT admin_create_player(:loc_a, '{"first_name":"Cy","last_name":"Nine","name":"Cy Nine","handicap":7}') AS p9 \gset

\set p1 '''':p1''''
\set p2 '''':p2''''
\set p3 '''':p3''''
\set p4 '''':p4''''
\set p5 '''':p5''''
\set p6 '''':p6''''
\set p7 '''':p7''''
\set p8 '''':p8''''
\set p9 '''':p9''''

SELECT admin_save_team(NULL, :league_a, 'Team 1', jsonb_build_array(:p1, :p2)) AS t1 \gset
SELECT admin_save_team(NULL, :league_a, 'Team 2', jsonb_build_array(:p3, :p4)) AS t2 \gset
SELECT admin_save_team(NULL, :league_a, 'Team 3', jsonb_build_array(:p5, :p6)) AS t3 \gset
SELECT admin_save_team(NULL, :league_a, 'Team 4', jsonb_build_array(:p7, :p8)) AS t4 \gset
\set t1 '''':t1''''
\set t2 '''':t2''''
\set t3 '''':t3''''
\set t4 '''':t4''''

SELECT admin_generate_schedule(:league_a, '[
  {"week_number":1,"start_date":"2026-09-01","end_date":"2026-09-07"},
  {"week_number":2,"start_date":"2026-09-08","end_date":"2026-09-14"},
  {"week_number":3,"start_date":"2026-09-15","end_date":"2026-09-21"},
  {"week_number":4,"start_date":"2026-09-22","end_date":"2026-09-28"}]') AS weeks_inserted;
RESET ROLE;
SELECT id AS e1 FROM public.events WHERE league_id = :league_a AND week_number = 1 \gset
SELECT id AS e2 FROM public.events WHERE league_id = :league_a AND week_number = 2 \gset
SELECT id AS e3 FROM public.events WHERE league_id = :league_a AND week_number = 3 \gset
SELECT id AS e4 FROM public.events WHERE league_id = :league_a AND week_number = 4 \gset
\set e1 '''':e1''''
\set e2 '''':e2''''
\set e3 '''':e3''''
\set e4 '''':e4''''

-- link auth users (create-player-account edge function uses service role)
UPDATE public.players SET user_id = :u2 WHERE id = :p2;
UPDATE public.players SET user_id = :u3 WHERE id = :p3;
UPDATE public.players SET user_id = :u4 WHERE id = :p4;
UPDATE public.players SET user_id = :u5 WHERE id = :p5;
UPDATE public.players SET user_id = :u6 WHERE id = :p6;
UPDATE public.players SET user_id = :u7 WHERE id = :p7;
UPDATE public.players SET user_id = :u8 WHERE id = :p8;
-- p1 too. The first-login "claim own profile" RLS policy was dropped in
-- 202609230001_review_fixes.sql; create-player-account links accounts as the
-- service role, so mirror that here (30_tests.sql asserts the claim is refused).
UPDATE public.players SET user_id = :u1 WHERE id = :p1;

-- ── location B: admin B sets up a minimal league ────────────────────────────
SELECT harness.login(:admin_b, 'admin@b.test');
SET ROLE authenticated;
INSERT INTO public.league_config (name, num_weeks, start_date, is_active, is_working, location_id)
VALUES ('Appleton Fall', 10, '2026-09-01', true, true, :loc_b) RETURNING id AS league_b \gset
INSERT INTO public.courses (name, num_holes, hole_pars, total_par, location_id)
VALUES ('Appleton 9', 9, '[4,4,4,4,4,4,4,4,4]', 36, :loc_b) RETURNING id AS course_b \gset
\set league_b '''':league_b''''
\set course_b '''':course_b''''
SELECT admin_create_player(:loc_b, '{"name":"Bea One","email":"b1@b.test","handicap":9}') AS pb1 \gset
SELECT admin_create_player(:loc_b, '{"name":"Bob Two","email":"b2@b.test","handicap":11}') AS pb2 \gset
\set pb1 '''':pb1''''
\set pb2 '''':pb2''''
SELECT admin_save_team(NULL, :league_b, 'B Team', jsonb_build_array(:pb1, :pb2)) AS tb1 \gset
\set tb1 '''':tb1''''
SELECT admin_generate_schedule(:league_b, '[{"week_number":1,"start_date":"2026-09-01","end_date":"2026-09-07"}]');
RESET ROLE;
SELECT id AS eb1 FROM public.events WHERE league_id = :league_b AND week_number = 1 \gset
\set eb1 '''':eb1''''
UPDATE public.players SET user_id = :ub1 WHERE id = :pb1;
UPDATE public.players SET user_id = :ub2 WHERE id = :pb2;

-- persist ids for the test script
DROP TABLE IF EXISTS harness.ids;
CREATE TABLE harness.ids AS SELECT * FROM (VALUES
  ('loc_a', :loc_a), ('loc_b', :loc_b), ('league_a', :league_a), ('league_b', :league_b),
  ('course_a', :course_a), ('course_b', :course_b),
  ('p1', :p1), ('p2', :p2), ('p3', :p3), ('p4', :p4), ('p5', :p5), ('p6', :p6), ('p7', :p7), ('p8', :p8), ('p9', :p9),
  ('pb1', :pb1), ('pb2', :pb2), ('t1', :t1), ('t2', :t2), ('t3', :t3), ('t4', :t4), ('tb1', :tb1),
  ('e1', :e1), ('e2', :e2), ('e3', :e3), ('e4', :e4), ('eb1', :eb1)) v(k, id);
GRANT SELECT ON harness.ids TO authenticated, anon;
SELECT * FROM harness.ids ORDER BY k;
SELECT count(*) AS memberships FROM public.team_memberships;

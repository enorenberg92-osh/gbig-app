-- Batch 3: scoring-semantics probes. Run after 31_tests.sql.
\set ON_ERROR_STOP 0
\pset pager off
\pset footer off
\pset tuples_only on
\ir 29_ids.psql

\echo '=== 20. match_team when one partner is missing (penalty row, no played row) ==='
-- Week 3 is open (stableford). Publish it, then use a fresh match_team week 5.
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT admin_upsert_event(NULL, :league_a, json_build_object('name','Week 5','week_number',5,'start_date','2026-09-29','status','draft',
  'course_id', :course_a, 'format','match_team','format_config', json_build_object('version',1))::jsonb) AS e5 \gset
\set e5 '''':e5''''
SELECT publish_week(:e3) \g /dev/null
RESET ROLE;
INSERT INTO harness.ids VALUES ('e5', :e5);
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.ok('week 5 is next open event', (SELECT status FROM events WHERE id = :e5) = 'open', (SELECT status FROM events WHERE id = :e5));
SELECT admin_set_matchups(:e5, json_build_array(json_build_object('home_team_id', :t1, 'away_team_id', :t3))::jsonb) \g /dev/null
-- T1: only p1 plays (bogey golf, 45 gross, hcp ~1); T3: both play level par-ish
SELECT admin_upsert_score(:e5, json_build_array(
  json_build_object('player_id', :p1, 'hole_scores', json_build_array(5,4,5,6,5,4,5,5,6), 'handicap_used', 1),
  json_build_object('player_id', :p5, 'hole_scores', json_build_array(4,3,4,5,4,3,4,4,5), 'handicap_used', 0),
  json_build_object('player_id', :p6, 'hole_scores', json_build_array(4,3,4,5,4,3,4,4,5), 'handicap_used', 0))::jsonb) \g /dev/null
SELECT harness.try(format($q$SELECT publish_week(%L)::text$q$, :e5)) AS r \gset
SELECT harness.ok('publish week 5', :'r' LIKE 'OK%', :'r');
SELECT harness.ok('short-handed T1 (1 bogey golfer vs 2 par golfers) should NOT win the match',
  (SELECT points_home < points_away FROM matchups WHERE event_id = :e5),
  (SELECT result::text || ' pts ' || points_home || '-' || points_away FROM matchups WHERE event_id = :e5));
RESET ROLE;

\echo '=== 21. recalculate_handicaps for an admin of two locations ==='
RESET ROLE;
INSERT INTO location_admins (user_id, location_id, created_at) VALUES (:admin_a, :loc_b, now());
-- give B players a verified score so a recalc would change them
UPDATE events SET course_id = :course_b WHERE id = :eb1;
SELECT harness.login(:admin_b) \g /dev/null
SET ROLE authenticated;
SELECT admin_upsert_score(:eb1, json_build_array(
  json_build_object('player_id', :pb1, 'hole_scores', json_build_array(6,6,6,6,6,6,6,6,6), 'handicap_used', 9))::jsonb) \g /dev/null
RESET ROLE;
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
-- client call shape: HEAD sends no args; working tree sends {p_location_id}
SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'recalculate_handicaps' AND pronargs = 1)
  THEN harness.try(format($q$SELECT recalculate_handicaps(p_location_id => %L)::text$q$, :loc_b))
  ELSE harness.try($q$SELECT recalculate_handicaps()::text$q$) END AS r \gset
RESET ROLE;
SELECT harness.ok('multi-location admin: recalculate_handicaps recalculates the location being administered (B)',
  (SELECT handicap FROM players WHERE id = :pb1) <> 9,
  'pb1 handicap now ' || (SELECT handicap FROM players WHERE id = :pb1) || ' (expected recalculated 16); rpc: ' || :'r');
DELETE FROM location_admins WHERE user_id = :admin_a AND location_id = :loc_b;

\echo '=== 22. best_ball team night via rescore ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT admin_upsert_event(NULL, :league_a, json_build_object('name','Week 6','week_number',6,'start_date','2026-10-06','status','draft',
  'course_id', :course_a, 'format','best_ball','format_config', json_build_object('version',1,'balls_counted',1))::jsonb) AS e6 \gset
\set e6 '''':e6''''
SELECT admin_upsert_score(:e6, json_build_array(
  json_build_object('player_id', :p1, 'hole_scores', json_build_array(5,4,5,6,5,4,5,5,6), 'handicap_used', 1),
  json_build_object('player_id', :p2, 'hole_scores', json_build_array(4,3,4,5,4,3,4,4,5), 'handicap_used', 11))::jsonb) \g /dev/null
SELECT harness.try(format($q$SELECT admin_rescore_event(%L)::text$q$, :e6)) AS r \gset
SELECT harness.ok('best_ball rescore', :'r' LIKE 'OK%"teams_scored": 1%', :'r');
SELECT harness.ok('best_ball format_points set on both team rows', (SELECT count(*) FROM scores WHERE event_id = :e6 AND format_points IS NOT NULL) = 2,
  (SELECT string_agg(DISTINCT format_points::text, ',') FROM scores WHERE event_id = :e6));
RESET ROLE;

\echo '=== RESULTS (cumulative) ==='
SELECT count(*) FILTER (WHERE pass) || ' passed, ' || count(*) FILTER (WHERE NOT pass) || ' failed' FROM harness.results;
SELECT 'FAIL: ' || label || ' :: ' || COALESCE(info,'') FROM harness.results WHERE NOT pass ORDER BY n;

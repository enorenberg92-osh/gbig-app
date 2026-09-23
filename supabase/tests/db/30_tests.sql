-- Runtime RPC + RLS tests. Run after 20_seed.sql. Results -> harness.results.
\set ON_ERROR_STOP 0
\pset pager off
\pset footer off
\pset tuples_only on
TRUNCATE harness.results;

\ir 29_ids.psql

\echo '=== 0. First-login claim is refused (policy dropped in 202609230001; create-player-account links as service role) ==='
RESET ROLE;
UPDATE public.players SET user_id = NULL WHERE id = :p1;
SELECT harness.login(:u1, 'p1@a.test') \g /dev/null
SET ROLE authenticated;
SELECT harness.try($q$ WITH u AS (UPDATE public.players SET user_id = auth.uid() WHERE email = 'p1@a.test' AND user_id IS NULL RETURNING 1) SELECT count(*)::text FROM u $q$) AS r \gset
SELECT harness.ok('claim own profile via RLS is refused (0 rows claimed)', :'r' = 'OK: 0', :'r');
RESET ROLE;
UPDATE public.players SET user_id = :u1 WHERE id = :p1;   -- service-role fallback so later tests run

\echo '=== 1. admin_upsert_event (AdminSchedule.jsx) — open week 1 with a course ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, %L::jsonb)::text$q$, :e1, :league_a,
  json_build_object('name','Week 1','start_date','2026-09-01','end_date','2026-09-07','status','open','course_id',:course_a,'week_number',1,'is_playoff',false)::text)) AS r \gset
SELECT harness.ok('admin_upsert_event open week 1', :'r' LIKE 'OK%', :'r');
RESET ROLE;
-- Harness workaround so the rest of the suite can run (NOT in repo):
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS is_playoff BOOLEAN NOT NULL DEFAULT false;
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, %L::jsonb)::text$q$, :e1, :league_a,
  json_build_object('name','Week 1','start_date','2026-09-01','end_date','2026-09-07','status','open','course_id',:course_a,'week_number',1,'is_playoff',false)::text)) AS r \gset
SELECT harness.ok('admin_upsert_event open week 1 (after adding events.is_playoff)', :'r' LIKE 'OK%', :'r');
-- weeks 2-4: attach course, keep draft; week 2 = match_team, week 3 = stableford
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, %L::jsonb)::text$q$, :e2, :league_a,
  json_build_object('name','Week 2','start_date','2026-09-08','status','draft','course_id',:course_a,'format','match_team','format_config',json_build_object('version',1))::text)) AS r \gset
SELECT harness.ok('admin_upsert_event week 2 match_team', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, %L::jsonb)::text$q$, :e3, :league_a,
  json_build_object('name','Week 3','start_date','2026-09-15','status','draft','course_id',:course_a,'format','stableford','format_config',json_build_object('version',1))::text)) AS r \gset
SELECT harness.ok('admin_upsert_event week 3 stableford', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, %L::jsonb)::text$q$, :e4, :league_a,
  json_build_object('name','Week 4','start_date','2026-09-22','status','draft','course_id',:course_a)::text)) AS r \gset
SELECT harness.ok('admin_upsert_event week 4 stroke', :'r' LIKE 'OK%', :'r');
-- AdminSchedule status toggle sends the whole event row back ({...event, status})
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, (SELECT to_jsonb(e) || '{"status":"draft"}' FROM events e WHERE id = %L))::text$q$, :e4, :league_a, :e4)) AS r \gset
SELECT harness.ok('admin_upsert_event full-row payload round-trip (status toggle)', :'r' LIKE 'OK%', :'r');
-- invalid: two open events in the same league
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, %L::jsonb)::text$q$, :e4, :league_a,
  json_build_object('name','Week 4','start_date','2026-09-22','status','open','course_id',:course_a)::text)) AS r \gset
SELECT harness.ok('second open event rejected', :'r' LIKE 'ERR%', :'r');
RESET ROLE;
-- location B: open its week
SELECT harness.login(:admin_b) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, %L::jsonb)::text$q$, :eb1, :league_b,
  json_build_object('name','B Week 1','start_date','2026-09-01','status','open','course_id',:course_b)::text)) AS r \gset
SELECT harness.ok('admin B opens B week 1', :'r' LIKE 'OK%', :'r');
RESET ROLE;

\echo '=== 2. submit_scores (ScoreEntry.jsx) ==='
SELECT harness.login(:u1, 'p1@a.test') \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT submit_scores(%L, %L::jsonb)::text$q$, :e1, json_build_array(
  json_build_object('player_id', :p1, 'hole_scores', json_build_array(4,3,5,5,4,3,4,5,5),
    'hole_stats', (SELECT json_agg(json_build_object('putts',2,'fir',true,'gir',null)) FROM generate_series(1,9))),
  json_build_object('player_id', :p2, 'hole_scores', json_build_array(5,4,5,6,5,4,5,5,6), 'hole_stats', null))::text)) AS r \gset
SELECT harness.ok('p1 submits team 1 (with hole_stats)', :'r' LIKE 'OK%"inserted": 2%', :'r');
SELECT harness.try(format($q$SELECT submit_scores(%L, %L::jsonb)::text$q$, :e1, json_build_array(
  json_build_object('player_id', :p1, 'hole_scores', json_build_array(4,3,5,5,4,3,4,5,5)),
  json_build_object('player_id', :p2, 'hole_scores', json_build_array(5,4,5,6,5,4,5,5,6)))::text)) AS r \gset
SELECT harness.ok('duplicate submit is idempotent (already_submitted)', :'r' LIKE '%"already_submitted": true%', :'r');
SELECT harness.try(format($q$SELECT submit_scores(%L, %L::jsonb)::text$q$, :e1, json_build_array(
  json_build_object('player_id', :p3, 'hole_scores', json_build_array(4,3,5,5,4,3,4,5,5)),
  json_build_object('player_id', :p4, 'hole_scores', json_build_array(5,4,5,6,5,4,5,5,6)))::text)) AS r \gset
SELECT harness.ok('p1 cannot submit for another team', :'r' LIKE 'ERR%', :'r');
SELECT harness.try(format($q$SELECT submit_scores(%L, %L::jsonb)::text$q$, :e2, json_build_array(
  json_build_object('player_id', :p1, 'hole_scores', json_build_array(4,3,5,5,4,3,4,5,5)),
  json_build_object('player_id', :p2, 'hole_scores', json_build_array(5,4,5,6,5,4,5,5,6)))::text)) AS r \gset
SELECT harness.ok('submit to a draft (not open) week rejected', :'r' LIKE 'ERR%no longer open%', :'r');
SELECT harness.try($q$INSERT INTO public.scores (event_id, player_id, hole_scores, gross_total, net_total, handicap_used, location_id) SELECT id, (SELECT id FROM players WHERE user_id = auth.uid()), '{4,4,4,4,4,4,4,4,4}', 36, 31, 5, location_id FROM events WHERE status='open' LIMIT 1 RETURNING 'inserted'$q$) AS r \gset
SELECT harness.ok('RLS: player cannot INSERT into scores directly', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try($q$WITH u AS (UPDATE public.scores SET net_total = 1 WHERE player_id = (SELECT id FROM players WHERE user_id = auth.uid()) RETURNING 1) SELECT count(*)::text FROM u$q$) AS r \gset
SELECT harness.ok('RLS: player cannot UPDATE own score directly', :'r' LIKE 'ERR 42501%', :'r');
RESET ROLE;
SELECT harness.login(:u3, 'p3@a.test') \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT submit_scores(%L, %L::jsonb)::text$q$, :e1, json_build_array(
  json_build_object('player_id', :p3, 'hole_scores', json_build_array(4,4,4,5,4,3,4,4,5)),
  json_build_object('player_id', :p4, 'hole_scores', json_build_array(6,5,6,7,6,5,6,6,7)))::text)) AS r \gset
SELECT harness.ok('p3 submits team 2', :'r' LIKE 'OK%"inserted": 2%', :'r');
RESET ROLE;
-- location B player tries to submit into A's event
SELECT harness.login(:ub1, 'b1@b.test') \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT submit_scores(%L, %L::jsonb)::text$q$, :e1, json_build_array(
  json_build_object('player_id', :p1, 'hole_scores', json_build_array(4,3,5,5,4,3,4,5,5)),
  json_build_object('player_id', :p2, 'hole_scores', json_build_array(5,4,5,6,5,4,5,5,6)))::text)) AS r \gset
SELECT harness.ok('B player cannot submit into A event', :'r' LIKE 'ERR%', :'r');
SELECT harness.ok('RLS: B player sees 0 A scores', (SELECT count(*) FROM public.scores WHERE location_id = :loc_a) = 0,
  (SELECT count(*) FROM public.scores WHERE location_id = :loc_a)::text);
SELECT harness.ok('RLS: B player sees 0 A players (table)', (SELECT count(*) FROM public.players WHERE location_id = :loc_a) = 0, NULL);
SELECT harness.ok('B player sees A players via player_public', (SELECT count(*) FROM public.player_public WHERE location_id = :loc_a) = 9, NULL);
SELECT harness.ok('RLS: B player sees 0 A events', (SELECT count(*) FROM public.events WHERE location_id = :loc_a) = 0, NULL);
SELECT harness.ok('RLS: B player sees 0 A roster_at rows', (SELECT count(*) FROM public.roster_at WHERE location_id = :loc_a) = 0, NULL);
SELECT harness.try(format($q$SELECT publish_week(%L)::text$q$, :eb1)) AS r \gset
SELECT harness.ok('player cannot call publish_week (own location)', :'r' LIKE 'ERR 42501%', :'r');
RESET ROLE;

\echo '=== 3. Admin review / upsert / bulk approve (AdminScores.jsx) ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.ok('admin sees 4 pending rows', (SELECT count(*) FROM scores WHERE event_id = :e1 AND status='pending') = 4, NULL);
SELECT harness.try(format($q$SELECT admin_review_score((SELECT id FROM scores WHERE event_id=%L AND player_id=%L), 'verified')->>'status'$q$, :e1, :p1)) AS r \gset
SELECT harness.ok('admin_review_score approve p1', :'r' = 'OK: verified', :'r');
SELECT harness.try(format($q$SELECT admin_review_score((SELECT id FROM scores WHERE event_id=%L AND player_id=%L), 'rejected')->>'status'$q$, :e1, :p4)) AS r \gset
SELECT harness.ok('admin_review_score reject p4', :'r' = 'OK: rejected', :'r');
SELECT harness.try(format($q$SELECT admin_bulk_approve_scores(%L)::text$q$, :e1)) AS r \gset
SELECT harness.ok('admin_bulk_approve_scores approves remaining 2', :'r' LIKE '%"approved": 2%', :'r');
-- admin enters p5 (team 3) only; p6, p7, p8 no-show; p4 rejected -> penalty too
SELECT harness.try(format($q$SELECT admin_upsert_score(%L, %L::jsonb)::text$q$, :e1, json_build_array(
  json_build_object('player_id', :p5, 'hole_scores', json_build_array(4,3,4,5,4,3,4,4,5), 'handicap_used', 3, 'sub_played', false))::text)) AS r \gset
SELECT harness.ok('admin_upsert_score p5', :'r' LIKE 'OK%"updated": 1%', :'r');
-- decimal handicap in admin_upsert_score (AdminScores sends Math.round so int) and admin_create_player from import (parseFloat!)
SELECT harness.try(format($q$SELECT admin_create_player(%L, '{"first_name":"Dee","last_name":"Cimal","name":"Dee Cimal","handicap":8.5}')::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('admin_create_player with decimal handicap (AdminImport parseFloat path)', :'r' LIKE 'OK%', :'r');
RESET ROLE;
SELECT harness.login(:u1) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_upsert_score(%L, %L::jsonb)::text$q$, :e1, json_build_array(
  json_build_object('player_id', :p1, 'hole_scores', json_build_array(1,1,1,1,1,1,1,1,1)))::text)) AS r \gset
SELECT harness.ok('player cannot call admin_upsert_score', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try(format($q$SELECT admin_bulk_approve_scores(%L)::text$q$, :e1)) AS r \gset
SELECT harness.ok('player cannot call admin_bulk_approve_scores', :'r' LIKE 'ERR 42501%', :'r');
RESET ROLE;
SELECT harness.login(:admin_b) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT publish_week(%L)::text$q$, :e1)) AS r \gset
SELECT harness.ok('admin B cannot publish A week', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try(format($q$SELECT admin_upsert_score(%L, %L::jsonb)::text$q$, :e1, json_build_array(
  json_build_object('player_id', :p1, 'hole_scores', json_build_array(1,1,1,1,1,1,1,1,1)))::text)) AS r \gset
SELECT harness.ok('admin B cannot upsert A score', :'r' LIKE 'ERR 42501%', :'r');
RESET ROLE;

\echo '=== 4. publish_week (AdminDashboard.jsx) — penalties = par + hcp + 7 ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT publish_week(%L)::text$q$, :e1)) AS r \gset
SELECT harness.ok('publish_week week 1', :'r' LIKE 'OK%"published": true%', :'r');
SELECT harness.ok('penalties_added = 4 (p4 rejected, p6, p7, p8)', :'r' LIKE '%"penalties_added": 4%', :'r');
SELECT harness.ok('penalty net = 36 + round(hcp) + 7 for each penalty row',
  NOT EXISTS (SELECT 1 FROM scores s JOIN players p ON p.id = s.player_id
              WHERE s.event_id = :e1 AND s.entry_type = 'missed_penalty'
                AND (s.net_total <> 36 + round(p.handicap)::int + 7 OR s.handicap_used <> round(p.handicap)::int
                     OR s.hole_scores IS NOT NULL OR s.gross_total IS NOT NULL OR s.status <> 'verified')),
  (SELECT string_agg(p.name || '=' || s.net_total || '/hcp' || s.handicap_used, ', ' ORDER BY p.name) FROM scores s JOIN players p ON p.id = s.player_id WHERE s.event_id = :e1 AND s.entry_type='missed_penalty'));
SELECT harness.ok('week 1 closed', (SELECT status FROM events WHERE id = :e1) = 'closed', NULL);
SELECT harness.ok('week 2 opened', (SELECT status FROM events WHERE id = :e2) = 'open', (SELECT status FROM events WHERE id = :e2));
SELECT harness.ok('next_event_id = week 2', :'r' LIKE '%' || :e2 || '%', NULL);
SELECT harness.try(format($q$SELECT publish_week(%L)::text$q$, :e1)) AS r \gset
SELECT harness.ok('publish_week idempotent (already_closed)', :'r' LIKE '%"already_closed": true%', :'r');
SELECT harness.ok('no duplicate penalty rows after 2nd publish', (SELECT count(*) FROM scores WHERE event_id = :e1 AND entry_type='missed_penalty') = 4, NULL);
SELECT harness.ok('week 3 still draft', (SELECT status FROM events WHERE id = :e3) = 'draft', NULL);
-- late correction on closed week supersedes penalty
SELECT harness.try(format($q$SELECT admin_upsert_score(%L, %L::jsonb)::text$q$, :e1, json_build_array(
  json_build_object('player_id', :p7, 'hole_scores', json_build_array(5,4,5,6,5,4,5,5,6), 'handicap_used', 10))::text)) AS r \gset
SELECT harness.ok('late admin_upsert_score on closed week', :'r' LIKE 'OK%', :'r');
SELECT harness.ok('late score superseded p7 penalty', NOT EXISTS (SELECT 1 FROM scores WHERE event_id=:e1 AND player_id=:p7 AND entry_type='missed_penalty'), NULL);
-- admin_upsert_score for p4 (whose played row was REJECTED) -> new verified row, penalty removed
SELECT harness.try(format($q$SELECT admin_upsert_score(%L, %L::jsonb)::text$q$, :e1, json_build_array(
  json_build_object('player_id', :p4, 'hole_scores', json_build_array(6,5,6,7,6,5,6,6,7), 'handicap_used', 20))::text)) AS r \gset
SELECT harness.ok('admin re-enters rejected player score', :'r' LIKE 'OK%', :'r');
SELECT harness.ok('audit rows written for publish', (SELECT count(*) FROM audit_events WHERE action = 'event.publish') >= 1, NULL);
RESET ROLE;
SELECT harness.login(:u1) \g /dev/null
SET ROLE authenticated;
SELECT harness.ok('RLS: player cannot read audit_events', (SELECT count(*) FROM audit_events) = 0, NULL);
RESET ROLE;

\echo '=== 5. recalculate_handicaps (AdminHandicap.jsx) / recalculate_player_handicap ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try($q$SELECT recalculate_handicaps()::text$q$) AS r \gset
SELECT harness.ok('recalculate_handicaps', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT recalculate_player_handicap(%L)::text$q$, :p1)) AS r \gset
SELECT harness.ok('recalculate_player_handicap p1', :'r' LIKE 'OK%', :'r');
SELECT harness.ok('handicap_history rows written', (SELECT count(*) FROM handicap_history) > 0, (SELECT count(*) FROM handicap_history)::text);
SELECT harness.ok('p1 handicap = floor(avg(gross-par)*0.9)', (SELECT handicap FROM players WHERE id=:p1) = floor((38-36)*0.9), (SELECT handicap FROM players WHERE id=:p1)::text);
RESET ROLE;
SELECT harness.login(:u1) \g /dev/null
SET ROLE authenticated;
SELECT harness.try($q$SELECT recalculate_handicaps()::text$q$) AS r \gset
SELECT harness.ok('player cannot recalculate_handicaps', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try(format($q$WITH u AS (UPDATE players SET handicap = 0 WHERE id = %L RETURNING 1) SELECT count(*)::text FROM u$q$, :p1)) AS r \gset
SELECT harness.ok('player cannot change own handicap (guard trigger)', :'r' LIKE 'ERR%Protected%', :'r');
SELECT harness.try(format($q$WITH u AS (UPDATE players SET league_password = 'newpw' WHERE id = %L RETURNING 1) SELECT count(*)::text FROM u$q$, :p1)) AS r \gset
SELECT harness.ok('player can change own league_password (PlayerProfile)', :'r' = 'OK: 1', :'r');
SELECT harness.try(format($q$WITH u AS (UPDATE players SET avatar_url = 'x' WHERE id = %L RETURNING 1) SELECT count(*)::text FROM u$q$, :p1)) AS r \gset
SELECT harness.ok('player can change own avatar_url (PlayerProfile)', :'r' = 'OK: 1', :'r');
SELECT harness.try(format($q$WITH u AS (UPDATE players SET name = 'hacked' WHERE id = %L RETURNING 1) SELECT count(*)::text FROM u$q$, :p2)) AS r \gset
SELECT harness.ok('player cannot update a teammate row', :'r' = 'OK: 0', :'r');
RESET ROLE;

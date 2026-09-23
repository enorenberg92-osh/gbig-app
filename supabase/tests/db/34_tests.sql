-- Batch 5: probes for behaviour introduced by 202609230001_review_fixes.sql
-- (skips gracefully on a committed-only schema).
\set ON_ERROR_STOP 0
\pset tuples_only on
\ir 29_ids.psql
\echo '=== 24. review_fixes probes ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
-- a) removing a played score on a closed week re-issues the missed-week penalty
SELECT harness.try(format($q$SELECT admin_delete_score((SELECT id FROM scores WHERE event_id=%L AND player_id=%L AND entry_type='played' AND status='verified'))::text$q$, :e1, :p3)) AS r \gset
SELECT harness.ok('closed-week delete of played score -> penalty restored',
  EXISTS (SELECT 1 FROM scores WHERE event_id=:e1 AND player_id=:p3 AND entry_type='missed_penalty'),
  :'r' || ' / penalty net=' || COALESCE((SELECT net_total::text FROM scores WHERE event_id=:e1 AND player_id=:p3 AND entry_type='missed_penalty'), 'none'));
-- b) re-entering the score supersedes the restored penalty again
SELECT harness.try(format($q$SELECT admin_upsert_score(%L, %L::jsonb)::text$q$, :e1, json_build_array(
  json_build_object('player_id', :p3, 'hole_scores', json_build_array(4,4,4,5,4,3,4,4,5), 'handicap_used', 8))::text)) AS r \gset
SELECT harness.ok('re-entry removes restored penalty', NOT EXISTS (SELECT 1 FROM scores WHERE event_id=:e1 AND player_id=:p3 AND entry_type='missed_penalty'), :'r');
-- c) app_event capacity enforced server-side
SELECT harness.try(format($q$INSERT INTO app_events (title, event_date, capacity, location_id) VALUES ('Tiny', '2026-11-01', 1, %L) RETURNING id::text$q$, :loc_a)) AS r \gset
RESET ROLE;
SELECT harness.login(:u1) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$INSERT INTO event_signups (event_id, player_id, location_id) VALUES ((SELECT id FROM app_events WHERE title='Tiny'), %L, %L) RETURNING 'ok'$q$, :p1, :loc_a)) AS r \gset
SELECT harness.ok('first RSVP to capacity-1 event', :'r' = 'OK: ok', :'r');
RESET ROLE;
SELECT harness.login(:u2) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$INSERT INTO event_signups (event_id, player_id, location_id) VALUES ((SELECT id FROM app_events WHERE title='Tiny'), %L, %L) RETURNING 'ok'$q$, :p2, :loc_a)) AS r \gset
SELECT harness.ok('second RSVP to capacity-1 event rejected', :'r' LIKE 'ERR%', :'r');
-- d) player may not rename themselves / change email directly
SELECT harness.try(format($q$WITH u AS (UPDATE players SET name='Impostor' WHERE id=%L RETURNING 1) SELECT count(*)::text FROM u$q$, :p2)) AS r \gset
SELECT harness.ok('player cannot rename own profile directly', :'r' LIKE 'ERR%', :'r');
-- e) other location members cannot read push endpoints
SELECT harness.ok('player cannot read another user''s push subscription', (SELECT count(*) FROM push_subscriptions WHERE user_id IS DISTINCT FROM auth.uid()) = 0, NULL);
RESET ROLE;
SELECT 'FAIL: ' || label || ' :: ' || COALESCE(info,'') FROM harness.results WHERE NOT pass ORDER BY n;

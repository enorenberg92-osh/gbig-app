-- Runtime checks on the LEGACY-data database (DB=gbig_legacy): the migrated
-- open week can be published by the auto-promoted legacy admin.
\set ON_ERROR_STOP 0
\pset tuples_only on
\ir 10_harness_helpers.sql
TRUNCATE harness.results;
SELECT harness.login('11111111-0000-0000-0000-000000000001') \g /dev/null
SET ROLE authenticated;
SELECT harness.try($q$SELECT publish_week('77777777-0000-0000-0000-000000000002')::text$q$) AS r \gset
SELECT harness.ok('legacy: publish_week on migrated open week', :'r' LIKE 'OK%"penalties_added": 2%', :'r');
SELECT harness.ok('legacy: penalties = 36 + round(hcp) + 7',
  (SELECT array_agg(net_total ORDER BY net_total) FROM scores WHERE entry_type='missed_penalty') = ARRAY[46, 61],
  (SELECT array_agg(net_total ORDER BY net_total)::text FROM scores WHERE entry_type='missed_penalty'));
SELECT harness.ok('legacy: week 3 opened', (SELECT status FROM events WHERE week_number = 3) = 'open', NULL);
SELECT harness.try($q$SELECT recalculate_handicaps()::text$q$) AS r \gset
SELECT harness.ok('legacy: recalculate_handicaps with numeric legacy handicaps', :'r' LIKE 'OK%', :'r');
SELECT harness.try($q$SELECT admin_update_player('55555555-0000-0000-0000-000000000002', '{"name":"L Two B"}')::text$q$) AS r \gset
SELECT harness.ok('legacy: admin_update_player without handicap key', :'r' LIKE 'OK%', :'r');
SELECT harness.try($q$SELECT admin_update_player('55555555-0000-0000-0000-000000000002', '{"handicap":null,"name":"L Two C"}')::text$q$) AS r \gset
SELECT harness.ok('legacy: admin_update_player with handicap:null (AdminPlayers sends null for blank)', :'r' LIKE 'OK%', :'r');
SELECT harness.try($q$SELECT admin_delete_player('55555555-0000-0000-0000-000000000001')::text$q$) AS r \gset
SELECT harness.ok('legacy: delete rostered player is refused cleanly', :'r' LIKE 'ERR%active team%', :'r');
RESET ROLE;
SELECT 'FAIL: ' || label || ' :: ' || COALESCE(info,'') FROM harness.results WHERE NOT pass;
SELECT count(*) FILTER (WHERE pass) || ' passed, ' || count(*) FILTER (WHERE NOT pass) || ' failed' FROM harness.results;

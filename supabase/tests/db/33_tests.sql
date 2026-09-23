-- Batch 4: team edit (rename) after a mid-season swap rewrites roster history.
\set ON_ERROR_STOP 0
\pset tuples_only on
\ir 29_ids.psql
\echo '=== 23. admin_save_team rename after swap ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.ok('before: roster_at week 2 T4 = 2 players', (SELECT count(*) FROM roster_at WHERE event_id = :e2 AND team_id = :t4) = 2,
  (SELECT string_agg(player_name, ', ') FROM roster_at WHERE event_id = :e2 AND team_id = :t4));
SELECT harness.try(format($q$SELECT admin_save_team(%L, %L, 'Team 4 (renamed)', %L::jsonb)::text$q$, :t4, :league_a, json_build_array(:p7, :p9)::text)) AS r \gset
SELECT harness.ok('admin_save_team rename (same current players) after swap', :'r' LIKE 'OK%', :'r');
SELECT harness.ok('after rename: roster_at week 2 T4 still = 2 players (history preserved)', (SELECT count(*) FROM roster_at WHERE event_id = :e2 AND team_id = :t4) = 2,
  (SELECT string_agg(player_name, ', ') FROM roster_at WHERE event_id = :e2 AND team_id = :t4));
RESET ROLE;
SELECT 'FAIL: ' || label || ' :: ' || COALESCE(info,'') FROM harness.results WHERE NOT pass AND n > (SELECT max(n) - 3 FROM harness.results);

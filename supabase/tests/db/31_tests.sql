-- Batch 2: subs, matchups/format engine, roster swap, team/player deletes,
-- flights, ledger, cups, tournaments, super admin, push, social, events.
-- Run after 30_tests.sql (depends on its state: week 1 published, week 2 open).
\set ON_ERROR_STOP 0
\pset pager off
\pset footer off
\pset tuples_only on
\ir 29_ids.psql

\echo '=== 6. Subs (SubRequest.jsx / AdminSubs.jsx) ==='
SELECT harness.login(:u1, 'p1@a.test') \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT request_sub(%L, %L::jsonb)::text$q$, :e2,
  '{"sub_first_name":"Guest","sub_last_name":"Golfer","sub_email":"g@x.test","sub_phone":"555","sub_handicap":14,"sub_player_id":null}')) AS r \gset
SELECT harness.ok('request_sub p1 week 2', :'r' LIKE 'OK%', :'r');
SELECT harness.ok('RLS: player can read own sub request', (SELECT count(*) FROM subs WHERE player_id = :p1) = 1, NULL);
RESET ROLE;
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_set_sub_status((SELECT id FROM subs WHERE player_id=%L), 'approved')::text$q$, :p1)) AS r \gset
SELECT harness.ok('admin_set_sub_status approved -> creates sub profile', :'r' LIKE 'OK%sub_player_id%', :'r');
SELECT harness.ok('sub profile created with is_sub', (SELECT count(*) FROM players WHERE is_sub AND name = 'Guest Golfer') = 1, NULL);
SELECT harness.try(format($q$SELECT admin_set_sub_status((SELECT id FROM subs WHERE player_id=%L), 'approved')::text$q$, :p1)) AS r \gset
SELECT harness.ok('re-approve reuses same profile (no duplicate)', (SELECT count(*) FROM players WHERE name = 'Guest Golfer') = 1, :'r');
RESET ROLE;

\echo '=== 7. Matchups (AdminSchedule.jsx admin_set_matchups) + match_team scoring on publish ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_set_matchups(%L, %L::jsonb)::text$q$, :e2,
  json_build_array(json_build_object('home_team_id', :t1, 'away_team_id', :t2), json_build_object('home_team_id', :t3, 'away_team_id', :t4))::text)) AS r \gset
SELECT harness.ok('admin_set_matchups week 2 (2 pairs)', :'r' = 'OK: 2', :'r');
SELECT harness.try(format($q$SELECT admin_set_matchups(%L, %L::jsonb)::text$q$, :e2,
  json_build_array(json_build_object('home_team_id', :t1, 'away_team_id', :t2), json_build_object('home_team_id', :t1, 'away_team_id', :t3))::text)) AS r \gset
SELECT harness.ok('team in two matchups rejected', :'r' LIKE 'ERR%one matchup%', :'r');
SELECT harness.ok('failed set_matchups left previous 2 pairs intact', (SELECT count(*) FROM matchups WHERE event_id = :e2) = 2, NULL);
-- individual matchups on week 4 (draft) - roster check
SELECT harness.try(format($q$SELECT admin_set_matchups(%L, %L::jsonb)::text$q$, :e4,
  json_build_array(json_build_object('home_player_id', :p1, 'away_player_id', :p3))::text)) AS r \gset
SELECT harness.ok('admin_set_matchups individual pair', :'r' = 'OK: 1', :'r');
RESET ROLE;
-- players submit week 2 (T1 high scores, T2 low scores, T3 plays, T4 no-show)
SELECT harness.login(:u1) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT submit_scores(%L, %L::jsonb)::text$q$, :e2, json_build_array(
  json_build_object('player_id', :p1, 'hole_scores', json_build_array(5,4,5,6,5,4,5,5,6)),
  json_build_object('player_id', :p2, 'hole_scores', json_build_array(6,5,6,7,6,5,6,6,7)))::text)) AS r \gset
SELECT harness.ok('T1 submits week 2', :'r' LIKE 'OK%', :'r');
SELECT harness.ok('player sees own matchups (RLS)', (SELECT count(*) FROM matchups WHERE event_id = :e2) = 2, NULL);
RESET ROLE;
SELECT harness.login(:u3) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT submit_scores(%L, %L::jsonb)::text$q$, :e2, json_build_array(
  json_build_object('player_id', :p3, 'hole_scores', json_build_array(3,3,3,4,3,3,3,3,4)),
  json_build_object('player_id', :p4, 'hole_scores', json_build_array(4,3,4,5,4,3,4,4,5)))::text)) AS r \gset
SELECT harness.ok('T2 submits week 2', :'r' LIKE 'OK%', :'r');
RESET ROLE;
SELECT harness.login(:u5) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT submit_scores(%L, %L::jsonb)::text$q$, :e2, json_build_array(
  json_build_object('player_id', :p5, 'hole_scores', json_build_array(4,3,4,5,4,3,4,4,5)),
  json_build_object('player_id', :p6, 'hole_scores', json_build_array(4,3,4,5,4,3,4,4,5)))::text)) AS r \gset
SELECT harness.ok('T3 submits week 2', :'r' LIKE 'OK%', :'r');
RESET ROLE;
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT publish_week(%L)::text$q$, :e2)) AS r \gset
SELECT harness.ok('publish_week blocked while pending rows exist', :'r' LIKE 'ERR%pending%', :'r');
SELECT harness.try(format($q$SELECT admin_bulk_approve_scores(%L)::text$q$, :e2)) AS r \gset
SELECT harness.ok('bulk approve week 2', :'r' LIKE '%"approved": 6%', :'r');
SELECT harness.try(format($q$SELECT publish_week(%L)::text$q$, :e2)) AS r \gset
SELECT harness.ok('publish_week week 2 (match_team)', :'r' LIKE 'OK%"matchups_scored": 2%', :'r');
SELECT harness.ok('T2 beats T1 (2 pts), T1 0 pts',
  (SELECT points_home = 0 AND points_away = 2 FROM matchups WHERE event_id=:e2 AND home_team_id=:t1),
  (SELECT result::text || ' ' || points_home || '-' || points_away FROM matchups WHERE event_id=:e2 AND home_team_id=:t1));
SELECT harness.ok('T4 no-show: T3 gets win, T4 forfeit',
  (SELECT points_home = 2 AND points_away = 0 FROM matchups WHERE event_id=:e2 AND home_team_id=:t3),
  (SELECT result::text || ' ' || points_home || '-' || points_away FROM matchups WHERE event_id=:e2 AND home_team_id=:t3));
SELECT harness.ok('T4 players got penalties in week 2', (SELECT count(*) FROM scores WHERE event_id=:e2 AND entry_type='missed_penalty') = 2, NULL);
SELECT harness.ok('week 3 opened', (SELECT status FROM events WHERE id = :e3) = 'open', NULL);
SELECT harness.try(format($q$SELECT admin_set_matchups(%L, '[]')::text$q$, :e2)) AS r \gset
SELECT harness.ok('matchups of closed week immutable', :'r' LIKE 'ERR%', :'r');
SELECT harness.try(format($q$SELECT admin_rescore_event(%L)::text$q$, :e2)) AS r \gset
SELECT harness.ok('admin_rescore_event on closed week', :'r' LIKE 'OK%', :'r');
RESET ROLE;

\echo '=== 8. Roster swap (AdminPlayers.jsx admin_swap_team_member) ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_swap_team_member(%L, %L, %L, %L)::text$q$, :t4, :p8, :p9, '2026-09-01')) AS r \gset
SELECT harness.ok('swap with effective date = join date rejected', :'r' LIKE 'ERR%Effective date%', :'r');
SELECT harness.try(format($q$SELECT admin_swap_team_member(%L, %L, %L, %L)::text$q$, :t4, :p8, :p3, '2026-09-15')) AS r \gset
SELECT harness.ok('swap in a player already on a team rejected', :'r' LIKE 'ERR%already on a team%', :'r');
SELECT harness.try(format($q$SELECT admin_swap_team_member(%L, %L, %L, %L)::text$q$, :t4, :p8, :p9, '2026-09-15')) AS r \gset
SELECT harness.ok('admin_swap_team_member p8 -> p9 from week 3', :'r' LIKE 'OK%', :'r');
SELECT harness.ok('roster_at week 2 still has p8', EXISTS (SELECT 1 FROM roster_at WHERE event_id=:e2 AND player_id=:p8 AND team_id=:t4), NULL);
SELECT harness.ok('roster_at week 3 has p9 not p8',
  EXISTS (SELECT 1 FROM roster_at WHERE event_id=:e3 AND player_id=:p9 AND team_id=:t4)
  AND NOT EXISTS (SELECT 1 FROM roster_at WHERE event_id=:e3 AND player_id=:p8), NULL);
SELECT harness.ok('teams.player2_id refreshed to p9', (SELECT player2_id FROM teams WHERE id=:t4) = :p9, NULL);
-- "Use team edit to correct a roster from the start" after a swap -> put p8 back
SELECT harness.try(format($q$SELECT admin_save_team(%L, %L, 'Team 4', %L::jsonb)::text$q$, :t4, :league_a, json_build_array(:p7, :p8)::text)) AS r \gset
SELECT harness.ok('admin_save_team (edit) after a swap, restoring original player', :'r' LIKE 'OK%', :'r');
-- edit a team with no swap history (rename + same players)
SELECT harness.try(format($q$SELECT admin_save_team(%L, %L, 'Team One', %L::jsonb)::text$q$, :t1, :league_a, json_build_array(:p1, :p2)::text)) AS r \gset
SELECT harness.ok('admin_save_team rename existing team', :'r' LIKE 'OK%', :'r');
RESET ROLE;

\echo '=== 9. Stableford week 3 + rescore ==='
SELECT harness.login(:u1) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT submit_scores(%L, %L::jsonb)::text$q$, :e3, json_build_array(
  json_build_object('player_id', :p1, 'hole_scores', json_build_array(4,3,4,5,4,3,4,4,5)),
  json_build_object('player_id', :p2, 'hole_scores', json_build_array(5,4,5,6,5,4,5,5,6)))::text)) AS r \gset
SELECT harness.ok('T1 submits week 3', :'r' LIKE 'OK%', :'r');
RESET ROLE;
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT admin_bulk_approve_scores(:e3) \g /dev/null
SELECT harness.try(format($q$SELECT admin_rescore_event(%L)::text$q$, :e3)) AS r \gset
SELECT harness.ok('admin_rescore_event stableford', :'r' LIKE 'OK%"players_scored": 2%', :'r');
SELECT harness.ok('stableford points filled', (SELECT count(*) FROM scores WHERE event_id=:e3 AND format_points IS NOT NULL) = 2,
  (SELECT string_agg(player_id::text || '=' || format_points, ',') FROM scores WHERE event_id=:e3));
RESET ROLE;

\echo '=== 10. Deletes: team with scores, player with history ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_delete_team(%L)::text$q$, :t2)) AS r \gset
SELECT harness.ok('admin_delete_team on a team that has scores: succeeds or refuses with a clean message (not a raw FK error)', :'r' LIKE 'OK%' OR :'r' LIKE 'ERR P0001%', :'r');
-- Use the teamless guest sub profile: give it a verified score + handicap history, then delete it
SELECT (SELECT id FROM players WHERE name = 'Guest Golfer') AS gsub \gset
\set gsub '''':gsub''''
SELECT harness.try(format($q$SELECT admin_upsert_score(%L, %L::jsonb)::text$q$, :e1, json_build_array(
  json_build_object('player_id', :gsub, 'hole_scores', json_build_array(5,4,5,6,5,4,5,5,6), 'handicap_used', 14))::text)) AS r \gset
SELECT harness.try(format($q$SELECT recalculate_player_handicap(%L)::text$q$, :gsub)) AS r2 \gset
SELECT harness.ok('guest sub has handicap_history', (SELECT count(*) FROM handicap_history WHERE player_id = :gsub) > 0, :'r2');
SELECT harness.try(format($q$SELECT admin_delete_player(%L)::text$q$, :gsub)) AS r \gset
SELECT harness.ok('admin_delete_player for a player with handicap_history', :'r' LIKE 'OK%', :'r');
RESET ROLE;

\echo '=== 11. Flights (AdminLeague.jsx) ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$INSERT INTO flights (location_id, league_id, name) VALUES (%L, %L, 'A Flight') RETURNING id::text$q$, :loc_a, :league_a)) AS r \gset
SELECT harness.ok('admin inserts flight directly', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT admin_assign_flights(%L, %L::jsonb)::text$q$, :league_a,
  json_build_array(json_build_object('team_id', :t1, 'flight_id', (SELECT id FROM flights LIMIT 1)), json_build_object('team_id', :t3, 'flight_id', null))::text)) AS r \gset
SELECT harness.ok('admin_assign_flights', :'r' = 'OK: 2', :'r');
RESET ROLE;
SELECT harness.login(:u1) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$INSERT INTO flights (location_id, league_id, name) VALUES (%L, %L, 'P Flight') RETURNING id::text$q$, :loc_a, :league_a)) AS r \gset
SELECT harness.ok('RLS: player cannot insert flights', :'r' LIKE 'ERR 42501%', :'r');
RESET ROLE;

\echo '=== 12. Ledger (AdminMoney.jsx) ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_add_ledger_entries(%L, %L::jsonb)::text$q$, :league_a, json_build_array(
  json_build_object('type','entry_fee','amount',-20,'player_id',:p1,'note','Season fee'),
  json_build_object('type','skins','amount',10,'team_id',:t1,'event_id',:e1))::text)) AS r \gset
SELECT harness.ok('admin_add_ledger_entries', :'r' = 'OK: 2', :'r');
SELECT harness.try(format($q$SELECT admin_add_ledger_entries(%L, %L::jsonb)::text$q$, :league_a, json_build_array(
  json_build_object('type','bogus','amount',5,'player_id',:p1))::text)) AS r \gset
SELECT harness.ok('invalid ledger type rejected', :'r' LIKE 'ERR%Invalid ledger type%', :'r');
SELECT harness.try(format($q$SELECT admin_add_ledger_entries(%L, %L::jsonb)::text$q$, :league_a, json_build_array(
  json_build_object('type','payout','amount',5,'player_id',:pb1))::text)) AS r \gset
SELECT harness.ok('cross-location player in ledger rejected', :'r' LIKE 'ERR%', :'r');
SELECT harness.try($q$SELECT admin_delete_ledger_entry((SELECT id FROM ledger WHERE type='skins'))::text$q$) AS r \gset
SELECT harness.ok('admin_delete_ledger_entry', :'r' = 'OK: true', :'r');
RESET ROLE;
SELECT harness.login(:u1) \g /dev/null
SET ROLE authenticated;
SELECT harness.ok('RLS: player cannot read ledger', (SELECT count(*) FROM ledger) = 0, NULL);
SELECT harness.try(format($q$SELECT admin_add_ledger_entries(%L, '[{"type":"payout","amount":100,"player_id":"%s"}]')::text$q$, :league_a, :p1)) AS r \gset
SELECT harness.ok('player cannot add ledger entries', :'r' LIKE 'ERR 42501%', :'r');
RESET ROLE;

\echo '=== 13. Ryder Cup (AdminCup.jsx) ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_upsert_cup(NULL, %L, '{"name":"Fall Cup","point_rules":{"version":1,"win":2,"tie":1,"loss":0,"weeks":4}}')::text$q$, :league_a)) AS r \gset
SELECT harness.ok('admin_upsert_cup create', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT admin_upsert_cup_match(NULL, (SELECT id FROM cups LIMIT 1), %L::jsonb)::text$q$,
  json_build_object('session','singles','match_order',1,'team_a_players',json_build_array(:p1),'team_b_players',json_build_array(:p3))::text)) AS r \gset
SELECT harness.ok('admin_upsert_cup_match singles', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT admin_upsert_cup_match(NULL, (SELECT id FROM cups LIMIT 1), %L::jsonb)::text$q$,
  json_build_object('session','fourball','team_a_players',json_build_array(:p1),'team_b_players',json_build_array(:p3))::text)) AS r \gset
SELECT harness.ok('fourball with 1 player per side rejected', :'r' LIKE 'ERR%', :'r');
SELECT harness.try($q$SELECT admin_set_cup_match_result((SELECT id FROM cup_matches LIMIT 1), 'team_a')->>'result'$q$) AS r \gset
SELECT harness.ok('admin_set_cup_match_result', :'r' = 'OK: team_a', :'r');
RESET ROLE;
SELECT harness.login(:u1) \g /dev/null
SET ROLE authenticated;
SELECT harness.try($q$SELECT json_agg(q)::text FROM cup_qualification((SELECT id FROM cups LIMIT 1)) q$q$) AS r \gset
SELECT harness.ok('cup_qualification as player', :'r' LIKE 'OK%', :'r');
RESET ROLE;
SELECT harness.login(:ub1) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT count(*)::text FROM cup_qualification(%L)$q$, (SELECT id FROM cups LIMIT 1))) AS r \gset
RESET ROLE;
SELECT harness.ok('cup_qualification cross-location denied', :'r' LIKE 'ERR%', :'r');

\echo '=== 14. Tournaments (AdminTournaments.jsx / EventsPage.jsx) ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_upsert_tournament(NULL, %L, %L::jsonb)::text$q$, :loc_a,
  json_build_object('name','Club Champ','tournament_date','2026-10-01','course_id',:course_a,'format','stroke','team_size',1,'capacity',2)::text)) AS r \gset
SELECT harness.ok('admin_upsert_tournament stroke', :'r' LIKE 'OK%', :'r');
SELECT (SELECT id FROM tournaments WHERE name='Club Champ') AS tid \gset
\set tid '''':tid''''
SELECT harness.try(format($q$SELECT admin_upsert_tournament(NULL, %L, %L::jsonb)::text$q$, :loc_a,
  json_build_object('name','Scramble','course_id',:course_a,'format','scramble','team_size',2,'format_config',json_build_object('version',1,'team_handicap_pct',25))::text)) AS r \gset
SELECT harness.ok('admin_upsert_tournament scramble', :'r' LIKE 'OK%', :'r');
SELECT (SELECT id FROM tournaments WHERE name='Scramble') AS tid2 \gset
\set tid2 '''':tid2''''
RESET ROLE;
SELECT harness.login(:u1) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT signup_tournament(%L)::text$q$, :tid)) AS r \gset
SELECT harness.ok('signup_tournament p1', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT signup_tournament(%L)::text$q$, :tid)) AS r \gset
SELECT harness.ok('signup_tournament p1 again -> NULL (already)', :'r' = 'OK: <null>', :'r');
SELECT harness.try(format($q$SELECT withdraw_tournament(%L)::text$q$, :tid)) AS r \gset
SELECT harness.ok('withdraw_tournament p1', :'r' = 'OK: true', :'r');
SELECT harness.try(format($q$SELECT signup_tournament(%L)::text$q$, :tid)) AS r \gset
RESET ROLE;
SELECT harness.login(:u3) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT signup_tournament(%L)::text$q$, :tid)) AS r \gset
SELECT harness.ok('signup_tournament p3', :'r' LIKE 'OK%', :'r');
RESET ROLE;
SELECT harness.login(:u5) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT signup_tournament(%L)::text$q$, :tid)) AS r \gset
SELECT harness.ok('capacity enforced', :'r' LIKE 'ERR%full%', :'r');
RESET ROLE;
SELECT harness.login(:ub1) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT signup_tournament(%L)::text$q$, :tid)) AS r \gset
SELECT harness.ok('B player cannot sign up for A tournament', :'r' LIKE 'ERR%', :'r');
SELECT harness.try(format($q$SELECT tournament_leaderboard(%L)::text$q$, :tid)) AS r \gset
SELECT harness.ok('B player cannot read A leaderboard', :'r' LIKE 'ERR 42501%', :'r');
RESET ROLE;
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_set_tournament_entry(%L, %L, true)::text$q$, :tid, :p5)) AS r \gset
SELECT harness.ok('admin_set_tournament_entry add past capacity (admin override)', :'r' = 'OK: true', :'r');
SELECT harness.try(format($q$SELECT admin_enter_tournament_score(%L, %L, '[4,3,4,5,4,3,4,4,5]'::jsonb, 5)::text$q$, :tid, :p1)) AS r \gset
SELECT harness.ok('admin_enter_tournament_score p1', :'r' = 'OK: true', :'r');
SELECT harness.try(format($q$SELECT admin_enter_tournament_score(%L, %L, '[3,3,4,4,4,3,4,4,5]'::jsonb, 8)::text$q$, :tid, :p3)) AS r \gset
SELECT harness.ok('admin_enter_tournament_score p3', :'r' = 'OK: true', :'r');
-- AdminTournaments status change sends {...t, status, format_config: cfg}
SELECT harness.try(format($q$SELECT admin_upsert_tournament(%L, %L, (SELECT to_jsonb(t) || '{"status":"scoring"}' FROM tournaments t WHERE id = %L))::text$q$, :tid, :loc_a, :tid)) AS r \gset
SELECT harness.ok('admin_upsert_tournament full-row status change', :'r' LIKE 'OK%', :'r');
-- scramble teams
SELECT admin_set_tournament_entry(:tid2, :p1, true), admin_set_tournament_entry(:tid2, :p2, true),
       admin_set_tournament_entry(:tid2, :p3, true), admin_set_tournament_entry(:tid2, :p4, true) \g /dev/null
SELECT harness.try(format($q$SELECT admin_set_tournament_teams(%L, %L::jsonb)::text$q$, :tid2, json_build_array(
  json_build_object('player_id',:p1,'team_no',1), json_build_object('player_id',:p2,'team_no',1),
  json_build_object('player_id',:p3,'team_no',2), json_build_object('player_id',:p4,'team_no',2))::text)) AS r \gset
SELECT harness.ok('admin_set_tournament_teams', :'r' = 'OK: 4', :'r');
SELECT harness.try(format($q$SELECT admin_set_tournament_teams(%L, %L::jsonb)::text$q$, :tid2, json_build_array(
  json_build_object('player_id',:p3,'team_no',1))::text)) AS r \gset
SELECT harness.ok('team oversize rejected', :'r' LIKE 'ERR%team size%', :'r');
SELECT admin_enter_tournament_score(:tid2, :p1, '[4,3,4,4,4,3,4,4,4]'::jsonb, 5),
       admin_enter_tournament_score(:tid2, :p2, '[4,3,4,4,4,3,4,4,4]'::jsonb, 12),
       admin_enter_tournament_score(:tid2, :p3, '[3,3,4,4,4,3,4,4,4]'::jsonb, 8),
       admin_enter_tournament_score(:tid2, :p4, '[3,3,4,4,4,3,4,4,4]'::jsonb, 20) \g /dev/null
RESET ROLE;
SELECT harness.login(:u1) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT tournament_leaderboard(%L)::text$q$, :tid)) AS r \gset
SELECT harness.ok('tournament_leaderboard stroke (p3 net 26 first, p1 net 31)', :'r' LIKE '%Lee Three%Pat One%', :'r');
SELECT harness.try(format($q$SELECT tournament_leaderboard(%L)::text$q$, :tid2)) AS r \gset
SELECT harness.ok('tournament_leaderboard scramble', :'r' LIKE 'OK: [%', :'r');
RESET ROLE;

\echo '=== 15. Super admin (SuperAdminPage.jsx) ==='
SELECT harness.login(:super) \g /dev/null
SET ROLE authenticated;
SELECT harness.try($q$SELECT (super_admin_create_location('Oshkosh Golf', 'oshkosh', '#123456', 'America/Chicago')).id::text$q$) AS r \gset
SELECT harness.ok('super_admin_create_location', :'r' LIKE 'OK%', :'r');
SELECT harness.try($q$SELECT (super_admin_update_location((SELECT id FROM locations WHERE slug='oshkosh'),
   (SELECT to_jsonb(l) || '{"name":"Oshkosh GC","features":{"money":false}}' FROM locations l WHERE slug='oshkosh'))).name$q$) AS r \gset
SELECT harness.ok('super_admin_update_location with full row payload', :'r' = 'OK: Oshkosh GC', :'r');
SELECT harness.try($q$SELECT super_admin_invite_location_admin((SELECT id FROM locations WHERE slug='oshkosh'), 'p2@a.test')::text$q$) AS r \gset
SELECT harness.ok('super_admin_invite_location_admin', :'r' LIKE 'OK%', :'r');
SELECT harness.try($q$SELECT super_admin_invite_location_admin((SELECT id FROM locations WHERE slug='oshkosh'), 'nobody@x.test')::text$q$) AS r \gset
SELECT harness.ok('invite unknown email -> P0002', :'r' LIKE 'ERR P0002%', :'r');
SELECT harness.ok('super admin reads all location_admins', (SELECT count(*) FROM location_admins) >= 3, NULL);
SELECT harness.ok('super admin reads players cross-location', (SELECT count(DISTINCT location_id) FROM players) >= 2, NULL);
RESET ROLE;
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try($q$SELECT (super_admin_create_location('Evil', 'evil', '#000000', 'UTC')).id::text$q$) AS r \gset
SELECT harness.ok('location admin cannot create location', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try($q$WITH u AS (UPDATE locations SET name='x' WHERE slug='gbig' RETURNING 1) SELECT count(*)::text FROM u$q$) AS r \gset
SELECT harness.ok('location admin cannot update locations directly', :'r' = 'OK: 0', :'r');
SELECT harness.try($q$INSERT INTO location_admins (user_id, location_id) SELECT auth.uid(), id FROM locations WHERE slug='appleton' RETURNING 'x'$q$) AS r \gset
SELECT harness.ok('location admin cannot self-grant admin elsewhere', :'r' LIKE 'ERR 42501%', :'r');
-- feature flag gate: money disabled at oshkosh has no effect here; disable money at league A
UPDATE league_config SET features = '{"money": false}' WHERE id = :league_a;
SELECT harness.try(format($q$SELECT admin_add_ledger_entries(%L, '[{"type":"payout","amount":1,"player_id":"%s"}]')::text$q$, :league_a, :p1)) AS r \gset
SELECT harness.ok('feature flag money=false blocks ledger RPC', :'r' LIKE 'ERR 42501%disabled%', :'r');
UPDATE league_config SET features = '{}' WHERE id = :league_a;
SELECT harness.ok('league feature change audited', (SELECT count(*) FROM audit_events WHERE action = 'league.features.update') = 2, NULL);
RESET ROLE;

\echo '=== 16. Push subscriptions (AlertsPage.jsx) ==='
SELECT harness.logout() \g /dev/null
SET ROLE anon;
SELECT harness.try(format($q$SELECT subscribe_push('https://fcm.googleapis.com/fcm/send/abc', 'p256', 'authk', %L)::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('anon subscribe_push', :'r' LIKE 'OK%', :'r');
SELECT harness.try($q$SELECT count(*)::text FROM push_subscriptions$q$) AS r \gset
SELECT harness.ok('anon cannot read push_subscriptions', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try($q$SELECT count(*)::text FROM players$q$) AS r \gset
SELECT harness.ok('anon sees 0 players', :'r' = 'OK: 0' OR :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try($q$SELECT count(*)::text FROM location_public$q$) AS r \gset
SELECT harness.ok('anon can read location_public', :'r' LIKE 'OK: 3', :'r');
SELECT harness.try($q$SELECT count(*)::text FROM player_public$q$) AS r \gset
SELECT harness.ok('anon cannot read player_public', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try($q$SELECT unsubscribe_push('https://fcm.googleapis.com/fcm/send/abc')::text$q$) AS r \gset
SELECT harness.ok('anon unsubscribe_push', :'r' LIKE 'OK%', :'r');
RESET ROLE;
SELECT harness.login(:u1) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT subscribe_push('https://fcm.googleapis.com/fcm/send/p1', 'p256', 'authk', %L)::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('authenticated subscribe_push', :'r' LIKE 'OK%', :'r');
RESET ROLE;
SELECT harness.ok('push row stored with user_id', (SELECT user_id FROM push_subscriptions WHERE endpoint='https://fcm.googleapis.com/fcm/send/p1') = :u1, NULL);

\echo '=== 17. Social + event signups (FriendsTab.jsx / EventsPage.jsx) ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$INSERT INTO app_events (title, event_date, capacity, location_id) VALUES ('Social', '2026-10-10', 10, %L) RETURNING id::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('admin creates app_event', :'r' LIKE 'OK%', :'r');
RESET ROLE;
SELECT harness.login(:u1) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$INSERT INTO event_signups (event_id, player_id, location_id) VALUES ((SELECT id FROM app_events LIMIT 1), %L, %L) RETURNING 'ok'$q$, :p1, :loc_a)) AS r \gset
SELECT harness.ok('player signs up self for app_event', :'r' = 'OK: ok', :'r');
SELECT harness.try(format($q$INSERT INTO event_signups (event_id, player_id, location_id) VALUES ((SELECT id FROM app_events LIMIT 1), %L, %L) RETURNING 'ok'$q$, :p2, :loc_a)) AS r \gset
SELECT harness.ok('RLS: player cannot sign up SOMEONE ELSE for app_event', :'r' LIKE 'ERR%', :'r');
SELECT harness.try(format($q$WITH d AS (DELETE FROM event_signups WHERE player_id = %L RETURNING 1) SELECT count(*)::text FROM d$q$, :p2)) AS r \gset
SELECT harness.ok('RLS: player cannot delete SOMEONE ELSE''s signup', :'r' = 'OK: 0', :'r');
SELECT harness.try(format($q$INSERT INTO follows (follower_id, following_id) VALUES (%L, %L) RETURNING 'ok'$q$, :p1, :pb1)) AS r \gset
SELECT harness.ok('cross-location follow allowed', :'r' = 'OK: ok', :'r');
SELECT harness.try(format($q$INSERT INTO follows (follower_id, following_id) VALUES (%L, %L) RETURNING 'ok'$q$, :p2, :pb1)) AS r \gset
SELECT harness.ok('cannot create follow as someone else', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try(format($q$INSERT INTO messages (sender_id, recipient_id, content) VALUES (%L, %L, 'hi') RETURNING 'ok'$q$, :p1, :pb1)) AS r \gset
SELECT harness.ok('cross-location DM allowed', :'r' = 'OK: ok', :'r');
SELECT harness.try(format($q$INSERT INTO messages (sender_id, recipient_id, content) VALUES (%L, %L, 'spoof') RETURNING 'ok'$q$, :p2, :pb1)) AS r \gset
SELECT harness.ok('cannot send message as someone else', :'r' LIKE 'ERR 42501%', :'r');
RESET ROLE;
SELECT harness.login(:ub1) \g /dev/null
SET ROLE authenticated;
SELECT harness.ok('recipient reads DM', (SELECT count(*) FROM messages) = 1, NULL);
SELECT harness.ok('recipient sees follow row', (SELECT count(*) FROM follows) = 1, NULL);
RESET ROLE;
SELECT harness.login(:u1) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT count(*)::text FROM player_public WHERE id = %L$q$, :pb1)) AS r \gset
SELECT harness.ok('FriendsTab: player A reads followed B player via player_public', :'r' = 'OK: 1', :'r');
RESET ROLE;

\echo '=== 18. AdminLeague direct writes ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$WITH u AS (UPDATE league_config SET segments = '[{"name":"First half","start_week":1,"end_week":6}]' WHERE id = %L RETURNING 1) SELECT count(*)::text FROM u$q$, :league_a)) AS r \gset
SELECT harness.ok('admin updates segments', :'r' = 'OK: 1', :'r');
SELECT harness.try(format($q$WITH u AS (UPDATE league_config SET segments = '[{"name":"bad","start_week":5,"end_week":1}]' WHERE id = %L RETURNING 1) SELECT count(*)::text FROM u$q$, :league_a)) AS r \gset
SELECT harness.ok('invalid segments rejected', :'r' LIKE 'ERR 23514%', :'r');
SELECT harness.try(format($q$INSERT INTO league_config (name, num_weeks, start_date, is_active, default_format, location_id) VALUES ('Winter', 8, '2027-01-05', false, 'stroke', %L) RETURNING id::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('admin creates second league (AdminLeague insert)', :'r' LIKE 'OK%', :'r');
-- set-working flow: two separate updates as in AdminLeague.jsx:84-85
SELECT harness.try(format($q$WITH u AS (UPDATE league_config SET is_working = false WHERE location_id = %L RETURNING 1) SELECT count(*)::text FROM u$q$, :loc_a)) AS r \gset
SELECT harness.try(format($q$WITH u AS (UPDATE league_config SET is_working = true WHERE name = 'Winter' AND location_id = %L RETURNING 1) SELECT count(*)::text FROM u$q$, :loc_a)) AS r \gset
SELECT harness.ok('switch working league', :'r' = 'OK: 1', :'r');
SELECT harness.try($q$SELECT recalculate_handicaps()::text$q$) AS r \gset
SELECT harness.ok('recalculate_handicaps after working-league switch', :'r' LIKE 'OK%', :'r');
UPDATE league_config SET is_working = false WHERE location_id = :loc_a;
UPDATE league_config SET is_working = true WHERE id = :league_a;
SELECT harness.try(format($q$WITH d AS (DELETE FROM league_config WHERE id = %L RETURNING 1) SELECT count(*)::text FROM d$q$, :league_a)) AS r \gset
SELECT harness.ok('deleting a league with events fails cleanly (FK)', :'r' LIKE 'ERR 23503%', :'r');
SELECT harness.try(format($q$INSERT INTO courses (name, num_holes, hole_pars, total_par, location_id) VALUES ('Bad', 9, '[4,4,4]', 12, %L) RETURNING 'x'$q$, :loc_a)) AS r \gset
SELECT harness.ok('invalid course pars rejected by CHECK', :'r' LIKE 'ERR 23514%', :'r');
SELECT harness.try(format($q$INSERT INTO courses (name, num_holes, start_hole, hole_pars, total_par, stroke_index, location_id) VALUES ('Back 9', 9, 10, '[4,4,4,4,4,4,4,4,4]', 36, '[1,1,2,3,4,5,6,7,8]', %L) RETURNING 'x'$q$, :loc_a)) AS r \gset
SELECT harness.ok('non-permutation stroke_index rejected', :'r' LIKE 'ERR 23514%', :'r');
SELECT harness.try(format($q$INSERT INTO courses (name, num_holes, hole_pars, total_par, location_id) VALUES ('X', 9, '[4,4,4,4,4,4,4,4,4]', 36, %L) RETURNING 'x'$q$, :loc_b)) AS r \gset
SELECT harness.ok('admin A cannot create course at B', :'r' LIKE 'ERR 42501%', :'r');
RESET ROLE;

\echo '=== 19. Event lifecycle: delete draft event with matchups; closed event delete ==='
SELECT harness.login(:admin_a) \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_delete_event(%L)::text$q$, :e1)) AS r \gset
SELECT harness.ok('closed event cannot be deleted', :'r' LIKE 'ERR%Published%', :'r');
SELECT harness.try(format($q$SELECT admin_delete_event(%L)::text$q$, :e4)) AS r \gset
SELECT harness.ok('draft event with matchups deletable', :'r' = 'OK: true', :'r');
RESET ROLE;

\echo '=== RESULTS ==='
SELECT count(*) FILTER (WHERE pass) || ' passed, ' || count(*) FILTER (WHERE NOT pass) || ' failed' FROM harness.results;
SELECT 'FAIL: ' || label || ' :: ' || COALESCE(info,'') FROM harness.results WHERE NOT pass ORDER BY n;

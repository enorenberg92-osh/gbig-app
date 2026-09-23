-- Targeted tests for supabase/migrations/202609230001_review_fixes.sql
-- Run after 20_seed.sql on a fresh DB.
\set ON_ERROR_STOP 0
\pset pager off
\pset footer off
\pset tuples_only on
\ir 29_ids.psql
TRUNCATE harness.results;
-- create-player-account links accounts server-side; mirror that for p1.
RESET ROLE;
UPDATE public.players SET user_id = :u1 WHERE id = :p1;

\set pars '[4,3,4,5,4,3,4,4,5]'
\set par '''[4,3,4,5,4,3,4,4,5]'''
\set plus3 '''[5,4,5,5,4,3,4,4,5]'''
\set plus4 '''[5,4,5,6,4,3,4,4,5]'''
\set plus9 '''[5,4,5,6,5,4,5,5,6]'''

-- ── setup: courses on weeks, open week 1 ─────────────────────────────────────
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, jsonb_build_object('name','Week 1','start_date','2026-09-01','end_date','2026-09-07','status','open','course_id',%L,'week_number',1))::text$q$, :e1, :league_a, :course_a)) AS r \gset
SELECT harness.ok('open week 1', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, jsonb_build_object('name','Week 2','start_date','2026-09-08','end_date','2026-09-14','status','draft','course_id',%L,'week_number',2,'format','match_team','format_config','{"version":1}'::jsonb))::text$q$, :e2, :league_a, :course_a)) AS r \gset
SELECT harness.ok('week 2 match_team with course', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, jsonb_build_object('name','Week 3','start_date','2026-09-15','end_date','2026-09-21','status','draft','course_id',%L,'week_number',3))::text$q$, :e3, :league_a, :course_a)) AS r \gset
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, jsonb_build_object('name','Week 4','start_date','2026-09-22','end_date','2026-09-28','status','draft','course_id',%L,'week_number',4))::text$q$, :e4, :league_a, :course_a)) AS r \gset

-- ── 2. passwords wiped, identity fields guarded ─────────────────────────────
RESET ROLE;
SELECT harness.ok('league_password wiped for all players',
  (SELECT count(*) FROM public.players WHERE league_password IS NOT NULL) = 0);
SELECT harness.login(:u1, 'p1@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$UPDATE public.players SET league_password = 'x' WHERE id = %L RETURNING coalesce(league_password,'<null>')$q$, :p1)) AS r \gset
SELECT harness.ok('player own password write is stripped to NULL', :'r' = 'OK: <null>', :'r');
SELECT harness.try(format($q$UPDATE public.players SET name = 'Imposter' WHERE id = %L RETURNING name$q$, :p1)) AS r \gset
SELECT harness.ok('player cannot rename self', :'r' LIKE 'ERR%', :'r');
SELECT harness.try(format($q$UPDATE public.players SET avatar_url = 'https://x/y.png' WHERE id = %L RETURNING avatar_url$q$, :p1)) AS r \gset
SELECT harness.ok('player can still set own avatar', :'r' LIKE 'OK%', :'r');

-- ── 3. push subscriptions owner-only ────────────────────────────────────────
RESET ROLE;
INSERT INTO public.push_subscriptions (endpoint, p256dh, auth_key, user_id, location_id) VALUES
  ('https://fcm.googleapis.com/fcm/send/u1', 'k', 'a', :u1, :loc_a),
  ('https://fcm.googleapis.com/fcm/send/u2', 'k', 'a', :u2, :loc_a);
SELECT harness.login(:u1, 'p1@a.test');
SET ROLE authenticated;
SELECT harness.ok('player sees only own push row', (SELECT count(*) FROM public.push_subscriptions) = 1);
SELECT harness.try($q$WITH d AS (DELETE FROM public.push_subscriptions WHERE user_id <> auth.uid() RETURNING 1) SELECT count(*)::text FROM d$q$) AS r \gset
SELECT harness.ok('player cannot delete others push rows', :'r' = 'OK: 0', :'r');
SELECT harness.try(format($q$SELECT subscribe_push('https://updates.push.services.mozilla.com/wpush/v2/x', 'k', 'a', %L)::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('real push endpoint accepted', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT subscribe_push('https://evil.example/googleapis.com/', 'k', 'a', %L)::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('non push-service endpoint rejected', :'r' LIKE 'ERR%', :'r');
SELECT harness.login(:admin_a, 'admin@a.test');
SELECT harness.ok('admin sees subscriber count', (SELECT count(*) FROM public.push_subscriptions WHERE location_id = :loc_a) = 3);

-- ── 7. sub-week self submission tagged as sub round ─────────────────────────
SELECT harness.login(:u1, 'p1@a.test');
SELECT harness.try(format($q$SELECT request_sub(%L, '{"sub_first_name":"Sub","sub_last_name":"Guy","sub_handicap":33}')::text$q$, :e1)) AS r \gset
SELECT harness.ok('request_sub accepts handicap 33 (sub cap 40)', :'r' LIKE 'OK%', :'r');
SELECT substr(:'r', 5) AS sub_id \gset
SELECT harness.try(format($q$SELECT request_sub(%L, jsonb_build_object('sub_first_name','X','sub_last_name','Y','sub_handicap',5,'sub_player_id',%L))::text$q$, :e1, :p3)) AS r \gset
SELECT harness.ok('request_sub rejects a league player as sub_player_id', :'r' LIKE 'ERR%', :'r');
SELECT harness.login(:admin_a, 'admin@a.test');
SELECT harness.try(format($q$SELECT admin_set_sub_status(%L, 'approved')::text$q$, :'sub_id')) AS r \gset
SELECT harness.ok('approve sub', :'r' LIKE 'OK%', :'r');
SELECT harness.login(:u2, 'p2@a.test');
SELECT harness.try(format($q$SELECT submit_scores(%L, jsonb_build_array(
  jsonb_build_object('player_id', %L, 'hole_scores', %L::jsonb),
  jsonb_build_object('player_id', %L, 'hole_scores', %L::jsonb)))::text$q$, :e1, :p1, :par, :p2, :par)) AS r \gset
SELECT harness.ok('teammate submits in sub week', :'r' LIKE 'OK%', :'r');
RESET ROLE;
SELECT harness.ok('sub slot row tagged sub_played with sub handicap 33',
  (SELECT sub_played AND handicap_used = 33 FROM public.scores WHERE event_id = :e1 AND player_id = :p1),
  (SELECT row(sub_played, handicap_used)::text FROM public.scores WHERE event_id = :e1 AND player_id = :p1));
SELECT harness.ok('non-sub teammate row untagged',
  (SELECT NOT sub_played AND handicap_used = 12 FROM public.scores WHERE event_id = :e1 AND player_id = :p2));

-- ── 6. handicap exactness (diffs 3,3,4 → 3, not 2) ──────────────────────────
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_upsert_score(%L, jsonb_build_array(jsonb_build_object('player_id', %L, 'hole_scores', %L::jsonb)))::text$q$, :e2, :p9, :plus3)) AS r \gset
SELECT harness.try(format($q$SELECT admin_upsert_score(%L, jsonb_build_array(jsonb_build_object('player_id', %L, 'hole_scores', %L::jsonb)))::text$q$, :e3, :p9, :plus3)) AS r \gset
SELECT harness.try(format($q$SELECT admin_upsert_score(%L, jsonb_build_array(jsonb_build_object('player_id', %L, 'hole_scores', %L::jsonb)))::text$q$, :e4, :p9, :plus4)) AS r \gset
SELECT harness.try(format($q$SELECT recalculate_player_handicap(%L)::text$q$, :p9)) AS r \gset
SELECT harness.ok('handicap for diffs 3,3,4 is exactly 3', (SELECT handicap FROM public.players WHERE id = :p9) = 3, :'r');
SELECT harness.try(format($q$SELECT recalculate_handicaps(%L)::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('recalculate_handicaps(own location)', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT recalculate_handicaps(%L)::text$q$, :loc_b)) AS r \gset
SELECT harness.ok('recalculate_handicaps(other location) denied', :'r' LIKE 'ERR%', :'r');
SELECT harness.try($q$SELECT recalculate_handicaps()::text$q$) AS r \gset
SELECT harness.ok('recalculate_handicaps() still works for single-location admin', :'r' LIKE 'OK%', :'r');
-- clean p9's rounds so later weeks aren't affected
RESET ROLE;
DELETE FROM public.scores WHERE player_id = :p9;

-- ── publish week 1, then closed-week corrections ────────────────────────────
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_bulk_approve_scores(%L)::text$q$, :e1)) AS r \gset
SELECT harness.try(format($q$SELECT admin_upsert_score(%L, jsonb_build_array(
  jsonb_build_object('player_id', %L, 'hole_scores', %L::jsonb),
  jsonb_build_object('player_id', %L, 'hole_scores', %L::jsonb),
  jsonb_build_object('player_id', %L, 'hole_scores', %L::jsonb),
  jsonb_build_object('player_id', %L, 'hole_scores', %L::jsonb)))::text$q$, :e1, :p3, :par, :p4, :par, :p5, :par, :p6, :par)) AS r \gset
SELECT harness.ok('admin enters t2/t3', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT publish_week(%L)::text$q$, :e1)) AS r \gset
SELECT harness.ok('publish week 1 (penalties for p7,p8)', :'r' LIKE '%"penalties_added": 2%', :'r');

SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, jsonb_build_object('name','Week 1 (edited)','start_date','2026-09-01','end_date','2026-09-07','status','closed','course_id',%L,'week_number',1,'notes','rain'))::text$q$, :e1, :league_a, :course_a)) AS r \gset
SELECT harness.ok('edit a published week (status unchanged)', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, jsonb_build_object('name','Week 1','status','open','course_id',%L,'week_number',1))::text$q$, :e1, :league_a, :course_a)) AS r \gset
SELECT harness.ok('cannot reopen a published week', :'r' LIKE 'ERR%', :'r');
SELECT harness.try(format($q$SELECT admin_upsert_event(NULL, %L, jsonb_build_object('name','Bonus night','status','draft','course_id',%L))::text$q$, :league_a, :course_a)) AS r \gset
RESET ROLE;
SELECT harness.ok('new week without number gets next number (5)',
  (SELECT week_number FROM public.events WHERE id = substr(:'r', 5)::uuid) = 5, :'r');
SELECT harness.try(format($q$SELECT admin_upsert_event(NULL, %L, jsonb_build_object('name','Cross','course_id',%L))::text$q$, :league_a, :course_b)) AS r \gset

SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_upsert_event(NULL, %L, jsonb_build_object('name','Cross','course_id',%L))::text$q$, :league_a, :course_b)) AS r \gset
SELECT harness.ok('course from another location rejected', :'r' LIKE 'ERR%', :'r');

-- delete a played score on the closed week → penalty comes back
SELECT id AS p3_score FROM public.scores WHERE event_id = :e1 AND player_id = :p3 AND entry_type = 'played' \gset
SELECT harness.try(format($q$SELECT admin_delete_score(%L)::text$q$, :'p3_score')) AS r \gset
RESET ROLE;
SELECT harness.ok('deleting a closed-week score restores the missed-week penalty',
  EXISTS (SELECT 1 FROM public.scores WHERE event_id = :e1 AND player_id = :p3 AND entry_type = 'missed_penalty' AND net_total = 36 + 8 + 7),
  :'r');
-- single-player admin entry (p3 only) supersedes that penalty again
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_upsert_score(%L, jsonb_build_array(jsonb_build_object('player_id', %L, 'hole_scores', %L::jsonb, 'handicap_used', 8)))::text$q$, :e1, :p3, :par)) AS r \gset
RESET ROLE;
SELECT harness.ok('single-player closed-week entry supersedes penalty',
  NOT EXISTS (SELECT 1 FROM public.scores WHERE event_id = :e1 AND player_id = :p3 AND entry_type = 'missed_penalty')
  AND EXISTS (SELECT 1 FROM public.scores WHERE event_id = :e1 AND player_id = :p3 AND entry_type = 'played'), :'r');

-- ── 9. short-handed match side ──────────────────────────────────────────────
-- Week 2 match: t3 has only p5's score. The missing teammate counts par + 7/9 per hole.
RESET ROLE;
UPDATE public.events SET status = 'open' WHERE id = :e2 AND status <> 'open';
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_upsert_score(%L, jsonb_build_array(
  jsonb_build_object('player_id', %L, 'hole_scores', %L::jsonb, 'handicap_used', 0)))::text$q$, :e2, :p5, :par)) AS r \gset
RESET ROLE;
-- p6 (handicap 15) missing: plays net par + 15 + 7 = 58 for the round.
SELECT harness.ok('short side: missing teammate plays net par + their handicap + 7',
  (SELECT round(sum(x), 4) FROM unnest(public.per_hole_net_sum(:e2, :t3, NULL, NULL, 9, 100)) x) = 36 + 36 + 15 + 7,
  (SELECT round(sum(x), 4)::text FROM unnest(public.per_hole_net_sum(:e2, :t3, NULL, NULL, 9, 100)) x));
SELECT harness.ok('side with no scores is still a no-show (NULL)',
  public.per_hole_net_sum(:e2, :t4, NULL, NULL, 9, 100) IS NULL);
UPDATE public.events SET status = 'draft' WHERE id = :e2;
DELETE FROM public.scores WHERE event_id = :e2;

-- ── 10. rosters: swap dates vs published weeks; rename after swap ───────────
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_swap_team_member(%L, %L, %L, '2026-09-01')::text$q$, :t4, :p8, :p9)) AS r \gset
SELECT harness.ok('swap dated inside a published week rejected', :'r' LIKE 'ERR%', :'r');
SELECT harness.try(format($q$SELECT admin_swap_team_member(%L, %L, %L, '2026-09-15')::text$q$, :t4, :p8, :p9)) AS r \gset
SELECT harness.ok('swap p8 -> p9 from week 3', :'r' LIKE 'OK%', :'r');
SELECT harness.try_commit(format($q$SELECT admin_save_team(%L, %L, 'Renamed 4', jsonb_build_array(%L, %L))::text$q$, :t4, :league_a, :p7, :p9)) AS r \gset
SELECT harness.ok('rename team after swap', :'r' LIKE 'OK%', :'r');
RESET ROLE;
SELECT harness.ok('week 1 roster still p7+p8 (history intact)',
  (SELECT array_agg(player_id ORDER BY player_id) FROM public.roster_at WHERE event_id = :e1 AND team_id = :t4)
  = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[:p7::uuid, :p8::uuid]) x));
SELECT harness.ok('week 3 roster p7+p9',
  (SELECT array_agg(player_id ORDER BY player_id) FROM public.roster_at WHERE event_id = :e3 AND team_id = :t4)
  = (SELECT array_agg(x ORDER BY x) FROM unnest(ARRAY[:p7::uuid, :p9::uuid]) x));
-- replace p6 on t3 by editing the team: p6's team_id must be cleared
SELECT admin_create_player(:loc_a, '{"name":"New Guy","handicap":10}') AS pnew \gset
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT admin_create_player(:loc_a, '{"name":"New Guy","handicap":10}') AS pnew \gset
SELECT harness.try_commit(format($q$SELECT admin_save_team(%L, %L, 'Team 3', jsonb_build_array(%L, %L))::text$q$, :t3, :league_a, :p5, :'pnew')) AS r \gset
SELECT harness.ok('edit team replacing p6', :'r' LIKE 'OK%', :'r');
RESET ROLE;
SELECT harness.ok('removed player team_id cleared', (SELECT team_id FROM public.players WHERE id = :p6) IS NULL);
SELECT harness.ok('newcomer inherits slot date', (SELECT count(*) FROM public.roster_at WHERE event_id = :e1 AND team_id = :t3) = 2);

-- ── 11. players ─────────────────────────────────────────────────────────────
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT (admin_update_player(%L, '{"name":"Patricia  Onesie"}')->>'first_name') || '|' || (admin_update_player(%L, '{}')->>'last_name')$q$, :p1, :p1)) AS r \gset
SELECT harness.ok('rename updates first/last', :'r' = 'OK: Patricia|Onesie', :'r');

-- ── 14. ledger ──────────────────────────────────────────────────────────────
SELECT harness.try(format($q$SELECT admin_add_ledger_entries(%L, jsonb_build_array(jsonb_build_object('type','entry_fee','amount',50,'player_id',%L)))::text$q$, :league_a, :p1)) AS r \gset
SELECT harness.ok('positive entry fee rejected', :'r' LIKE 'ERR%', :'r');
SELECT harness.try(format($q$SELECT admin_add_ledger_entries(%L, jsonb_build_array(jsonb_build_object('type','skins','amount',0.30000000000000004,'player_id',%L)))::text$q$, :league_a, :p1)) AS r \gset
SELECT harness.ok('skins entry accepted', :'r' LIKE 'OK%', :'r');
RESET ROLE;
SELECT harness.ok('ledger amount rounded to cents', (SELECT amount FROM public.ledger WHERE player_id = :p1 AND type = 'skins') = 0.30);
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_delete_team(%L)::text$q$, :t1)) AS r \gset
SELECT harness.ok('delete team with scores gives friendly error', :'r' LIKE 'ERR P0001: This team has recorded scores%', :'r');

-- ── 5. event RSVPs ──────────────────────────────────────────────────────────
INSERT INTO public.app_events (title, event_date, capacity, location_id) VALUES ('Clinic', '2026-10-01', 1, :loc_a) RETURNING id AS ae \gset
SELECT harness.login(:u1, 'p1@a.test');
SELECT harness.try(format($q$INSERT INTO public.event_signups (event_id, player_id, location_id) VALUES (%L, %L, %L) RETURNING 'ok'$q$, :'ae', :p1, :loc_a)) AS r \gset
SELECT harness.ok('player RSVPs self', :'r' LIKE 'OK%', :'r');
SELECT harness.login(:u2, 'p2@a.test');
SELECT harness.try(format($q$INSERT INTO public.event_signups (event_id, player_id, location_id) VALUES (%L, %L, %L) RETURNING 'ok'$q$, :'ae', :p2, :loc_a)) AS r \gset
SELECT harness.ok('capacity enforced server-side', :'r' LIKE '%This event is full%', :'r');

-- ── 4. follows: followed player can remove a follower ───────────────────────
RESET ROLE;
INSERT INTO public.follows (follower_id, following_id) VALUES (:p2, :p1);
SELECT harness.login(:u1, 'p1@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$WITH d AS (DELETE FROM public.follows WHERE follower_id = %L AND following_id = %L RETURNING 1) SELECT count(*)::text FROM d$q$, :p2, :p1)) AS r \gset
SELECT harness.ok('remove follower works', :'r' = 'OK: 1', :'r');

-- ── review round 2 ──────────────────────────────────────────────────────────
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
-- a future bye week (created closed) must not block swaps
SELECT harness.try(format($q$SELECT admin_upsert_event(NULL, %L, jsonb_build_object('name','Bye','start_date','2026-11-26','status','closed','is_bye',true,'week_number',10))::text$q$, :league_a)) AS r \gset
SELECT harness.ok('future bye week created', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT admin_swap_team_member(%L, %L, %L, '2026-09-22')::text$q$, :t2, :p4, :p6)) AS r \gset
SELECT harness.ok('swap allowed despite future bye week', :'r' LIKE 'OK%', :'r');
-- published week dates are frozen
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, jsonb_build_object('name','Week 1','start_date','2026-08-25','end_date','2026-09-07','status','closed','course_id',%L,'week_number',1))::text$q$, :e1, :league_a, :course_a)) AS r \gset
SELECT harness.ok('published week date change rejected', :'r' LIKE 'ERR%', :'r');
-- direct push table writes are blocked (must use subscribe_push)
SELECT harness.login(:u1, 'p1@a.test');
SELECT harness.try(format($q$INSERT INTO public.push_subscriptions (endpoint,p256dh,auth_key,user_id,location_id) VALUES ('https://evil.example/x','k','a',%L,%L) RETURNING 'ok'$q$, :u1, :loc_a)) AS r \gset
SELECT harness.ok('direct push insert blocked', :'r' LIKE 'ERR%', :'r');
SELECT harness.try($q$UPDATE public.push_subscriptions SET endpoint = 'https://evil.example/y' RETURNING 'ok'$q$) AS r \gset
SELECT harness.ok('direct push update blocked', :'r' LIKE 'ERR%', :'r');
SELECT harness.try($q$WITH d AS (DELETE FROM public.push_subscriptions WHERE user_id = auth.uid() RETURNING 1) SELECT count(*)::text FROM d$q$) AS r \gset
SELECT harness.ok('player can still delete own push rows', :'r' LIKE 'OK%', :'r');
-- legacy unflagged sub profile is adopted, not duplicated; league player never adopted
RESET ROLE;
INSERT INTO public.players (name, first_name, last_name, handicap, location_id) VALUES ('Old Sub','Old','Sub',30,:loc_a) RETURNING id AS legacy_sub \gset
INSERT INTO public.subs (event_id, player_id, sub_first_name, sub_last_name, sub_handicap, sub_player_id, status, location_id)
  VALUES (:e1, :p2, 'Old', 'Sub', 30, :'legacy_sub', 'approved', :loc_a) RETURNING id AS legacy_req \gset
INSERT INTO public.subs (event_id, player_id, sub_first_name, sub_last_name, sub_handicap, sub_player_id, status, location_id)
  VALUES (:e1, :p2, 'Ray', 'Five', 1, :p5, 'pending', :loc_a) RETURNING id AS evil_req \gset
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT (admin_set_sub_status(%L, 'approved')->>'sub_player_id')$q$, :'legacy_req')) AS r \gset
SELECT harness.ok('legacy sub profile adopted (no duplicate)', :'r' = 'OK: ' || :'legacy_sub', :'r');
SELECT harness.try(format($q$SELECT (admin_set_sub_status(%L, 'approved')->>'sub_player_id')$q$, :'evil_req')) AS r \gset
RESET ROLE;
SELECT harness.ok('league player never adopted as sub',
  (SELECT NOT COALESCE(is_sub,false) AND handicap = 3 FROM public.players WHERE id = :p5), :'r');

RESET ROLE;
\pset tuples_only off
SELECT (CASE WHEN pass THEN 'PASS ' ELSE 'FAIL ' END) || label || COALESCE(' :: ' || info, '') AS result FROM harness.results ORDER BY n;
SELECT count(*) FILTER (WHERE pass) AS passed, count(*) FILTER (WHERE NOT pass) AS failed FROM harness.results;

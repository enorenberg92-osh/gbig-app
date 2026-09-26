-- Targeted tests for supabase/migrations/202609230002_live_rounds.sql
-- Run after 20_seed.sql on a fresh DB (e.g. DB=gbig_live).
\set ON_ERROR_STOP 0
\pset pager off
\pset footer off
\pset tuples_only on
\i 29_ids.psql
TRUNCATE harness.results;
RESET ROLE;
-- sim_ingest is service-role only; let that role use the harness helpers.
GRANT USAGE ON SCHEMA harness TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA harness TO service_role;
GRANT ALL ON harness.results TO service_role;
GRANT ALL ON SEQUENCE harness.results_n_seq TO service_role;
UPDATE public.players SET user_id = :u1 WHERE id = :p1;

-- ── setup: open week 1 on the 9-hole course ─────────────────────────────────
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, jsonb_build_object('name','Week 1','start_date','2026-09-01','end_date','2026-09-07','status','open','course_id',%L,'week_number',1))::text$q$, :e1, :league_a, :course_a)) AS r \gset
SELECT harness.ok('setup: open week 1', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT admin_upsert_event(%L, %L, jsonb_build_object('name','Week 2','start_date','2026-09-08','end_date','2026-09-14','status','draft','course_id',%L,'week_number',2))::text$q$, :e2, :league_a, :course_a)) AS r \gset

-- ── 1. realtime publication + guard ─────────────────────────────────────────
RESET ROLE;
SELECT harness.ok('live_rounds is in supabase_realtime',
  EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'live_rounds'));
-- Re-run the migration with NO publication: it must still commit (marker:
-- the dropped function comes back) and not recreate the publication.
DROP PUBLICATION supabase_realtime;
DROP FUNCTION public.sim_ingest(TEXT, JSONB);
\i /home/user/gbig-app/supabase/migrations/202609230002_live_rounds.sql
SELECT harness.ok('migration commits without a realtime publication',
  to_regprocedure('public.sim_ingest(text, jsonb)') IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'));
CREATE PUBLICATION supabase_realtime;
\i /home/user/gbig-app/supabase/migrations/202609230002_live_rounds.sql
\i /home/user/gbig-app/supabase/migrations/202609230002_live_rounds.sql
SELECT harness.ok('re-run adds table to publication once (idempotent)',
  (SELECT count(*) FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'live_rounds') = 1);

-- ── 2. record_live_hole auth rules ──────────────────────────────────────────
SELECT harness.login(:u1, 'p1@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT (record_live_hole(%L, %L, 1, 5)->>'holes_played')$q$, :e1, :p1)) AS r \gset
SELECT harness.ok('player records own hole', :'r' = 'OK: 1', :'r');
SELECT harness.try(format($q$SELECT (record_live_hole(%L, %L, 1, 4)->>'holes_played')$q$, :e1, :p2)) AS r \gset
SELECT harness.ok('player records teammate hole', :'r' = 'OK: 1', :'r');
SELECT harness.try(format($q$SELECT record_live_hole(%L, %L, 1, 4)::text$q$, :e1, :p3)) AS r \gset
SELECT harness.ok('player cannot record other team', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try(format($q$SELECT record_live_hole(%L, %L, 10, 4)::text$q$, :e1, :p1)) AS r \gset
SELECT harness.ok('hole beyond course num_holes rejected', :'r' LIKE 'ERR 22023%', :'r');
SELECT harness.try(format($q$SELECT record_live_hole(%L, %L, 0, 4)::text$q$, :e1, :p1)) AS r \gset
SELECT harness.ok('hole 0 rejected', :'r' LIKE 'ERR 22023%', :'r');
SELECT harness.try(format($q$SELECT record_live_hole(%L, %L, 2, 21)::text$q$, :e1, :p1)) AS r \gset
SELECT harness.ok('strokes 21 rejected', :'r' LIKE 'ERR 22023%', :'r');
SELECT harness.try(format($q$SELECT record_live_hole(%L, %L, 2, 0)::text$q$, :e1, :p1)) AS r \gset
SELECT harness.ok('strokes 0 rejected', :'r' LIKE 'ERR 22023%', :'r');
SELECT harness.try(format($q$SELECT (record_live_hole(%L, %L, 2, 3)->>'holes_played')$q$, :e1, :p1)) AS r \gset
SELECT harness.try(format($q$SELECT (record_live_hole(%L, %L, 2, NULL)->>'holes_played')$q$, :e1, :p1)) AS r \gset
SELECT harness.ok('NULL strokes clears a hole', :'r' = 'OK: 1', :'r');
SELECT harness.try(format($q$SELECT record_live_hole(%L, %L, 1, 4)::text$q$, :e2, :p1)) AS r \gset
SELECT harness.ok('draft (not open) week rejected', :'r' LIKE 'ERR%not open%', :'r');
SELECT harness.try(format($q$INSERT INTO public.live_rounds (location_id, event_id, player_id, hole_scores) VALUES (%L, %L, %L, '{1}') RETURNING 'x'$q$, :loc_a, :e1, :p3)) AS r \gset
SELECT harness.ok('direct insert blocked', :'r' LIKE 'ERR%', :'r');
SELECT harness.try($q$UPDATE public.live_rounds SET hole_scores = '{1,1,1,1,1,1,1,1,1}' RETURNING 'x'$q$) AS r \gset
SELECT harness.ok('direct update blocked', :'r' LIKE 'ERR%', :'r');
SELECT harness.ok('location member sees live rows', (SELECT count(*) FROM public.live_rounds) = 2);
RESET ROLE;
SELECT harness.ok('live row stores handicap + source',
  (SELECT handicap_used = 5 AND source = 'app' AND array_length(hole_scores, 1) = 9 AND hole_scores[1] = 5
     FROM public.live_rounds WHERE event_id = :e1 AND player_id = :p1));

SELECT harness.login(:u3, 'p3@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT record_live_hole(%L, %L, 3, 4)::text$q$, :e1, :p1)) AS r \gset
SELECT harness.ok('other team player cannot record for p1', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.login(:ub1, 'b1@b.test');
SELECT harness.ok('other location sees no live rows', (SELECT count(*) FROM public.live_rounds) = 0);
SELECT harness.try(format($q$SELECT record_live_hole(%L, %L, 3, 4)::text$q$, :e1, :p1)) AS r \gset
SELECT harness.ok('other location player cannot record', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.login(:admin_b, 'admin@b.test');
SELECT harness.try(format($q$SELECT record_live_hole(%L, %L, 3, 4)::text$q$, :e1, :p1)) AS r \gset
SELECT harness.ok('other location admin cannot record', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.login(:admin_a, 'admin@a.test');
SELECT harness.try(format($q$SELECT (record_live_hole(%L, %L, 1, 6)->>'holes_played')$q$, :e1, :p5)) AS r \gset
SELECT harness.ok('location admin records any rostered player', :'r' = 'OK: 1', :'r');
RESET ROLE;
SELECT harness.ok('admin live write is audited',
  EXISTS (SELECT 1 FROM public.audit_events WHERE action = 'live.admin_record_hole' AND after_data->>'player_id' = :p5));
SELECT harness.ok('teammate live writes are not audited',
  NOT EXISTS (SELECT 1 FROM public.audit_events WHERE action = 'live.admin_record_hole' AND after_data->>'player_id' = :p1));
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT record_live_hole(%L, %L, 1, 6)::text$q$, :e1, :p9)) AS r \gset
SELECT harness.ok('admin cannot record an unrostered player', :'r' LIKE 'ERR%not rostered%', :'r');
SELECT harness.try(format($q$SELECT live_record_hole_internal(%L, %L, 1, 6, 'app', NULL)::text$q$, :e1, :p1)) AS r \gset
SELECT harness.ok('internal writer not callable by clients', :'r' LIKE 'ERR 42501%', :'r');

-- ── 3. scores trigger: submit marks live rows submitted ─────────────────────
SELECT harness.login(:u1, 'p1@a.test');
SET ROLE authenticated;
DO $$
DECLARE i INT;
BEGIN
  FOR i IN 1..9 LOOP
    PERFORM public.record_live_hole((SELECT id::uuid FROM harness.ids WHERE k='e1'), (SELECT id::uuid FROM harness.ids WHERE k='p1'), i, 4);
    PERFORM public.record_live_hole((SELECT id::uuid FROM harness.ids WHERE k='e1'), (SELECT id::uuid FROM harness.ids WHERE k='p2'), i, 5);
  END LOOP;
END $$;
SELECT harness.ok('full round recorded live',
  (SELECT count(*) FROM public.live_rounds WHERE event_id = :e1 AND holes_played = 9) = 2);
SELECT harness.try(format($q$SELECT submit_scores(%L, jsonb_build_array(
  jsonb_build_object('player_id', %L, 'hole_scores', '[4,4,4,4,4,4,4,4,4]'::jsonb),
  jsonb_build_object('player_id', %L, 'hole_scores', '[5,5,5,5,5,5,5,5,5]'::jsonb)))->>'inserted'$q$, :e1, :p1, :p2)) AS r \gset
SELECT harness.ok('submit_scores unchanged', :'r' = 'OK: 2', :'r');
SELECT harness.ok('trigger flags both live rows submitted',
  (SELECT count(*) FROM public.live_rounds WHERE event_id = :e1 AND submitted AND player_id IN (:p1, :p2)) = 2);
SELECT harness.try(format($q$SELECT (record_live_hole(%L, %L, 1, 9)->>'submitted')$q$, :e1, :p1)) AS r \gset
RESET ROLE;
SELECT harness.ok('record_live_hole ignores submitted rows',
  :'r' = 'OK: true' AND (SELECT hole_scores[1] FROM public.live_rounds WHERE event_id = :e1 AND player_id = :p1) = 4, :'r');
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_review_score((SELECT id FROM scores WHERE event_id=%L AND player_id=%L), 'rejected')->>'status'$q$, :e1, :p1)) AS r \gset
RESET ROLE;
SELECT harness.ok('rejection reopens the live card',
  (SELECT NOT submitted FROM public.live_rounds WHERE event_id = :e1 AND player_id = :p1), :'r');
SELECT harness.ok('teammate card stays submitted',
  (SELECT submitted FROM public.live_rounds WHERE event_id = :e1 AND player_id = :p2));
DELETE FROM public.scores WHERE event_id = :e1 AND player_id = :p2;
SELECT harness.ok('deleting the score reopens the live card',
  (SELECT NOT submitted FROM public.live_rounds WHERE event_id = :e1 AND player_id = :p2));
INSERT INTO public.scores (event_id, player_id, team_id, hole_scores, gross_total, net_total, handicap_used, entry_type, status, location_id)
VALUES (:e1, :p2, :t1, '{5,5,5,5,5,5,5,5,5}', 45, 33, 12, 'played', 'verified', :loc_a);
SELECT harness.ok('admin-entered played score flags live row',
  (SELECT submitted FROM public.live_rounds WHERE event_id = :e1 AND player_id = :p2));

-- ── 4. API keys ─────────────────────────────────────────────────────────────
SELECT harness.login(:u1, 'p1@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_create_location_api_key(%L)::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('player cannot create API key', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.login(:admin_b, 'admin@b.test');
SELECT harness.try(format($q$SELECT admin_create_location_api_key(%L)::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('other location admin cannot create key', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.login(:admin_a, 'admin@a.test');
SELECT admin_create_location_api_key(:loc_a, 'sim', 'Bay PCs')->>'key' AS key1 \gset
SELECT harness.ok('admin creates sim key', :'key1' LIKE 'gbig_sim_%' AND length(:'key1') = 73, :'key1');
SELECT encode(sha256(convert_to(:'key1', 'UTF8')), 'hex') AS hash1 \gset
SELECT harness.try($q$SELECT key_hash FROM public.location_api_keys LIMIT 1$q$) AS r \gset
SELECT harness.ok('key_hash column not readable by clients', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.ok('admin can list key metadata', (SELECT count(*) FROM public.location_api_keys WHERE revoked_at IS NULL) = 1);
RESET ROLE;
SELECT harness.ok('only the SHA-256 hash is stored',
  (SELECT key_hash FROM public.location_api_keys WHERE revoked_at IS NULL) = :'hash1'
  AND NOT EXISTS (SELECT 1 FROM public.location_api_keys WHERE key_hash = :'key1'));

-- ── 5. sim_ingest ───────────────────────────────────────────────────────────
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT sim_ingest(%L, '{"player_email":"p3@a.test","hole":1,"strokes":4}')::text$q$, :'hash1')) AS r \gset
SELECT harness.ok('sim_ingest not callable by authenticated', :'r' LIKE 'ERR 42501%', :'r');
RESET ROLE;
SELECT harness.logout();
SET ROLE service_role;
SELECT harness.try($q$SELECT sim_ingest(repeat('0', 64), '{"player_email":"p3@a.test","hole":1,"strokes":4}')::text$q$) AS r \gset
SELECT harness.ok('bad key -> 28000', :'r' LIKE 'ERR 28000%', :'r');
SELECT harness.try(format($q$SELECT (sim_ingest(%L, '{"player_email":"P3@a.test","hole":1,"strokes":4,"bay":"3"}')->'live'->>'holes_played')$q$, :'hash1')) AS r \gset
SELECT harness.ok('sim records by email (case-insensitive)', :'r' = 'OK: 1', :'r');
SELECT harness.try(format($q$SELECT sim_ingest(%L, jsonb_build_object('player_id', %L, 'hole', 1, 'strokes', 4))::text$q$, :'hash1', :pb1)) AS r \gset
SELECT harness.ok('sim cannot reach another location''s player', :'r' LIKE 'ERR 22023%Player not found%', :'r');
SELECT harness.try(format($q$SELECT sim_ingest(%L, jsonb_build_object('player_id', %L, 'hole', 1, 'strokes', 4))::text$q$, :'hash1', :p9)) AS r \gset
SELECT harness.ok('sim rejects unrostered player', :'r' LIKE 'ERR 22023%', :'r');
SELECT harness.try(format($q$SELECT sim_ingest(%L, jsonb_build_object('player_id', %L, 'hole', 12, 'strokes', 4))::text$q$, :'hash1', :p3)) AS r \gset
SELECT harness.ok('sim hole out of range -> 22023', :'r' LIKE 'ERR 22023%', :'r');
SELECT harness.try(format($q$SELECT sim_ingest(%L, jsonb_build_object('player_id', %L))::text$q$, :'hash1', :p3)) AS r \gset
SELECT harness.ok('sim with nothing to do -> 22023', :'r' LIKE 'ERR 22023%', :'r');
SELECT harness.try(format($q$SELECT (sim_ingest(%L, jsonb_build_object('player_id', %L, 'finalize', true))->'finalize'->>'reason')$q$, :'hash1', :p3)) AS r \gset
SELECT harness.ok('finalize with missing holes waits', :'r' = 'OK: incomplete', :'r');
SELECT harness.try(format($q$SELECT (sim_ingest(%L, jsonb_build_object('player_id', %L,
  'holes', '[{"hole":2,"strokes":3},{"hole":3,"strokes":4},{"hole":4,"strokes":5},{"hole":5,"strokes":4},{"hole":6,"strokes":3},{"hole":7,"strokes":4},{"hole":8,"strokes":4},{"hole":9,"strokes":5}]'::jsonb))->'live'->>'holes_played')$q$, :'hash1', :p3)) AS r \gset
SELECT harness.ok('sim catch-up batch', :'r' = 'OK: 9', :'r');
SELECT harness.try(format($q$SELECT (sim_ingest(%L, jsonb_build_object('player_id', %L,
  'holes', '[{"hole":1,"strokes":5},{"hole":2,"strokes":4},{"hole":3,"strokes":5},{"hole":4,"strokes":6},{"hole":5,"strokes":5},{"hole":6,"strokes":4},{"hole":7,"strokes":5},{"hole":8,"strokes":5},{"hole":9,"strokes":6}]'::jsonb,
  'finalize', true))->'finalize'->>'inserted')$q$, :'hash1', :p4)) AS r \gset
SELECT harness.ok('last hole + finalize creates the team submission', :'r' = 'OK: 2', :'r');
RESET ROLE;
SELECT harness.ok('sim submission rows are verified (no review) with server totals',
  (SELECT count(*) FROM public.scores WHERE event_id = :e1 AND team_id = :t2 AND status = 'verified'
      AND entry_type = 'played' AND gross_total = 36 AND net_total = 36 - handicap_used AND player_id = :p3) = 1
  AND (SELECT gross_total FROM public.scores WHERE event_id = :e1 AND player_id = :p4) = 45);
SELECT harness.ok('sim round updates handicaps immediately',
  EXISTS (SELECT 1 FROM public.handicap_history WHERE player_id IN (:p3, :p4)));
SELECT harness.ok('sim live rows flagged submitted, source=sim, bay kept',
  (SELECT bool_and(submitted AND source = 'sim') FROM public.live_rounds WHERE event_id = :e1 AND team_id = :t2)
  AND (SELECT bay FROM public.live_rounds WHERE event_id = :e1 AND player_id = :p3) = '3');
SELECT harness.ok('sim submission audited',
  EXISTS (SELECT 1 FROM public.audit_events WHERE action = 'score.submit' AND after_data->>'source' = 'sim'));
SELECT harness.ok('key last_used_at stamped', (SELECT last_used_at IS NOT NULL FROM public.location_api_keys WHERE key_hash = :'hash1'));
SET ROLE service_role;
SELECT harness.try(format($q$SELECT (sim_ingest(%L, jsonb_build_object('player_id', %L, 'finalize', true))->'finalize'->>'already_submitted')$q$, :'hash1', :p3)) AS r \gset
SELECT harness.ok('second finalize is a no-op', :'r' = 'OK: true', :'r');
SELECT harness.try(format($q$SELECT sim_ingest(%L, jsonb_build_object('player_id', %L, 'hole', 1, 'strokes', 4, 'event_id', %L))::text$q$, :'hash1', :p5, :e2)) AS r \gset
SELECT harness.ok('sim event_id must be open', :'r' LIKE 'ERR 22023%', :'r');
RESET ROLE;

-- rotate + revoke
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT admin_create_location_api_key(:loc_a)->>'key' AS key2 \gset
SELECT encode(sha256(convert_to(:'key2', 'UTF8')), 'hex') AS hash2 \gset
RESET ROLE;
SET ROLE service_role;
SELECT harness.try(format($q$SELECT sim_ingest(%L, jsonb_build_object('player_id', %L, 'hole', 2, 'strokes', 4))::text$q$, :'hash1', :p5)) AS r \gset
SELECT harness.ok('rotated-out key rejected', :'r' LIKE 'ERR 28000%', :'r');
SELECT harness.try(format($q$SELECT (sim_ingest(%L, jsonb_build_object('player_id', %L, 'hole', 2, 'strokes', 4))->'live'->>'holes_played')$q$, :'hash2', :p5)) AS r \gset
SELECT harness.ok('new key works', :'r' = 'OK: 2', :'r');
RESET ROLE;
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_revoke_location_api_key((SELECT id FROM public.location_api_keys WHERE revoked_at IS NULL))::text$q$)) AS r \gset
SELECT harness.ok('admin revokes key', :'r' = 'OK: true', :'r');
RESET ROLE;
SET ROLE service_role;
SELECT harness.try(format($q$SELECT sim_ingest(%L, jsonb_build_object('player_id', %L, 'hole', 3, 'strokes', 4))::text$q$, :'hash2', :p5)) AS r \gset
SELECT harness.ok('revoked key rejected', :'r' LIKE 'ERR 28000%', :'r');
RESET ROLE;

-- publish closes the week: live writes stop
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_bulk_approve_scores(%L)::text$q$, :e1)) AS r \gset
SELECT harness.try(format($q$SELECT publish_week(%L)::text$q$, :e1)) AS r \gset
SELECT harness.ok('publish still works with live rows present', :'r' LIKE 'OK%', :'r');
SELECT harness.try(format($q$SELECT record_live_hole(%L, %L, 2, 4)::text$q$, :e1, :p5)) AS r \gset
SELECT harness.ok('closed week rejects live writes', :'r' LIKE 'ERR%not open%', :'r');

RESET ROLE;
\pset tuples_only off
SELECT (CASE WHEN pass THEN 'PASS ' ELSE 'FAIL ' END) || label || COALESCE(' :: ' || info, '') AS result FROM harness.results ORDER BY n;
SELECT count(*) FILTER (WHERE pass) AS passed, count(*) FILTER (WHERE NOT pass) AS failed FROM harness.results;

-- Tests for supabase/migrations/202609230005_signup_intake.sql
-- Run after 20_seed.sql on a fresh DB (DB=gbig_sign).
\set ON_ERROR_STOP 0
\pset pager off
\pset footer off
\pset tuples_only on
\i 29_ids.psql
TRUNCATE harness.results;

-- Build a parsed payload like mapSignupPayload() does.
RESET ROLE;
CREATE OR REPLACE FUNCTION harness.signup(n1 TEXT, e1 TEXT, h1 NUMERIC, n2 TEXT, e2 TEXT, h2 NUMERIC, team TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'p1', jsonb_build_object('fullName', n1, 'email', e1, 'handicap', h1, 'phone', '555'),
    'p2', jsonb_build_object('fullName', COALESCE(n2, ''), 'email', COALESCE(e2, ''), 'handicap', h2),
    'teamName', COALESCE(team, ''), 'day', 'Tue', 'time', '6pm'
  );
$$;
GRANT USAGE ON SCHEMA harness TO service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA harness TO service_role, authenticated;
GRANT ALL ON harness.results TO service_role;
GRANT ALL ON SEQUENCE harness.results_n_seq TO service_role;

-- ── key management ──────────────────────────────────────────────────────────
SELECT harness.login(:u1, 'p1@a.test');
SET ROLE authenticated;
SELECT harness.try(format('SELECT admin_rotate_signup_key(%L)', :loc_a)) AS r \gset
SELECT harness.ok('player cannot generate a key', :'r' LIKE 'ERR%', :'r');
SELECT harness.login(:admin_b, 'admin@b.test');
SELECT harness.try(format('SELECT admin_rotate_signup_key(%L)', :loc_a)) AS r \gset
SELECT harness.ok('other location admin cannot generate a key', :'r' LIKE 'ERR%', :'r');
SELECT harness.login(:admin_a, 'admin@a.test');
SELECT admin_rotate_signup_key(:loc_a) AS old_key \gset
SELECT admin_rotate_signup_key(:loc_a) AS key \gset
SELECT encode(sha256(convert_to(:'old_key', 'UTF8')), 'hex') AS old_hash, encode(sha256(convert_to(:'key', 'UTF8')), 'hex') AS hash \gset
SELECT harness.ok('key looks random and prefixed', :'key' ~ '^gbsk_[0-9a-f]{64}$' AND :'key' <> :'old_key', :'key');
SELECT harness.ok('admin sees key prefix', (SELECT key_prefix FROM location_integration_keys WHERE location_id = :loc_a) = left(:'key', 9));
SELECT harness.try('SELECT key_hash FROM location_integration_keys LIMIT 1') AS r \gset
SELECT harness.ok('admin cannot read key hash', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try(format($q$UPDATE location_integration_keys SET key_prefix = 'x' WHERE location_id = %L RETURNING 1$q$, :loc_a)) AS r \gset
SELECT harness.ok('admin cannot write keys directly', :'r' LIKE 'ERR%', :'r');
RESET ROLE;
SELECT harness.ok('only the digest is stored', (SELECT key_hash FROM location_integration_keys WHERE location_id = :loc_a) = :'hash'
  AND NOT EXISTS (SELECT 1 FROM location_integration_keys WHERE key_hash = :'key' OR key_prefix = :'key'));
SELECT harness.ok('key rotation audited without the key',
  (SELECT count(*) FROM audit_events WHERE action IN ('integration.key_create', 'integration.key_rotate') AND location_id = :loc_a) = 2
  AND NOT EXISTS (SELECT 1 FROM audit_events WHERE after_data::text LIKE '%' || :'key' || '%'));

-- ── privileges ──────────────────────────────────────────────────────────────
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT signup_webhook_ingest(%L, '{}', '{}')::text$q$, :'hash')) AS r \gset
SELECT harness.ok('authenticated cannot call ingest', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try(format($q$SELECT process_signup_submission(%L)::text$q$, :loc_a)) AS r \gset
SELECT harness.ok('authenticated cannot call process', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try(format($q$SELECT signup_create_team(%L, 'x', %L, %L, NULL)::text$q$, :league_a, :p9, :p1)) AS r \gset
SELECT harness.ok('authenticated cannot call internal team helper', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.logout();
SET ROLE anon;
SELECT harness.try(format($q$SELECT signup_webhook_ingest(%L, '{}', '{}')::text$q$, :'hash')) AS r \gset
SELECT harness.ok('anon cannot call ingest', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try('SELECT count(*)::text FROM signup_submissions') AS r \gset
SELECT harness.ok('anon cannot read submissions', :'r' LIKE 'ERR 42501%', :'r');

-- ── webhook ingest (service role) ───────────────────────────────────────────
RESET ROLE;
SET ROLE service_role;
SELECT signup_webhook_ingest(:'old_hash', '{}', '{}')::text AS r \gset
SELECT harness.ok('rotated-out key rejected', (:'r'::jsonb->>'error') = 'invalid_key', :'r');
SELECT signup_webhook_ingest(repeat('0', 64), '{}', '{}')::text AS r \gset
SELECT harness.ok('unknown key rejected', (:'r'::jsonb->>'error') = 'invalid_key', :'r');

-- 1. brand-new pair → imported
SELECT signup_webhook_ingest(:'hash', '{"p1_name":"Nia New"}',
  harness.signup('Nia  New', 'Nia@New.test', 12.6, 'Oli Other', 'oli@new.test', 40))::text AS r \gset
SELECT harness.ok('new pair imported', (:'r'::jsonb->>'status') = 'imported' AND (:'r'::jsonb->>'ok')::boolean, :'r');
SELECT (:'r'::jsonb->>'id') AS s1, (:'r'::jsonb->>'team_id') AS s1_team \gset
RESET ROLE;
SELECT harness.ok('players created with rounded/clamped handicaps and lower-case email',
  (SELECT count(*) FROM players WHERE location_id = :loc_a AND
     ((name = 'Nia New' AND first_name = 'Nia' AND last_name = 'New' AND email = 'nia@new.test' AND handicap = 13)
   OR (name = 'Oli Other' AND email = 'oli@new.test' AND handicap = 27))) = 2);
SELECT harness.ok('team named Last/Last in working league with two active memberships',
  (SELECT name = 'New/Other' AND league_id = :league_a AND location_id = :loc_a FROM teams WHERE id = :'s1_team')
  AND (SELECT count(*) FROM team_memberships WHERE team_id = :'s1_team' AND effective_to IS NULL AND league_id = :league_a) = 2
  AND (SELECT count(*) FROM players WHERE team_id = :'s1_team') = 2);
SELECT harness.ok('submission records players/team',
  (SELECT cardinality(player_ids) = 2 AND cardinality(created_player_ids) = 2 AND team_id = :'s1_team'
          AND league_id = :league_a AND email_key = 'nia@new.test,oli@new.test' AND error_text IS NULL
     FROM signup_submissions WHERE id = :'s1'));
SELECT harness.ok('signup team creation audited with source',
  EXISTS (SELECT 1 FROM audit_events WHERE action = 'roster.team_create' AND entity_id = :'s1_team'
                                       AND after_data->>'source' = 'signup')
  AND (SELECT count(*) FROM audit_events WHERE action = 'player.create' AND after_data->>'signup_id' = :'s1') = 2);

-- 2. same emails again (other order, other case) within 24h → duplicate
SET ROLE service_role;
SELECT signup_webhook_ingest(:'hash', '{}',
  harness.signup('Oli Other', 'OLI@new.test', 5, 'Nia New', 'nia@new.test', 5))::text AS r \gset
SELECT harness.ok('repeat submission marked duplicate', (:'r'::jsonb->>'status') = 'duplicate', :'r');
SELECT (:'r'::jsonb->>'id') AS s_dup \gset
RESET ROLE;
SELECT harness.ok('duplicate created nothing and points at original',
  (SELECT count(*) FROM players WHERE lower(email) IN ('nia@new.test', 'oli@new.test')) = 2
  AND (SELECT duplicate_of = :'s1' AND error_text LIKE 'Same email%' FROM signup_submissions WHERE id = :'s_dup'));

-- 3. returning player already on an active team → needs_review, not duplicated
SET ROLE service_role;
SELECT signup_webhook_ingest(:'hash', '{}',
  harness.signup('Pat One', 'P1@A.test', 5, 'Zed Fresh', 'zed@new.test', 9))::text AS r \gset
SELECT harness.ok('player on active team → needs_review', (:'r'::jsonb->>'status') = 'needs_review'
  AND (:'r'::jsonb->>'reason') LIKE 'Pat One is already on Team 1%', :'r');
SELECT (:'r'::jsonb->>'id') AS s_busy \gset
RESET ROLE;
SELECT harness.ok('existing player reused by email, not re-created',
  (SELECT count(*) FROM players WHERE lower(email) = 'p1@a.test') = 1
  AND (SELECT player_ids[1] = :p1 AND cardinality(created_player_ids) = 1 FROM signup_submissions WHERE id = :'s_busy'));

-- 4. single player → needs_review, player kept; later pair reuses them
SET ROLE service_role;
SELECT signup_webhook_ingest(:'hash', '{}', harness.signup('Solo Sam', 'solo@new.test', -5, NULL, NULL, NULL))::text AS r \gset
SELECT harness.ok('single player → needs_review', (:'r'::jsonb->>'status') = 'needs_review'
  AND (:'r'::jsonb->>'reason') LIKE 'Only one player%', :'r');
SELECT signup_webhook_ingest(:'hash', '{}',
  harness.signup('Solo Sam', 'solo@new.test', 3, 'Pal Partner', 'pal@new.test', 7, 'Birdie Hunters'))::text AS r \gset
SELECT harness.ok('returning (teamless) player paired → imported with given team name',
  (:'r'::jsonb->>'status') = 'imported' AND (:'r'::jsonb->>'team_name') = 'Birdie Hunters', :'r');
RESET ROLE;
SELECT harness.ok('solo player reused (one row, handicap from first sign-up clamped to -2)',
  (SELECT count(*) FROM players WHERE email = 'solo@new.test') = 1
  AND (SELECT handicap FROM players WHERE email = 'solo@new.test') = -2);

-- 5. bad mapping / same email twice
SET ROLE service_role;
SELECT signup_webhook_ingest(:'hash', '{"foo":"bar"}', '{"p1":{"fullName":""},"p2":{}}')::text AS r \gset
SELECT harness.ok('no name → needs_review with mapping hint', (:'r'::jsonb->>'status') = 'needs_review'
  AND (:'r'::jsonb->>'reason') LIKE 'No player name%', :'r');
SELECT signup_webhook_ingest(:'hash', '{}', harness.signup('Twin A', 'twin@new.test', 1, 'Twin B', 'TWIN@new.test', 2))::text AS r \gset
SELECT harness.ok('same email twice → needs_review', (:'r'::jsonb->>'reason') LIKE 'Both players resolve%', :'r');
SELECT signup_webhook_ingest(:'hash', '{}', '"not an object"')::text AS r \gset
SELECT harness.ok('non-object parsed payload handled', (:'r'::jsonb->>'status') = 'needs_review', :'r');
SELECT signup_webhook_ingest(:'hash', jsonb_build_object('blob', repeat(md5(random()::text), 5000)), '{}')::text AS r \gset
SELECT harness.ok('oversized raw payload rejected', (:'r'::jsonb->>'error') = 'too_large', :'r');

-- 6. no working league → needs_review; admin retry after fixing → imported, player reused
RESET ROLE;
UPDATE league_config SET is_working = false WHERE id = :league_a;
SET ROLE service_role;
SELECT signup_webhook_ingest(:'hash', '{}', harness.signup('Quin Q', NULL, 4, 'Rae R', 'rae@new.test', 6))::text AS r \gset
SELECT harness.ok('no working league → needs_review', (:'r'::jsonb->>'reason') LIKE 'No working league%', :'r');
SELECT (:'r'::jsonb->>'id') AS s_nol \gset
RESET ROLE;
UPDATE league_config SET is_working = true WHERE id = :league_a;

SELECT harness.login(:admin_b, 'admin@b.test');
SET ROLE authenticated;
SELECT harness.try(format('SELECT admin_retry_signup(%L)::text', :'s_nol')) AS r \gset
SELECT harness.ok('other location admin cannot retry', :'r' LIKE 'ERR%', :'r');
SELECT harness.ok('other location admin sees no loc A sign-ups',
  (SELECT count(*) FROM signup_submissions WHERE location_id = :loc_a) = 0);
SELECT harness.login(:u1, 'p1@a.test');
SELECT harness.ok('player sees no sign-ups', (SELECT count(*) FROM signup_submissions) = 0);
SELECT harness.try(format('SELECT admin_dismiss_signup(%L)::text', :'s_nol')) AS r \gset
SELECT harness.ok('player cannot dismiss', :'r' LIKE 'ERR%', :'r');

SELECT harness.login(:admin_a, 'admin@a.test');
SELECT harness.ok('admin reads own location inbox',
  (SELECT count(*) FROM signup_submissions WHERE location_id = :loc_a) = 9);
SELECT harness.try(format($q$UPDATE signup_submissions SET status = 'imported' WHERE id = %L RETURNING 1$q$, :'s_nol')) AS r \gset
SELECT harness.ok('admin cannot update submissions directly', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try(format($q$INSERT INTO signup_submissions (location_id) VALUES (%L) RETURNING 1$q$, :loc_a)) AS r \gset
SELECT harness.ok('admin cannot insert submissions directly', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try(format('SELECT admin_retry_signup(%L)::text', :'s_nol')) AS r \gset
SELECT harness.ok('admin retry imports once league is set', :'r' LIKE 'OK:%"status": "imported"%', :'r');
RESET ROLE;
SELECT harness.ok('retry reused the email-less player created on the first attempt',
  (SELECT count(*) FROM players WHERE name = 'Quin Q') = 1
  AND (SELECT cardinality(created_player_ids) = 2 AND error_text IS NULL FROM signup_submissions WHERE id = :'s_nol'));
SELECT harness.ok('retry audited', EXISTS (SELECT 1 FROM audit_events WHERE action = 'signup.retry' AND entity_id = :'s_nol'));

SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format('SELECT admin_retry_signup(%L)::text', :'s_nol')) AS r \gset
SELECT harness.ok('cannot retry an imported sign-up', :'r' LIKE 'ERR%already imported%', :'r');
SELECT harness.try(format('SELECT admin_dismiss_signup(%L)::text', :'s1')) AS r \gset
SELECT harness.ok('cannot dismiss an imported sign-up', :'r' LIKE 'ERR%', :'r');
-- Retry of the duplicate ("import anyway") → both already on New/Other now.
SELECT harness.try(format('SELECT admin_retry_signup(%L)::text', :'s_dup')) AS r \gset
SELECT harness.ok('duplicate retry → needs_review, already on team', :'r' LIKE '%already on New/Other%', :'r');
SELECT harness.try(format('SELECT admin_dismiss_signup(%L)::text', :'s_busy')) AS r \gset
SELECT harness.ok('admin dismisses', :'r' LIKE 'OK:%"status": "dismissed"%', :'r');

-- 7. a dismissed entry doesn't make a resubmission a duplicate
SET ROLE service_role;
SELECT signup_webhook_ingest(:'hash', '{}',
  harness.signup('Pat One', 'p1@a.test', 5, 'Zed Fresh', 'zed@new.test', 9))::text AS r \gset
SELECT harness.ok('resubmission after dismiss is processed, not duplicate', (:'r'::jsonb->>'status') = 'needs_review', :'r');

-- 8. returning player with a closed stint in the league starts after it ends
RESET ROLE;
SELECT set_config('app.roster_write', 'on', false);
UPDATE team_memberships SET effective_to = DATE '2026-09-10'
 WHERE player_id = :p9 AND league_id = :league_a AND effective_to IS NULL;
-- p9 has no stint; give it one so the overlap guard matters.
INSERT INTO team_memberships (location_id, league_id, player_id, team_id, effective_from, effective_to)
  VALUES (:loc_a, :league_a, :p9, :t1, (SELECT start_date FROM league_config WHERE id = :league_a), DATE '2026-09-10');
UPDATE players SET email = 'cy@new.test' WHERE id = :p9;
SELECT set_config('app.roster_write', '', false);
SET ROLE service_role;
SELECT signup_webhook_ingest(:'hash', '{}', harness.signup('Cy Nine', 'cy@new.test', 7, 'Dee Late', 'dee@new.test', 7))::text AS r \gset
SELECT harness.ok('returning player with closed stint imported', (:'r'::jsonb->>'status') = 'imported', :'r');
RESET ROLE;
SELECT harness.ok('new stint starts the day after the old one',
  (SELECT effective_from FROM team_memberships WHERE player_id = :p9 AND effective_to IS NULL) = DATE '2026-09-11');

-- 9. rate limit: 30 per location per hour
RESET ROLE;
INSERT INTO signup_submissions (location_id, status, created_at)
SELECT :loc_a, 'dismissed', now() - INTERVAL '5 minutes'
  FROM generate_series(1, 30 - (SELECT count(*) FROM signup_submissions WHERE location_id = :loc_a AND created_at > now() - INTERVAL '1 hour'));
SET ROLE service_role;
SELECT signup_webhook_ingest(:'hash', '{}', harness.signup('Late Larry', 'larry@new.test', 1, 'Late Lou', 'lou@new.test', 2))::text AS r \gset
SELECT harness.ok('31st submission in an hour rate-limited', (:'r'::jsonb->>'error') = 'rate_limited', :'r');
RESET ROLE;
SELECT harness.ok('rate-limited submission not stored', NOT EXISTS (SELECT 1 FROM signup_submissions WHERE email_key LIKE '%larry%'));

-- 10. revoke
SELECT harness.login(:admin_a, 'admin@a.test');
SET ROLE authenticated;
SELECT harness.try(format('SELECT admin_revoke_signup_key(%L)::text', :loc_a)) AS r \gset
SELECT harness.ok('admin revokes key', :'r' = 'OK: true', :'r');
RESET ROLE;
SET ROLE service_role;
SELECT signup_webhook_ingest(:'hash', '{}', '{}')::text AS r \gset
SELECT harness.ok('revoked key rejected', (:'r'::jsonb->>'error') = 'invalid_key', :'r');

RESET ROLE;
SELECT (CASE WHEN pass THEN 'PASS ' ELSE 'FAIL ' END) || label || COALESCE(' :: ' || info, '') AS result FROM harness.results ORDER BY n;
SELECT count(*) FILTER (WHERE pass) AS passed, count(*) FILTER (WHERE NOT pass) AS failed FROM harness.results;

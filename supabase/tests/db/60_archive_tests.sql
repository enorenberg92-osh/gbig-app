-- Tests for supabase/migrations/202609230004_season_archive.sql
-- (league_config.archived_at + admin_set_league_archived). Run after 20_seed.sql.
\set ON_ERROR_STOP 0
\pset pager off
\pset footer off
\pset tuples_only on
\ir 29_ids.psql
TRUNCATE harness.results;

-- ── setup: a past season at location A with one closed week ─────────────────
SELECT harness.login(:admin_a, 'admin@a.test') \g /dev/null
SET ROLE authenticated;
INSERT INTO public.league_config (name, num_weeks, start_date, is_active, is_working, location_id)
VALUES ('Spring 2026', 8, '2026-03-01', false, false, :loc_a) RETURNING id AS spring \gset
\set spring '''':spring''''
RESET ROLE;
INSERT INTO public.events (name, week_number, start_date, end_date, status, league_id, location_id, course_id)
VALUES ('Week 1', 1, '2026-03-01', '2026-03-07', 'closed', :spring, :loc_a, :course_a) RETURNING id AS spring_e1 \gset
\set spring_e1 '''':spring_e1''''

-- ── 1. admin archive / un-archive ────────────────────────────────────────────
SELECT harness.login(:admin_a, 'admin@a.test') \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_set_league_archived(%L, true)::text$q$, :league_a)) AS r \gset
SELECT harness.ok('cannot archive the working league', :'r' LIKE 'ERR%working league%', :'r');
SELECT harness.try(format($q$SELECT admin_set_league_archived(%L, true)::text$q$, :spring)) AS r \gset
SELECT harness.ok('admin archives a past season', :'r' LIKE 'OK: 2%', :'r');
SELECT archived_at::text AS first_archived FROM public.league_config WHERE id = :spring \gset
SELECT harness.try(format($q$SELECT admin_set_league_archived(%L, true)::text$q$, :spring)) AS r \gset
SELECT harness.ok('re-archiving keeps the original timestamp',
  (SELECT archived_at::text FROM public.league_config WHERE id = :spring) = :'first_archived', :'r');
SELECT harness.try(format($q$SELECT admin_set_league_archived(%L, NULL)::text$q$, :spring)) AS r \gset
SELECT harness.ok('null archived flag rejected', :'r' LIKE 'ERR%', :'r');
RESET ROLE;

-- ── 2. an archived season can never be the working league ───────────────────
UPDATE public.league_config SET is_working = false WHERE id = :league_a;
SELECT harness.login(:admin_a, 'admin@a.test') \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$WITH u AS (UPDATE public.league_config SET is_working = true WHERE id = %L RETURNING 1) SELECT count(*)::text FROM u$q$, :spring)) AS r \gset
SELECT harness.ok('archived season cannot be loaded as working league', :'r' LIKE 'ERR 23514%', :'r');
RESET ROLE;
UPDATE public.league_config SET is_working = true WHERE id = :league_a;

-- ── 3. permissions ──────────────────────────────────────────────────────────
SELECT harness.login(:u1, 'p1@a.test') \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_set_league_archived(%L, false)::text$q$, :spring)) AS r \gset
SELECT harness.ok('player cannot un-archive', :'r' LIKE 'ERR 42501%', :'r');
SELECT harness.try(format($q$WITH u AS (UPDATE public.league_config SET archived_at = NULL WHERE id = %L RETURNING 1) SELECT count(*)::text FROM u$q$, :spring)) AS r \gset
SELECT harness.ok('player cannot clear archived_at directly', :'r' = 'OK: 0', :'r');
-- Players browse every season at their own location (standings picker, career stats).
SELECT harness.ok('player reads archived + current seasons at own location',
  (SELECT count(*) FROM public.league_config WHERE location_id = :loc_a AND (archived_at IS NOT NULL OR is_working)) = 2, NULL);
SELECT harness.ok('player reads archived season events',
  (SELECT count(*) FROM public.events WHERE league_id = :spring) = 1, NULL);
RESET ROLE;
SELECT harness.login(:ub1, 'b1@b.test') \g /dev/null
SET ROLE authenticated;
SELECT harness.ok('other location cannot see the seasons',
  (SELECT count(*) FROM public.league_config WHERE location_id = :loc_a) = 0, NULL);
RESET ROLE;
SELECT harness.login(:admin_b, 'admin@b.test') \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT admin_set_league_archived(%L, false)::text$q$, :spring)) AS r \gset
SELECT harness.ok('other location admin cannot un-archive', :'r' LIKE 'ERR 42501%', :'r');
RESET ROLE;
SELECT harness.logout() \g /dev/null
SET ROLE anon;
SELECT harness.try(format($q$SELECT admin_set_league_archived(%L, false)::text$q$, :spring)) AS r \gset
SELECT harness.ok('anon cannot call admin_set_league_archived', :'r' LIKE 'ERR 42501%', :'r');
RESET ROLE;

-- ── 4. un-archive + audit trail ─────────────────────────────────────────────
SELECT harness.login(:admin_a, 'admin@a.test') \g /dev/null
SET ROLE authenticated;
SELECT harness.try(format($q$SELECT COALESCE(admin_set_league_archived(%L, false)::text, 'null')$q$, :spring)) AS r \gset
SELECT harness.ok('admin un-archives', :'r' = 'OK: null'
  AND (SELECT archived_at IS NULL FROM public.league_config WHERE id = :spring), :'r');
RESET ROLE;
SELECT harness.ok('archive + unarchive audited once each (no-op re-archive not logged)',
  (SELECT count(*) FILTER (WHERE action = 'league.archive') = 1 AND count(*) FILTER (WHERE action = 'league.unarchive') = 1
     FROM public.audit_events WHERE entity = 'league_config' AND entity_id = :spring),
  (SELECT string_agg(action, ',') FROM public.audit_events WHERE entity_id = :spring));
UPDATE public.league_config SET is_working = false WHERE id = :league_a;
SELECT harness.try(format($q$WITH u AS (UPDATE public.league_config SET is_working = true WHERE id = %L RETURNING 1) SELECT count(*)::text FROM u$q$, :spring)) AS r \gset
SELECT harness.ok('un-archived season can be loaded as working league', :'r' = 'OK: 1', :'r');
UPDATE public.league_config SET is_working = false WHERE id = :spring;
UPDATE public.league_config SET is_working = true WHERE id = :league_a;

\pset tuples_only off
SELECT (CASE WHEN pass THEN 'PASS ' ELSE 'FAIL ' END) || label || COALESCE(' :: ' || info, '') AS result FROM harness.results ORDER BY n;
SELECT count(*) FILTER (WHERE pass) AS passed, count(*) FILTER (WHERE NOT pass) AS failed FROM harness.results;

-- Optional: legacy-shaped production-like data inserted BEFORE any repo
-- migration, so the backfill / reconciliation / gate code paths actually run.
-- Enabled by LEGACY=1 ./run_migrations.sh
INSERT INTO auth.users (id, email) VALUES
  ('11111111-0000-0000-0000-000000000001', 'oldadmin@gbig.test'),
  ('11111111-0000-0000-0000-0000000000a1', 'l1@gbig.test');
INSERT INTO public.admins (user_id, email, role) VALUES ('11111111-0000-0000-0000-000000000001', 'oldadmin@gbig.test', 'owner');
INSERT INTO public.leagues (id, name) VALUES ('22222222-0000-0000-0000-000000000001', 'Old League');
INSERT INTO public.league_config (id, name, num_weeks, start_date, is_active, is_working)
VALUES ('33333333-0000-0000-0000-000000000001', 'Spring 2026', 10, '2026-04-01', true, true);
-- course with only legacy pars int[] (hole_pars NULL, total_par NULL)
INSERT INTO public.courses (id, name, num_holes, pars) VALUES
  ('44444444-0000-0000-0000-000000000001', 'Legacy 9', 9, '{4,3,4,5,4,3,4,4,5}');
INSERT INTO public.players (id, name, email, handicap, user_id, league_id) VALUES
  ('55555555-0000-0000-0000-000000000001', 'L One',   'l1@gbig.test', 7.4, '11111111-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-000000000001'),
  ('55555555-0000-0000-0000-000000000002', 'L Two',   'l2@gbig.test', 12.6, NULL, NULL),
  ('55555555-0000-0000-0000-000000000003', 'L Three', 'l3@gbig.test', 3, NULL, NULL),
  ('55555555-0000-0000-0000-000000000004', 'L Four',  'l4@gbig.test', 18, NULL, NULL);
INSERT INTO public.teams (id, name, player1_id, player2_id, league_id) VALUES
  ('66666666-0000-0000-0000-000000000001', 'LT1', '55555555-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000001'),
  ('66666666-0000-0000-0000-000000000002', 'LT2', '55555555-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000004', '22222222-0000-0000-0000-000000000001');
UPDATE public.players SET team_id = '66666666-0000-0000-0000-000000000001' WHERE id IN ('55555555-0000-0000-0000-000000000001','55555555-0000-0000-0000-000000000002');
UPDATE public.players SET team_id = '66666666-0000-0000-0000-000000000002' WHERE id IN ('55555555-0000-0000-0000-000000000003','55555555-0000-0000-0000-000000000004');
INSERT INTO public.events (id, name, event_date, start_date, status, course_id, league_id, week_number) VALUES
  ('77777777-0000-0000-0000-000000000001', 'Week 1', '2026-04-01', '2026-04-01', 'closed', '44444444-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', 1),
  ('77777777-0000-0000-0000-000000000002', 'Week 2', '2026-04-08', '2026-04-08', 'open',   '44444444-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', 2),
  ('77777777-0000-0000-0000-000000000003', 'Week 3', '2026-04-15', '2026-04-15', 'draft',  '44444444-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000001', 3);
-- week 1 scores incl. a duplicate submission for L One (the older, shorter one should be quarantined)
INSERT INTO public.scores (event_id, player_id, hole_scores, gross_total, net_total, handicap_used, created_at) VALUES
  ('77777777-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000001', '{4,4,4,5,4,3,4,4,5}', 37, 30, 7, now() - interval '2 days'),
  ('77777777-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000001', '{4,4,4,5,4,3,4,4,5}', 37, 30, 7, now() - interval '1 day'),
  ('77777777-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000002', '{5,4,5,6,5,4,5,5,6}', 45, 32, 13, now()),
  ('77777777-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000003', '{4,3,4,5,4,3,4,4,5}', 36, 33, 3, now()),
  ('77777777-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000004', '{6,5,6,7,6,5,6,6,7}', 54, 36, 18, now()),
  -- week 2 (open): LT1 submitted, LT2 did not
  ('77777777-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000001', '{4,3,4,5,4,3,4,4,5}', 36, 29, 7, now()),
  ('77777777-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000002', '{5,4,5,6,5,4,5,5,6}', 45, 32, 13, now());
INSERT INTO public.push_subscriptions (endpoint, p256dh, auth_key) VALUES ('https://legacy.push/1', 'k', 'a');
INSERT INTO public.news_posts (title, body, league_id) VALUES ('Welcome', 'Hi', '22222222-0000-0000-0000-000000000001');
INSERT INTO public.handicap_history (player_id, event_id, handicap, scores_used) VALUES ('55555555-0000-0000-0000-000000000001', '77777777-0000-0000-0000-000000000001', 7.4, 1);
INSERT INTO public.follows (follower_id, following_id) VALUES ('55555555-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000003');

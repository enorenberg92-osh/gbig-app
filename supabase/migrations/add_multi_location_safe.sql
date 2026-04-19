-- ============================================================
--  Multi-location migration — SAFE for current GBIG schema
--
--  Difference from add_multi_location.sql:
--    * Skips ALTER/UPDATE on tables that don't exist in production
--      today (bays, services, bay_services, operating_hours,
--      hour_overrides, bookings, bay_blocks). Those tables were
--      planned for a native booking system that was never built.
--
--  Idempotent: safe to re-run. Every CREATE/ALTER/INSERT is
--  guarded by IF NOT EXISTS or ON CONFLICT DO NOTHING.
--
--  Run once in Supabase SQL Editor (Dashboard → SQL Editor).
-- ============================================================

-- 1. locations master table
CREATE TABLE IF NOT EXISTS locations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE NOT NULL,
  app_name      TEXT NOT NULL,
  primary_color TEXT NOT NULL DEFAULT '#10B981',
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 2. GBIG as the first location
INSERT INTO locations (name, slug, app_name, primary_color)
VALUES ('Green Bay Indoor Golf', 'gbig', 'GBIG App', '#10B981')
ON CONFLICT (slug) DO NOTHING;

-- 3. Per-location admins (replaces the global `admins` table)
CREATE TABLE IF NOT EXISTS location_admins (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'admin',  -- 'admin' | 'super_admin'
  created_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, location_id)
);

-- 4. Promote every existing admin to a GBIG location_admin
INSERT INTO location_admins (user_id, location_id, role)
SELECT a.user_id, l.id, 'admin'
FROM   admins a
CROSS JOIN locations l
WHERE  l.slug = 'gbig'
ON CONFLICT (user_id, location_id) DO NOTHING;

-- 5. Add location_id to every scoped table that EXISTS today
ALTER TABLE players            ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE teams              ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE events             ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE scores             ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE league_config      ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE courses            ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE news_posts         ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE alerts             ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE subs               ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE handicap_history   ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE app_events         ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);

-- 6. Backfill every existing row with the GBIG location_id
DO $$
DECLARE gbig_id UUID;
BEGIN
  SELECT id INTO gbig_id FROM locations WHERE slug = 'gbig';

  UPDATE players            SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE teams              SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE events             SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE scores             SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE league_config      SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE courses            SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE news_posts         SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE alerts             SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE push_subscriptions SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE subs               SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE handicap_history   SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE app_events         SET location_id = gbig_id WHERE location_id IS NULL;
END $$;

-- 7. NOT NULL on core tables (leave push_subscriptions nullable — it's optional data)
ALTER TABLE players          ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE teams            ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE events           ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE scores           ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE league_config    ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE courses          ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE news_posts       ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE alerts           ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE subs             ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE handicap_history ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE app_events       ALTER COLUMN location_id SET NOT NULL;

-- 8. Indexes for fast location-scoped queries
CREATE INDEX IF NOT EXISTS idx_players_location          ON players(location_id);
CREATE INDEX IF NOT EXISTS idx_teams_location            ON teams(location_id);
CREATE INDEX IF NOT EXISTS idx_events_location           ON events(location_id);
CREATE INDEX IF NOT EXISTS idx_scores_location           ON scores(location_id);
CREATE INDEX IF NOT EXISTS idx_league_config_location    ON league_config(location_id);
CREATE INDEX IF NOT EXISTS idx_courses_location          ON courses(location_id);
CREATE INDEX IF NOT EXISTS idx_news_posts_location       ON news_posts(location_id);
CREATE INDEX IF NOT EXISTS idx_alerts_location           ON alerts(location_id);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_loc    ON push_subscriptions(location_id);
CREATE INDEX IF NOT EXISTS idx_subs_location             ON subs(location_id);
CREATE INDEX IF NOT EXISTS idx_handicap_history_location ON handicap_history(location_id);
CREATE INDEX IF NOT EXISTS idx_app_events_location       ON app_events(location_id);

-- 9. Show the new GBIG UUID — copy this into .env.local as VITE_LOCATION_ID
SELECT id AS gbig_location_id FROM locations WHERE slug = 'gbig';

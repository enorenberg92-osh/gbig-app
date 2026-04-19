-- ============================================================
--  Multi-location migration
--  Run once in Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- 1. Locations master table
CREATE TABLE IF NOT EXISTS locations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,          -- "Green Bay Indoor Golf"
  slug          TEXT UNIQUE NOT NULL,   -- "gbig"
  app_name      TEXT NOT NULL,          -- "GBIG App"
  primary_color TEXT NOT NULL DEFAULT '#10B981',
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 2. Insert GBIG as the first location
--    Save the returned id — you'll put it in .env.local as VITE_LOCATION_ID
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

-- 4. Migrate existing admins → location_admins for GBIG
INSERT INTO location_admins (user_id, location_id, role)
SELECT a.user_id, l.id, 'admin'
FROM   admins a
CROSS JOIN locations l
WHERE  l.slug = 'gbig'
ON CONFLICT (user_id, location_id) DO NOTHING;

-- 5. Add location_id to every scoped table
ALTER TABLE players          ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE teams            ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE events           ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE scores           ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE league_config    ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE courses          ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE news_posts       ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE alerts           ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE bays             ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE services         ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE bay_services     ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE operating_hours  ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE hour_overrides   ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE bookings         ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE bay_blocks       ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE subs             ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE handicap_history ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);
ALTER TABLE app_events       ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES locations(id);

-- 6. Backfill all existing rows with the GBIG location_id
DO $$
DECLARE
  gbig_id UUID;
BEGIN
  SELECT id INTO gbig_id FROM locations WHERE slug = 'gbig';

  UPDATE players          SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE teams            SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE events           SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE scores           SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE league_config    SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE courses          SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE news_posts       SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE alerts           SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE push_subscriptions SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE bays             SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE services         SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE bay_services     SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE operating_hours  SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE hour_overrides   SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE bookings         SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE bay_blocks       SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE subs             SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE handicap_history SET location_id = gbig_id WHERE location_id IS NULL;
  UPDATE app_events       SET location_id = gbig_id WHERE location_id IS NULL;
END $$;

-- 7. Make location_id NOT NULL now that backfill is complete
ALTER TABLE players          ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE teams            ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE events           ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE scores           ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE league_config    ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE courses          ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE news_posts       ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE alerts           ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE bays             ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE services         ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE operating_hours  ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE bookings         ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE subs             ALTER COLUMN location_id SET NOT NULL;
ALTER TABLE app_events       ALTER COLUMN location_id SET NOT NULL;
-- leave push_subscriptions, bay_services, bay_blocks, hour_overrides nullable (optional rows)

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
CREATE INDEX IF NOT EXISTS idx_bays_location             ON bays(location_id);
CREATE INDEX IF NOT EXISTS idx_services_location         ON services(location_id);
CREATE INDEX IF NOT EXISTS idx_bookings_location         ON bookings(location_id);
CREATE INDEX IF NOT EXISTS idx_subs_location             ON subs(location_id);
CREATE INDEX IF NOT EXISTS idx_handicap_history_location ON handicap_history(location_id);
CREATE INDEX IF NOT EXISTS idx_app_events_location       ON app_events(location_id);

-- ============================================================
--  After running this, go to:
--  Supabase → Table Editor → locations
--  Copy the UUID for "Green Bay Indoor Golf"
--  Add to your .env.local:
--    VITE_LOCATION_ID=<that-uuid>
--    VITE_APP_NAME=GBIG App
-- ============================================================

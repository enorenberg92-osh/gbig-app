-- ── alerts expiry ──────────────────────────────────────────────────────────
-- Adds an optional expiry timestamp so admins can send alerts that auto-hide
-- from the player feed + admin history after a window. Rows stay in the DB
-- (audit trail) but are filtered out of queries where expires_at <= now().
--
-- NULL expires_at means "never expires" — still show, until an admin clicks
-- the delete button we're adding to AdminAlerts.
--
-- Safe to run multiple times: IF NOT EXISTS + no constraint churn.
-- ───────────────────────────────────────────────────────────────────────────

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL;

-- Index to make the "active alerts only" query cheap. Partial index limited to
-- rows that have an expiry set; NULL-expiry rows are looked up by other filters.
CREATE INDEX IF NOT EXISTS idx_alerts_expires_at
  ON alerts(expires_at)
  WHERE expires_at IS NOT NULL;

-- Sanity check after running:
--   SELECT column_name, data_type, is_nullable
--     FROM information_schema.columns
--    WHERE table_name = 'alerts' AND column_name = 'expires_at';

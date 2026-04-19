-- ============================================================================
-- Missed-week penalty — add entry_type discriminator to scores
-- ----------------------------------------------------------------------------
-- Stores "missed week" penalty entries as distinct rows alongside regular
-- "played" entries. Penalty rows carry net_total = player_handicap + 7,
-- no hole_scores, no gross_total. Admin generates these at close-week for
-- rostered players (teams.player1_id / player2_id) who didn't submit a
-- score.
--
-- Design decisions (locked in memory: project_gbig_missed_week_penalty.md):
--   • Individual penalty only — partner is not penalized.
--   • Excluded from: handicap calculation, skins, hole-level achievements.
--   • Included in:   weekly standings, season totals, player profile history.
--   • Idempotent:    safe to run multiple times; default backfills existing
--                    rows to 'played'.
-- ============================================================================

ALTER TABLE scores
  ADD COLUMN IF NOT EXISTS entry_type TEXT NOT NULL DEFAULT 'played';

-- Ensure only the two valid values ever land in this column. Wrapping in
-- DO-block so re-running the migration doesn't fail on an existing
-- constraint with the same name.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scores_entry_type_check'
  ) THEN
    ALTER TABLE scores
      ADD CONSTRAINT scores_entry_type_check
      CHECK (entry_type IN ('played', 'missed_penalty'));
  END IF;
END $$;

-- Composite index — close-week queries ask "for this event, who already
-- has a played entry?" which is perfectly served by this index.
CREATE INDEX IF NOT EXISTS idx_scores_event_entry_type
  ON scores(event_id, entry_type);

-- ---------------------------------------------------------------------------
-- Sanity check (informational only — run manually to verify):
--   SELECT entry_type, COUNT(*) FROM scores GROUP BY entry_type;
-- ---------------------------------------------------------------------------

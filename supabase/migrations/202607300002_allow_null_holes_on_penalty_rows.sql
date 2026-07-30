-- Fix: missed-week penalty rows could never be inserted.
--
-- scores.hole_scores and scores.gross_total carry NOT NULL constraints, but
-- validate_score_row (202607100002) requires missed_penalty rows to have BOTH
-- as NULL — so publish_week failed with a not-null violation the first time
-- any rostered player missed a week. Unnoticed until now because no real
-- league week has had an absence.
--
-- Drop the two NOT NULLs; shape is still enforced (better) by
-- validate_score_row: played rows must have valid hole_scores + matching
-- gross_total, penalty rows must have neither. net_total stays NOT NULL —
-- every row type writes it.

BEGIN;
ALTER TABLE public.scores ALTER COLUMN hole_scores DROP NOT NULL;
ALTER TABLE public.scores ALTER COLUMN gross_total DROP NOT NULL;
COMMIT;

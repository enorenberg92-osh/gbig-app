# League closeout changes — September 6, 2026

Implemented in the isolated review checkout, branch `codex/scorecard-drafts`. Nothing has been deployed or applied to the Desktop checkout or production database.

## Staff workflow

1. Review verified played scores, pending reviews, missing players, and existing penalties separately. A team is complete only when both rostered players have verified results.
2. Resolve pending scores in Scores. Confirm missing players and their penalty preview. Complete the review and explicitly acknowledge missing-round penalties before publishing.
3. Publish through the existing atomic `publish_week` function. Reload the same completed event before composing its recap. Only then copy the recap or open a mail draft. No email is sent automatically. Recipients come from the event roster.

Load failures are errors rather than empty successful results. A successful publish followed by a failed reload explains that the round is already published and blocks further publishing until refresh. Tied skins correctly produce no winner. Preview results exclude pending scores; finalized results include missed-round penalties. Special-format recaps use stored format results.

## Database migration

`202609060001_closeout_consistency.sql` makes malformed score arrays fail validation deterministically, locks the event before reviewing a score to serialize against publishing, and blocks normal approve/reject operations on closed rounds. Audited admin corrections remain available and now recompute the closed event's format results.

The existing server retains authority for publication, no-show rules, authorization, and score submission. The UI is not a replacement for these checks. Apply the migration through the normal release process, with staging validation, before releasing the associated interface.

## Back-nine display

Score entry, player scorecards, schedule contest selectors, admin score editors, skins, and report skins now use course `start_hole` for display. Back-nine rounds show 10–18. Existing score-array and contest-hole storage stays relative to the played round (positions 1–9), preserving saved data semantics.

## Validation

- 63 unit tests passed; five pre-existing Supabase integration tests remain skipped.
- Nine native PostgreSQL function-contract checks passed: simultaneous submissions; submit/publish race; atomic pending-score rejection; correct and idempotent penalties; reject/resubmit/approve/publish; player and cross-venue authorization; malformed payloads; closed-round review rejection; late correction replacing a penalty. The new migration is loaded twice to check replacement idempotency.
- These checks use actual repository function bodies with a minimal synthetic schema. They do **not** prove the full migration chain, production grants/RLS, PostgREST behavior, or every special-format calculation. Tests of correction recomputation currently exercise stroke play.
- Synthetic browser walkthrough: pending gate, missing acknowledgement, confirmation, final penalty-inclusive recap, back-nine skins labels, load-error recovery screen, and 390px phone layout.
- Production build passed. A pre-existing large-bundle warning remains.

## Running database checks locally

The runner `node scripts/test-database.mjs` targets only a disposable PostgreSQL cluster on `127.0.0.1:55439` as postgres. It never reads production connection settings. It creates a uniquely named test database and drops that same database afterward. Set `GBIG_TEST_PG_BIN` if PostgreSQL is installed elsewhere. Start a dedicated local cluster on this port first; do not use a business-data cluster. The fixture SQL is deliberately minimal and is not a production migration.

## Remaining launch work

Authenticated comparison with the existing GolfSoftware account remains pending Chrome access. Its official quick tutorial describes post-play reports followed by Finalize, which publishes reports and advances the player's event: https://www.golfsoftware.com/help/lmw/QuickTutorial.html . The local implementation follows that sequence but has not been compared against this facility's configured screens.

Before launch: replay and validate migrations on a staging copy; test the actual app via Supabase with staff/player roles; rehearse a complete fall week and fall-to-winter rollover; review all supported special formats and correction/deletion behavior. Appleton's dedicated booking URL remains owner-supplied follow-up work.

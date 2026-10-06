# October 6 league readiness pass

Website signup integration is excluded at the owner's request. Appleton's installed app should show Appleton on its loading screen and icon.

## Season rehearsal

A deterministic synthetic fall season runs through actual repository PostgreSQL mutation functions in a disposable local database: Green Bay and Appleton each have 150 teams, 300 golfers, and twelve playable weeks. It also starts winter Week 1 with all 600 golfers to test history ordering after week numbers restart. No production scores or memberships are inserted.

The independently calculated ledger is compared against every rostered score's hole values, gross, handicap used, net, entry type, sub flag, and historical team. It reconciles all cumulative team totals after each week. The independent handicap oracle applies the discard thresholds, 90% calculation, floor, and -2..27 limits without calling the application's handicap helper.

The repeat rehearsal reconciled 7,200 fall roster results with 69,412 assertions across both venues. Scenarios: duplicate retries; partial-team rejection/resubmission; an absent individual; an absent whole team; a substitute and individual mirror; a historical team swap; a late score correction; a bye; final-week closeout; player publication denial; fall-to-winter handicap history.

Green Bay has 3,597 played cards (32,373 hole scores) and three missed-round penalties. Total net is 132,410; played gross is 161,637. Teams 015 and 060 both have the lowest total, 847 net. The report reflects final corrected data, including the Week 2 correction made during Week 8. Handicap snapshots retain the values calculated at each original closeout.

Skins use the actual shared roster selection and `calcSkins` helpers and a separate sorted-score oracle for all 216 holes: each venue has 72 awards and 36 tied lows. Every roster golfer is assumed entered; ties cancel with no carryovers. Coverage counts once; a substitute's duplicate individual history is excluded. The roster slot's skins eligibility and credit are retained across app surfaces. No cash pool or dollar payout is invented.

The roster-swap fixture initially overlapped inclusive membership dates; correcting the fixture to end the old membership the day before the new one matches the existing app swap function. This was a fixture error, not a discovered app swap defect.

`artifacts/season-rehearsal.json` contains every weekly score and cumulative standings snapshot for both venues. The interactive season view is built from this output. Its venue/week controls and pagination were checked by executing the script against a DOM fixture. The existing Excel report contains the Green Bay rehearsal. Live browser access was recovered for this follow-up.

## Bugs fixed

- Handicap history used week number ahead of date. An older fall Week 12 could displace a newer winter Week 1 from recent history. Both client and SQL now sort by actual play date before week number.
- Season standings attached all player history to the hydrated current team roster. Totals now use the roster for each event and exclude a substitute's mirrored individual history. Played scores supersede obsolete penalties deterministically.
- Admin corrections could adopt a player's newly recalculated handicap. Editing an existing played score now retains its stored handicap. Replacing a penalty with a played score uses the normal entry basis.
- Standings read failures could appear as empty successful results. All required query results are now checked.
- Unpaged season queries could hit the API response limit and silently omit scores from large leagues. Season scores, historical rosters, match points, staff handicap history, attendance, score exports, and money ledgers now load every page in a deterministic order. A later-page failure discards the partial result. A regression loads 3,600 results and roster entries and reconciles all 150 team totals, including a server cap below the requested page size.
- Venue lookup failures could fall back to the other venue. The location resolver uses only the hostname's venue or a matching cached location; otherwise it displays a retryable error before app operations start.
- Appleton install manifests fell back to Green Bay on database failure. Manifests now retain hostname-specific names/icons; initial iOS title and icons are set before asynchronous boot. Cached identity from a different slug is rejected.
- Database publication now rejects missing/invalid course pars, mismatched total par, empty rosters, duplicate players, and teams without exactly two members. Deletion of a closed score is blocked so finalized results remain complete; audited corrections remain available.

September's draft recovery, closeout, and back-nine improvements are also included in this release branch.

The follow-up pass also fixed duplicate substitute mirrors entering skins, handicap previews including excluded special formats, same-name people merging in money reports, recap attribution after historical team changes, inconsistent alphabetical ordering of equal standings totals, hidden zero net totals, and back-nine labels in the expanded player scorecard. Failed skins/handicap/report reads now show errors; money suggestions reset when the selected week or values change and disable repeat clicks during submission.

## Checks and limits

83 unit tests and eleven PostgreSQL contract checks passed. The production build passed with the existing large JavaScript bundle warning. Five older Supabase integration tests are still skipped.

The PostgreSQL rehearsal loads actual function bodies and triggers with a minimal schema. It is not a replay of the full historical migration chain, production RLS/grants, REST authentication, every special-format engine, push notifications, bookings, payment records, or a physical installed-phone test. The rehearsal uses ordinary stroke scoring for the season. Do not interpret local passing tests as a production launch signoff.

The owner unpaused Supabase; the project is now ACTIVE_HEALTHY and read-only API/schema checks work. The existing 240 score rows have zero gross or net arithmetic discrepancies. Green Bay's existing working league is Summer 2026, with ten closed weeks. Appleton has a draft TEST League; no fall league is configured in the audited data. Both live manifests now show the correct venue while the database is available. The Appleton booking URL is configured in the database.

The three database migrations were applied in one transaction on October 6, with migration history recorded. Function backups and rollback SQL are saved locally. Before/after digests confirm all existing score, player, and event records and function permissions were unchanged. The earlier direct Vercel API rejection was overcome using its authenticated CLI. Hosting inspection found both public venue aliases still pointing to a July deployment. Frontend release and post-release browser checks are tracked in the release report.

The report matches the app's sequential display positions: net totals ascending, then team name on equal totals. Equal totals are visible without inventing a season-prize tie-break rule. A formal league tie-break rule has not been supplied, so no ranking policy change is included.

## Release sequence

1. Obtain working hosting access; Supabase is already healthy and audited read-only.
2. Inspect the installed schema/functions and stage these migrations in order: `202609060001_closeout_consistency.sql`, `202610060001_season_handicap_order.sql`, `202610060002_publication_guards.sql`.
3. Run staff/player workflows against the real API in staging, then apply validated database changes and release the frontend together.
4. Confirm each live hostname, manifest, loading screen, roster, a submitted/reviewed round, final closeout, and an actual Appleton phone installation. Existing home-screen icon/name metadata may require a fresh installation; first protect any unfinished local scorecard.

Local test commands: `npm test`, `npm run test:database`, `npm run test:season`, and `npm run season:view`. Database checks require the dedicated PostgreSQL cluster on loopback port 55439; `GBIG_TEST_PG_BIN` overrides its executable directory. They never read production database settings.

# October 6 league readiness pass

Website signup integration is excluded at the owner's request. Appleton's installed app should show Appleton on its loading screen and icon.

## Season rehearsal

A deterministic synthetic fall season runs through actual repository PostgreSQL mutation functions in a disposable local database: one Green Bay league, 150 teams, 300 golfers, and twelve playable weeks. It also starts winter Week 1 with all 300 golfers to test history ordering after week numbers restart. No production scores or memberships are inserted. A smaller two-venue rehearsal also passed earlier.

The independently calculated ledger is compared against every rostered score's hole values, gross, handicap used, net, entry type, sub flag, and historical team. It reconciles all cumulative team totals after each week. The independent handicap oracle applies the discard thresholds, 90% calculation, floor, and -2..27 limits without calling the application's handicap helper.

The completed 150-team rehearsal reconciled 3,600 fall roster results with 34,706 assertions. Scenarios: duplicate retries; partial-team rejection/resubmission; an absent individual; an absent whole team; a substitute and individual mirror; a historical team swap; a late score correction; a bye; final-week closeout; player publication denial; fall-to-winter handicap history.

Of those results, 3,597 are played cards (32,373 hole scores) and three are missed-round penalties. Total net is 132,410; played gross is 161,637. Teams 060 and 015 share first place on 847 net. The report reflects final corrected data, including the Week 2 correction made during Week 8. Handicap snapshots retain the values calculated at each original closeout.

Skins use the actual `calcSkins` helper and a separate sorted-score oracle for all 108 holes: 72 awards and 36 tied lows. Every roster golfer is assumed entered; ties cancel with no carryovers. Coverage counts once; a substitute's duplicate individual history is excluded. No cash pool or dollar payout is invented.

The roster-swap fixture initially overlapped inclusive membership dates; correcting the fixture to end the old membership the day before the new one matches the existing app swap function. This was a fixture error, not a discovered app swap defect.

`artifacts/season-rehearsal.json` contains every weekly score and cumulative standings snapshot. The interactive season view is built from this output. Its venue/week controls were checked by executing the script against a DOM test fixture. Current browser visual verification was unavailable: browser control could not establish a trustworthy current URL and stopped.

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

## Checks and limits

76 unit tests and eleven PostgreSQL contract checks passed. The production build passed with the existing large JavaScript bundle warning. Five older Supabase integration tests are still skipped.

The PostgreSQL rehearsal loads actual function bodies and triggers with a minimal schema. It is not a replay of the full historical migration chain, production RLS/grants, REST authentication, every special-format engine, push notifications, bookings, payment records, or a physical installed-phone test. The rehearsal uses ordinary stroke scoring for the season. Do not interpret local passing tests as a production launch signoff.

The owner unpaused Supabase; the project is now ACTIVE_HEALTHY and read-only API/schema checks work. The existing 240 score rows have zero gross or net arithmetic discrepancies. Green Bay's existing working league is Summer 2026, with ten closed weeks. Appleton has a draft TEST League; no fall league is configured in the audited data. Both live manifests now show the correct venue while the database is available. The Appleton booking URL is configured in the database.

The saved Vercel CLI credential returned HTTP 403. No production deployment or SQL migration has been applied by this pass. Current phone/browser visual verification remains unavailable; the installed phone's cached icon/loading identity is not yet confirmed fixed.

The reviewed branch is available in GitHub draft PR #1. Vercel built a Preview deployment successfully through the GitHub integration. Direct requests stop at Vercel Authentication (HTTP 302); the app page and manifest cannot be verified through that protected preview with the rejected CLI credential. Actual deployment hostnames omit the `-app` segment, so venue detection covers both forms.

The rehearsal report uses shared competition ranks for equal net totals. The current app displays sequential positions with team-name ordering on equal totals; net and gross totals reconcile independently of that display convention. A formal league tie-break rule has not been supplied, so no ranking policy change is included.

## Release sequence

1. Obtain working hosting access; Supabase is already healthy and audited read-only.
2. Inspect the installed schema/functions and stage these migrations in order: `202609060001_closeout_consistency.sql`, `202610060001_season_handicap_order.sql`, `202610060002_publication_guards.sql`.
3. Run staff/player workflows against the real API in staging, then apply validated database changes and release the frontend together.
4. Confirm each live hostname, manifest, loading screen, roster, a submitted/reviewed round, final closeout, and an actual Appleton phone installation. Existing home-screen icon/name metadata may require a fresh installation; first protect any unfinished local scorecard.

Local test commands: `npm test`, `npm run test:database`, `npm run test:season`, and `npm run season:view`. Database checks require the dedicated PostgreSQL cluster on loopback port 55439; `GBIG_TEST_PG_BIN` overrides its executable directory. They never read production database settings.

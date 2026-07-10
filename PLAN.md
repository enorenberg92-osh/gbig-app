# Plan: GBIG v-next — Robustness + League Platform Expansion
_Locked via grill — by Claude + Erich. Revised after 5 Codex review rounds (38 findings accepted, 0 rejected)._

## Goal

Take GBIG from a single-location league app to a robust, sellable multi-location league platform serving thousands of players. Fix every found data-integrity bug first, finish multi-tenancy, then add a configurable league-format engine (match play, stableford, scramble, halves/playoffs, individual events, Ryder Cup), player score entry with admin verification, optional per-hole stat tracking, and toggleable admin power tools (flights, money list, reports, attendance) — Squabbit/TheGrint/Golfsoftware capabilities on the existing React+Vite+Supabase stack, with every feature toggleable per location/league.

## Architectural spine (added after review round 1)

- **Server-authoritative mutations.** Every multi-row or invariant-bearing mutation (score submit, verify, close-week publish, format-result computation, ledger writes) moves into transactional Postgres RPCs — never sequences of client calls. Client code calls one RPC and renders the result.
- **RPC hardening template (every function follows it):** `security definer` with fixed `search_path = public`; caller identity from `auth.uid()` only — `location_id`/`player_id` are *derived server-side*, never trusted from the client; explicit admin checks against `location_admins` where required; `REVOKE ALL` then `GRANT EXECUTE` to `authenticated`; **player-role** direct INSERT/UPDATE/DELETE on the underlying tables removed once the RPC owns the path. Admin direct CRUD is a **narrow allowlist** — `courses`, `news_posts`, `app_events`, `alerts`, `league_config` settings fields, `flights`, format templates — under admin-checked RLS. Everything invariant-bearing or audit-critical is RPC-only for admins too: `events.status` transitions (only `publish_week` closes a week), `team_memberships`/roster edits, handicap overrides + recalc, all score paths, ledger writes. Direct admin UPDATE cannot bypass publish, audit, or recalculation.
- **Locking protocol:** `submit_scores` and `publish_week` both `SELECT … FOR UPDATE` the event row first. Submit rechecks `status='open'` inside the lock; publish rechecks missing players and pending rows inside the same lock. Submit-during-publish serializes instead of racing.
- **Canonical league table:** `league_config` (what the app actually uses) is the league entity. All new `league_id` FKs reference it; legacy `leagues` table is dropped in Phase 2 after FK migration. Multiple leagues may be `is_active` concurrently (Mon + Wed nights) — AdminLeague's current deactivate-all-others toggle is rewritten; uniqueness is enforced only on `is_working` (one per location, partial index).
- **DB as arbiter.** Invariants live in constraints, not client checks. Migration order matters: first add `scores.status text NOT NULL DEFAULT 'verified' CHECK (status IN ('pending','verified','rejected'))` (backfills existing rows as verified), *then* the partial unique index `scores(event_id, player_id, entry_type) WHERE status <> 'rejected'` (rejected rows stay for audit without blocking resubmission). Plus: partial unique index enforcing one open event per (location, league); `UNIQUE(location_id, league_id, week_number)` on events; one working league per location. Trigger validation branches by entry_type: `played` rows require `hole_scores` length == course `num_holes` with int-range checks and totals matching sums; `missed_penalty` rows require `hole_scores IS NULL`.
- **Audit trail.** `audit_events` table (actor, location_id, action, entity, before/after jsonb, created_at) written by every mutation RPC — **created in Phase 1 before the first RPC ships**, since Phase 1 RPCs depend on it. Covers score approval/rejection, publish, handicap recalc, ledger edits, roster changes. Admin-only RLS; the writer redacts PII/secret fields (email, phone, passwords) from before/after payloads; ~24-month retention.
- **Test harness early.** Supabase integration tests (local `supabase start` + seeded data) for RLS isolation, concurrent submit/publish, and migration idempotency — built in Phase 1–2, run in CI, not deferred to the final bug hunt.

### Score lifecycle state machine (single source of truth)

```
entry_type: 'played' | 'missed_penalty'    status: 'pending' | 'verified' | 'rejected'
```
- Player-entered played score → `pending`. Admin-entered played score → `verified`.
- `pending` → `verified` (admin approve / bulk-approve) or → `rejected` (kept for audit; excluded from every computation and from the unique index, so resubmission works).
- **Consumer-specific filters:** standings & matchup results read the *effective* set — verified `played` rows ∪ verified `missed_penalty` rows (publish inserts penalties as `status='verified'`; penalties must cost points). Handicap, skins, and hole stats read verified `played` rows only.
- **Per-format penalty semantics:** penalty rows have no hole scores, so non-stroke engines can't score them directly. Each `format_config` declares a `no_show` policy (forfeit match / zero points / configurable) and the publish RPC converts penalties into format outcomes before the math runs.
- **Effective result rule:** one effective row per (event, player). Publish RPC: if a verified played row exists, any penalty row for that pair is deleted (superseded); penalties are only inserted for players with no played row *at publish time, inside the transaction*.
- Publish blocks while pending rows exist for the event — admin is prompted to bulk-approve or reject them first. No silent coexistence of pending + penalty.
- Sub scores: same lifecycle; `sub_played=true` rows count for team standings per existing rules, never for the absent player's handicap.

## Approach

### Phase 1 — Bug fixes & hardening (protects the live league; ships first)

1. **Score submit RPC + constraint.** Add partial unique index `scores(event_id, player_id, entry_type) WHERE status <> 'rejected'` (migration first detects existing duplicates, keeps the most complete row, logs the rest to a quarantine table). New `submit_scores(event_id, entries jsonb)` RPC (hardening template): derives the submitting player *and team* from `auth.uid()` — a player can only submit for their own team's matchup; validates course pars; computes totals server-side; inserts rows in one transaction with `ON CONFLICT` handling. Admin score entry/edit goes through a separate `admin_upsert_score` RPC gated on `location_admins`. `ScoreEntry.jsx` calls the player RPC; double-tap and both-teammates races die at the DB. **Ships with the full role-split RLS in the same phase:** blanket member-wide `FOR ALL` policies replaced everywhere — *players* lose direct writes on `scores`, `players` (beyond own profile), `teams`, `courses`, `league_config`, `events`, `subs`, …; *admins* keep direct CRUD under admin-checked policies (AdminLeague/AdminCourses keep working unchanged); invariant-bearing paths (submit/verify/publish) are RPC-only for everyone. No window where member-wide policies bypass the new invariants. `audit_events` + writer helper land first in this phase — the RPCs depend on them. (Phase 2 then handles views, legacy tables, and boot.)
2. **Atomic close-week publish RPC.** `publish_week(event_id)` Postgres function: `SELECT … FOR UPDATE` on the event row (same lock `submit_scores` takes — submit-during-publish serializes), re-queries missing players *inside* the lock, inserts penalty rows as `status='verified'` (`ON CONFLICT DO NOTHING`), applies the effective-result rule, computes format results (Phase 3 extends this), closes the event, opens the next — all-or-nothing. Partial unique index `(location_id, league_id) WHERE status='open'` enforces one open event. Publishing twice is a no-op. Replaces the multi-call `AdminDashboard.doPublish`.
3. **Fix round ordering.** Add `scores.created_at` (default `now()`) for audit. Fix display ordering at the query: `PlayerProfile.jsx` scores query (~184) joins events, orders by `week_number, start_date`; TrendChart + Recent Rounds render chronologically. Audit every `.order(` / client `.sort(` for missing keys; `Standings.jsx` weekly view (~165) stops taking `scores[0]` unordered.
4. **League scoping + team memberships.** Events/standings/team queries today are location-scoped only — wrong once a location runs two leagues, and *teams are the scoring unit*. Backfill/require `events.league_id` and `teams.league_id`; add `UNIQUE(location_id, league_id, week_number)` on events + one-working-league partial index. `players.team_id` allows only one team per player — broken for a player in both Mon and Wed leagues. New `team_memberships` (player_id, team_id, league_id, effective_from/effective_to) becomes the source of truth (also powers Phase 5 mid-season swaps); `players.team_id` backfilled into it and retired. Constraints: exclusion constraint bars overlapping effective ranges per (player, league); one active membership per (player, league); trigger enforces active-membership count per team == team size (2) — no three-player pairs; a `roster_at(event)` view resolves who was on which team for any event date. Backfill reconciles *both* legacy sources (`teams.player1_id/player2_id` and `players.team_id`); legacy slot columns then become read-only display fields until replaced by the view. Standings/AdminScores/AdminDashboard/ScoreEntry scope event *and team* lookups by league via memberships.
5. **Location-scoping holes.** `AdminSubs.ensureSubProfile` (~145): add `.eq('location_id')`. `AdminScores` existingSubScore (~239): scope + handle multiple rows. Grep-audit every update/delete for tenant predicates (defense-in-depth on top of RLS).
6. **Standardize date handling.** One `parseLocalDate()` util; fix `PlayerProfile.jsx:686` UTC-midnight bug; consume `locations.timezone` for "today"/open-week logic.
7. **Course data integrity + dynamic hole count.** `hole_pars` is the single source of truth (`total_par` derived). DB CHECK: array length == `num_holes`, pars in 3–6, `total_par = sum`; `hole_scores` length must match the event course's `num_holes`. ScoreEntry/AdminScores iterate `course.num_holes` instead of the hardcoded 9 (18-hole courses stop silently misbehaving). AdminCourses validates at save; remove the silent `Array(9).fill(4)` fallback in AdminScores — score entry blocks with a visible error if pars are missing. Length-guard every `hole_scores[i]`/`hole_pars[i]` zip in display code.
8. **Handicap input consistency.** Integer-clamp sub handicaps at entry (`SubRequest.jsx:91`) with the same rules as players.
9. **Query diet.** PlayerProfile fetches last N rounds (paginated), not all; Standings season view bounded to the league's events; `pg_trgm` GIN index for FriendsTab name search.
10. **Dead code sweep.** Remove or explicitly park orphaned `NewsPage`/`AdminNews`/`AdminBookings` (unrouted); record decision in ROADMAP.
11. **Test harness v1.** Vitest units (date util, zip guards, ordering comparators, handicapCalc stays green) + Supabase integration tests against local stack: concurrent double-submit, publish-during-submit, publish idempotency, RLS smoke (player A cannot read location B).

### Phase 2 — Finish multi-tenancy + security (sellable product foundation)

12. **RLS + legacy cleanup (remainder).** Phase 1 shipped the full role-split on tenant tables; this closes the edges: legacy `leagues` dropped after FK migration to canonical `league_config`; legacy `admins`/`skins` get policies or get dropped; `push_subscriptions.location_id` NOT NULL; social tables (`follows`, `messages`) re-audited. Negative-test suite extended: location A admin cannot touch location B anywhere.
13. **Player data privacy.** Ecosystem player search reads a sanitized `player_public` view (id, name, avatar, location name) — email/phone/`league_password` never leave the location. Audit `league_password`: remove if dead, or move to a hashed, admin-only surface.
14. **Public boot resolver.** Subdomain-aware LocationProvider resolves `window.location.hostname` pre-auth via a public-safe `location_public` view (name, brand color, logos, timezone only). `VITE_LOCATION_ID` override honored only on localhost/dev builds. One Vercel project + wildcard DNS.
15. **Super-admin console completion.** Un-stub create-location, invite-admin, edit-branding flows (`SuperAdminPage.jsx` disabled routes). Onboarding a location = form, not SQL.
16. **Feature-flag layer.** `locations.features jsonb` + `league_config.features jsonb` (league overrides location). Client hides disabled surfaces; **write paths enforce server-side** — each feature's RPCs check the flag (mutating through a disabled feature is impossible; discovering one exists is acceptable). Flags default OFF for existing locations.
17. **Extend audit coverage** — `audit_events` exists since Phase 1; wire every Phase 2+ mutation (super-admin actions, flag changes, location onboarding) into it.

### Phase 3 — Format engine + score verification (the Squabbit layer)

18. **Verification UI.** AdminScores review queue: approve / edit-then-approve / reject, one-tap bulk-approve. Publish RPC blocks on pending rows (state machine above). Player-facing: This-Week shows own pending rows flagged "awaiting review."
19. **Format engine schema.** `events.format` (`stroke` | `match_team` | `match_individual` | `stableford` | `scramble` | `best_ball`) + `events.format_config jsonb` with a **`version` field and per-format validated schema** (point values, per-hole vs match points, net/gross, best-ball vs aggregate, stroke allowance %, quota basis…). League default + per-event override chosen at event creation — nothing hardcoded. Config validated server-side at event save; **results computed inside verify/publish RPCs** (server-authoritative), stored in `matchups`/result tables; client only renders. Golden tests per format × option matrix.
20. **Stroke index.** `courses.stroke_index jsonb` (validated: permutation of 1..n); AdminCourses edits it; match/stableford engines allocate strokes by index. Fallback when absent: even spread (documented, visible in UI).
21. **Matchups.** `matchups` table (event_id, home/away team or player ids, points_home, points_away, status, location_id, league_id). Round-robin generator in AdminSchedule (manual override); results from the format engine over verified scores; season points table feeds standings.
22. **Standings v2.** Points-based standings alongside net/gross; season segments (`league_config.segments`: week ranges) with per-segment winners; playoff bracket (manual seeding with auto-suggest).
23. **Special events.** Scramble/best-ball nights: team-of-the-night scoring, standalone leaderboard, excluded-from-handicap flag. Individual match play event: single-elim bracket across one or more nights.
24. **Ryder Cup module.** `cups` (name, date range, point rules jsonb w/ version), `cup_points` accrual from admin-configured point values per result type over a configurable horizon → qualification/seeding list; `cup_matches` (sessions: fourball/foursomes/singles, 1/½/0 scoring, running team score). Toggleable; reads existing league results.

### Phase 4 — Player stats depth (the TheGrint layer)

25. **Optional per-hole stats.** `scores.hole_stats jsonb` (`[{putts, fir, gir, penalties}]`, DB-validated shape). ScoreEntry stats row per hole, always skippable.
26. **Profile stats v2.** Putts/round, FIR%, GIR%, scoring by par type + trend, personal bests, handicap history graph (from `handicap_history`), season-over-season compare. Computed from paginated queries or a small SQL view.
27. **Round detail view.** Tap a round → hole-by-hole scorecard with stats, vs-par coloring, skins won that night.

### Phase 5 — Admin power tools (the Golfsoftware layer; each independently toggleable)

28. **Flights/divisions.** `flights` table (league_id, name, order); manual assignment with auto-suggest by handicap band; standings/points/payouts per flight.
29. **Money list (ledger only).** `ledger` table (location_id, league_id, event_id?, player_id/team_id, type: entry_fee|skins|match_points|event_prize|payout, amount, note); writes via RPC (audited). Weekly auto-suggest from skins/match results (admin confirms); money-list report; who's-owed summary. No payment processing.
30. **Reports & export.** Print-CSS week-recap (results, skins, standings movement), printable standings + money list, CSV export (players/scores/standings/ledger). Browser print, no PDF lib.
31. **Attendance & roster ops.** Attendance derived from `scores.entry_type` + subs per event; season grid; CSV roster export; mid-season team swaps preserving score history (player_id stable, team link changes with effective week).

### Phase 6 — Second bug hunt

32. **Full re-audit** of the expanded app: repeat ordering/race/scoping/scale sweep on all new code; load-test standings + format engine with seeded thousands-of-rows data; RLS/concurrency suite green; fresh adversarial review (Codex) of the implemented system.

## Key decisions & tradeoffs

- **Server-authoritative RPCs over client orchestration.** All invariant-bearing writes are single Postgres functions. Costs: SQL in migrations, harder local debugging. Buys: atomicity, auditability, flag enforcement, one place for format math. Chosen after Codex round 1 exposed the publish/submit races as unfixable client-side.
- **Format engine over hardcoded formats.** Every scoring choice is per-event config chosen at setup (Erich's explicit requirement). Mitigated with versioned config schemas + server-side validation + golden tests — not a loose JSON bucket.
- **Players enter, admin verifies.** Pending scores excluded from all computation; publish blocks on unresolved pending rows. Simpler and safer than provisional math.
- **Role-split RLS, not member-wide `FOR ALL`.** Players read; writes are narrow (own profile) or RPC-mediated; admin writes check `location_admins`. Ecosystem search via sanitized view only.
- **Manual optional stats, no sim integration.** No vendor dependency; stats never block score submission.
- **Ledger only, no payments.** Money list tracks; cash moves outside the app.
- **Multi-location in THIS plan.** Every new table ships with `location_id` + RLS + audit in the same migration.
- **Feature flags: jsonb at location + league, client-hidden, server-enforced on writes.** Two columns, no extra joins; not an A/B system.
- **No new heavy dependencies.** Print CSS over PDF lib; SQL views over analytics service; Vitest + local Supabase for tests.
- **Bugs → tenancy → features → stats → tools → re-audit.** Erich chose solid-ground-first with an explicit final bug-hunt phase.

## Risks / open questions

- **Format engine scope creep.** Each format × option combination needs correct math + golden tests. Mitigation: ship formats incrementally behind flags (match play first).
- **RPC migration discipline.** Moving submit/publish into SQL functions is the riskiest refactor touching the live league. No dual-write (direct writes are revoked at cutover): instead, shadow-compare — run the new RPCs in dry-run against recent real events and diff results vs the current client math, then a single cutover deployed between league nights.
- **Verification queue adoption.** Bulk-approve must be genuinely one tap or admins will route around it.
- **Duplicate-row cleanup.** UNIQUE migration must detect + quarantine existing dupes before constraint creation; quarantine reviewed by admin, not silently deleted.
- **Timezone rollout.** Location-timezone "today" logic can shift the open week at boundaries — deploy between league nights.
- **RLS + new tables discipline.** Checklist per migration: location_id, policies, audit wiring, negative test.
- **Ryder Cup point rules** finalized with Erich when that module starts (config-level design is locked).

## Out of scope

- Payments/Stripe (ledger only).
- Social/engagement features (activity feed, badges, league chat) — deferred by choice.
- Sim-software data import (GSPro/Trackman round files).
- Native reservations flow — `AdminBookings.jsx` stays parked; WordPress iframe unchanged.
- Multi-course-per-night events (18-hole *courses* are supported via dynamic `num_holes`; mixing courses within one event night is not).
- Mobile native apps; PWA remains the delivery vehicle.
- TypeScript migration, Tailwind, or any framework change.

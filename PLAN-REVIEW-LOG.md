# Plan Review Log: GBIG v-next — Robustness + League Platform Expansion

Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=5.
Reviewer: Codex CLI 0.144.0-alpha.4, model gpt-5.5 (config-pinned), read-only sandbox.

Grill decisions locked: priorities = player stats + formats/games + admin tools (social deferred); players enter scores w/ admin verification; formats = team match play, stableford, scramble/best-ball, halves+playoffs, individual match play, Ryder Cup (season points → qualify/seed → cup event); all features toggleable per location/league; format engine fully configurable per event (nothing hardcoded); money = ledger only, low priority; multi-location product in scope; manual optional stats (no sim import); build order = bugs → tenancy → features → stats → tools → second bug hunt.

## Round 1 — Codex

**Findings**

- RLS is materially unsafe: current policies grant `FOR ALL` on tenant tables to any location member and global player reads, while `players` carries email/password-like fields. Fix: replace with admin/owner policies, expose a sanitized `player_public` view, and remove/rotate `league_password`.
- The partial `UNIQUE(event_id, player_id)` plan for `entry_type='played'` will not make Supabase client `upsert` reliable and will not dedupe penalty rows. Fix: use a transactional RPC with a real conflict key such as `(event_id, player_id, entry_type)`.
- Penalty-plus-played rows can double count: ScoreEntry intentionally ignores penalty rows, while standings sum all score rows. Fix: define one effective result per player/event, or supersede/delete the penalty when a played score arrives.
- Publish is still non-atomic: insert penalties, close event, and open next event are separate client calls. Fix: move close-week into one SQL/Edge transaction with row locks and a partial unique constraint allowing only one open event per location/league.
- "Active league's events already implicit" is false: current event/standings queries are location-scoped, not league-scoped. Fix: add/backfill `events.league_id`, scope all event/scores/standings queries by active/working league, and enforce `UNIQUE(location_id, league_id, week_number)`.
- Subdomain tenancy is under-specified for unauthenticated boot: `LocationProvider` currently requires `VITE_LOCATION_ID`, and `locations` is only selectable by authenticated users. Fix: add a public-safe hostname-to-location resolver/view for branding/timezone only, and honor env override only on localhost/dev.
- Feature flags are client-only in the plan, so disabled features remain callable by crafted Supabase requests. Fix: enforce feature availability in RPC/RLS/server checks for every write path.
- Score verification lacks a state machine: pending rows, penalties, sub rows, and close-week missing detection will conflict. Fix: explicitly define status transitions and require publish to resolve or bulk-approve pending rows before penalties/standings run.
- Course/score JSON validation is only planned in the UI. Fix: add DB CHECKs or triggers for array type/length/range and computed totals; client guards are not integrity controls.
- Format config is a loose JSON bucket with no versioned contract. Fix: define versioned schemas per format, validate server-side, and add golden tests for every scoring mode.
- Admin write paths remain broadly unscoped by `location_id` and depend on loose RLS. Fix: add tenant predicates to every update/delete and test that non-admin players cannot mutate admin tables.
- Observability is missing for critical operations like approval, publish, handicap recalculation, ledger edits, and rejected scores. Fix: add an `audit_events` table populated by mutation functions with actor, location, action, before/after, and request id.
- Testing is too light for the risks: unit tests will not catch RLS leaks, migration collisions, or concurrent submit/publish races. Fix: add Supabase integration/concurrency tests before Phase 2, not only in the final bug hunt.

VERDICT: REVISE

### Claude's response

Accepted (13/13, two with modifications):
1. RLS overhaul — ACCEPTED. New Phase 2 item: role-split policies (admin-write vs player-limited-write), sanitized `player_public` view for ecosystem search, `league_password` audit/removal.
2. Conflict key — ACCEPTED MODIFIED. Plain `UNIQUE(event_id, player_id, entry_type)` + transactional `submit_scores` RPC; client upsert dropped.
3. Effective-result rule — ACCEPTED. One effective row per player/event; played supersedes penalty inside publish RPC.
4. Atomic publish — ACCEPTED. Single Postgres RPC (penalties + close + open next) with one-open-event partial unique index. Moved into Phase 1.
5. League scoping — ACCEPTED. Codex is right that "already implicit" was wrong. New Phase 1 item: backfill `events.league_id`, league-scope queries, `UNIQUE(location_id, league_id, week_number)`.
6. Public boot resolver — ACCEPTED. Public-safe `location_public` view (name/brand/logo only); env override dev-only.
7. Server-side flag enforcement — ACCEPTED MODIFIED. Enforced in RPC/RLS on write paths for new features; read-path hiding stays client-side (leaking that a feature exists is acceptable; mutating through a disabled feature is not).
8. Verification state machine — ACCEPTED. Explicit transitions spelled out in plan; publish blocks on pending scores.
9. DB CHECKs on jsonb — ACCEPTED. CHECK/trigger validation for hole arrays + totals.
10. Versioned format config — ACCEPTED. `format_config.version` + per-format schema; results computed server-side in publish/verify RPC, not client; golden tests per format.
11. Tenant predicates on writes — ACCEPTED. Merged into existing scoping audit + adds negative tests (player cannot mutate admin tables).
12. audit_events — ACCEPTED. Lightweight audit table written by mutation RPCs.
13. Earlier integration tests — ACCEPTED. RLS/concurrency test harness moved to Phase 1–2.

Rejected: nothing. All findings were material; plan revised accordingly.

## Round 2 — Codex

Most round-1 findings addressed. Remaining material issues:

- Score lifecycle contradicts missed-week penalties: standings read "verified played only" but penalties must affect standings. Fix: consumer-specific filters — standings use effective verified played OR missed_penalty; handicap/skins/stats use verified played only.
- UNIQUE(event_id, player_id, entry_type) conflicts with "rejected kept for audit": a rejected played row blocks resubmission. Fix: mutable row with audit history, or split score_attempts from effective_scores.
- Security sequencing wrong: Phase 1 adds RPCs but member-wide RLS stays until Phase 2 — direct table writes bypass the new path. Fix: move role-split RLS/revoked direct writes into Phase 1 alongside RPC cutover.
- Multi-league scoping names only events.league_id; teams are the scoring unit and team queries are location-wide. Fix: teams.league_id or league_rosters, scope team lookups by league.
- Active/working league selection has no DB uniqueness. Fix: partial unique indexes for one active/working league per location, or clarify multiplicity.
- security definer RPCs not hardened. Fix: required template — fixed search_path, no trusted client location_id, auth.uid() checks, explicit GRANT EXECUTE, revoked base-table writes.
- submit_scores under-specified: player could submit arbitrary player_ids. Fix: derive caller/team from auth.uid(); separate admin-only RPC for edits.
- audit_events could leak PII in before/after JSON. Fix: admin-only access, redact secrets/PII, retention rules.

VERDICT: REVISE

### Claude's response

Accepted 8/8 (one modified):
1. Consumer-specific filters — ACCEPTED. State machine rewritten: standings = effective (verified played ∪ missed_penalty); handicap/skins/stats = verified played only.
2. Rejected-row conflict — ACCEPTED MODIFIED. Partial unique index `(event_id, player_id, entry_type) WHERE status <> 'rejected'` instead of a two-table split — rejected rows stay for audit without blocking resubmission; simpler than score_attempts/effective_scores.
3. Security sequencing — ACCEPTED. Role-split RLS + revoke of direct writes on scores/events moved into Phase 1 with the RPC cutover; full-surface RLS overhaul remains Phase 2.
4. teams.league_id — ACCEPTED. Backfill/require teams.league_id; scope team lookups by league in AdminScores/Standings/ScoreEntry.
5. League uniqueness — ACCEPTED. Partial unique index: one working league per (location) — active leagues may be several (e.g. Mon + Wed nights); routing selects by the league the player's team belongs to. Clarified in plan.
6. RPC hardening template — ACCEPTED. Template added to architectural spine.
7. submit_scores auth — ACCEPTED. Player RPC derives player/team from auth.uid(); admin edits via separate admin-checked RPC.
8. audit_events privacy — ACCEPTED. Admin-only RLS, PII-redacting writer, 24-month retention note.

## Round 3 — Codex

Round-2 findings mostly addressed. Remaining:

- RLS sequencing still soft: members can mutate players/teams/courses/league_config/subs until Phase 2. Fix: full role-split RLS in Phase 1, or ship 1+2 as one cutover.
- players.team_id supports one team per player; multiple active leagues make "player's league = team's league" ambiguous. Fix: league_rosters/team_memberships (player_id, team_id, league_id, effective dates); retire players.team_id as source of truth.
- missed_penalty status unspecified. Fix: publish inserts penalties as status='verified'; effective filters require verified.
- Penalty rows have no hole scores — match/stableford/scramble engines can't treat them as played. Fix: per-format no-show/forfeit semantics in format_config; convert penalties to outcomes before format math.
- Course validation vs hardcoded 9-hole ScoreEntry can break 18-hole courses. Fix: enforce 9-hole league events or make entry dynamic on num_holes.
- "Run old/new in parallel one week" contradicts revoked direct writes. Fix: shadow-compute comparison, single cutover.

VERDICT: REVISE

### Claude's response

Accepted 6/6:
1. RLS sequencing — ACCEPTED. Full role-split RLS for all admin-owned tables moves into Phase 1 (it's policy SQL, not UI work). Phase 2 keeps player_public view, legacy-table cleanup, boot resolver, flags.
2. Team memberships — ACCEPTED. New `team_memberships` (player_id, team_id, league_id, effective_from/to) becomes source of truth; `players.team_id` retired to a backfilled legacy column. Also powers Phase 5 mid-season swaps.
3. Penalty status — ACCEPTED. Penalties insert as `status='verified'`; all effective filters require verified.
4. Per-format penalty semantics — ACCEPTED. `format_config` gains no_show policy (forfeit/zero-points/half-points); publish converts penalties to format outcomes before math.
5. Hole-count dynamic — ACCEPTED. ScoreEntry/AdminScores iterate `course.num_holes` instead of hardcoded 9; DB validates score-array length == num_holes. Out-of-scope line clarified (multi-course nights, not 18-hole rounds).
6. Cutover strategy — ACCEPTED. Replaced parallel-run with shadow-compare (new RPC dry-run vs current client math on recent events), then single cutover between league nights.

## Round 4 — Codex

Round-3 findings mostly addressed; remaining implementation traps:

- Phase 1 "revoke direct writes on every admin-owned table" breaks AdminLeague/AdminCourses direct CRUD. Fix: admin direct CRUD under role-split RLS, or admin RPCs first.
- audit_events required by Phase 1 RPCs but scheduled Phase 2. Fix: create in Phase 1.
- League identity conflicted: UI uses league_config, docs point league_id at leagues, Phase 2 may drop leagues. Fix: one canonical league table, migrate FKs, then drop/alias.
- submit_scores doesn't share publish_week's event lock → submit-vs-publish race persists. Fix: both RPCs SELECT ... FOR UPDATE the event row, recheck inside lock.
- team_memberships lacks overlap/duplicate/max-size constraints. Fix: effective-range exclusion + unique constraints + resolved roster view by event date.
- Partial index depends on scores.status which doesn't exist yet. Fix: add/backfill status NOT NULL DEFAULT 'verified' + CHECK before index.
- Blanket hole_scores length check conflicts with missed_penalty rows (no holes). Fix: separate trigger branches per entry_type.
- Current admin behavior deactivates other leagues on activation — contradicts multi-active. Fix: rewrite toggle, uniqueness only on is_working.

VERDICT: REVISE

### Claude's response

Accepted 8/8 (one clarified):
1. Admin CRUD — ACCEPTED/CLARIFIED. Revocation applies to the *player* role; admins keep direct CRUD on simple tables under admin-checked RLS policies. RPCs reserved for invariant-bearing mutations (submit, verify, publish, ledger). Plan wording fixed.
2. audit_events — ACCEPTED. Table + redacting writer helper created in Phase 1, first thing.
3. Canonical league table — ACCEPTED. `league_config` declared canonical (it's what the app uses); all new league_id FKs reference it; legacy `leagues` dropped in Phase 2 after FK migration.
4. Shared event lock — ACCEPTED. submit_scores and publish_week both `SELECT … FOR UPDATE` the event row; submit rechecks status='open' inside the lock; publish rechecks missing/pending inside the same lock.
5. Membership constraints — ACCEPTED. Exclusion constraint (no overlapping effective ranges per player+league), unique active membership per player+league, roster view resolved by event date.
6. status backfill — ACCEPTED. Migration order: add status text NOT NULL DEFAULT 'verified' CHECK (status IN (...)), backfill, then partial unique index.
7. Conditional validation — ACCEPTED. Trigger branches: entry_type='played' requires hole_scores length == num_holes; 'missed_penalty' requires hole_scores IS NULL.
8. Multi-active toggle — ACCEPTED. AdminLeague activation rewrite: multiple active leagues allowed; partial unique only on is_working per location.

## Round 5 — Codex (final round, MAX_ROUNDS=5)

Round-4 findings mostly addressed; plan much tighter. Remaining gaps:

- team_memberships constrains player-side only; a 2-player team can hold 3+ active memberships, and legacy teams.player1_id/player2_id can drift. Fix: team-side roster cardinality constraint/trigger, backfill from both legacy sources, make legacy slots read-only or a view.
- Admin direct-CRUD carveout too broad: events.status, roster changes, handicap writes are invariant/audited paths — direct admin updates bypass publish_week, audit, recalc. Fix: narrow allowlist; route those through audited RPCs or audit triggers with column-level grants.
- Internal inconsistency: audit_events says Phase 1 in spine but still listed as Phase 2 item 17. Fix: item 17 becomes "extend audit coverage."

VERDICT: REVISE

### Claude's response (final)

Accepted 3/3:
1. Team cardinality — ACCEPTED. Trigger enforces active memberships per team == team size (2); backfill from teams.player1_id/player2_id + players.team_id; legacy slot columns become read-only (kept for display until Phase 2 view replaces them).
2. Narrow CRUD allowlist — ACCEPTED. Direct admin CRUD limited to: courses, news_posts, app_events, league_config settings fields, alerts, flights, format templates. Audited-RPC-only: events.status, team_memberships/roster edits, handicap overrides + recalc, scores (all paths), ledger. Plan updated.
3. Item 17 wording — ACCEPTED. Now "extend audit coverage to Phase 2+ mutations."

## Resolution

MAX_ROUNDS (5) reached without VERDICT: APPROVED. Not presenting this as convergence-by-approval. However: every finding across all 5 rounds (13+8+6+8+3 = 38) was accepted (4 with modifications, 0 rejected), and round 5's three findings were folded into the plan after the verdict. No unresolved disagreements exist between the models — the deadlock is procedural (rounds exhausted), not substantive. Tie-break handed to Erich for final sign-off.

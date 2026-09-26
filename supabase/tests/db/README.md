# Database test harness (PostgreSQL 16)

This harness applies `supabase/migrations` to a throwaway Postgres 16 database. It then runs the app's RPCs and RLS paths as the `authenticated` and `anon` roles, the same way PostgREST does. CI runs it on every push and pull request (`.github/workflows/ci.yml`, job `db`).

## Running it
You need a Postgres 16 server you can reach as a superuser, because the shim creates roles and an `auth` schema. The connection comes from the standard libpq environment: `PGHOST`, `PGPORT`, `PGUSER` (defaults to `postgres`) and `PGPASSWORD`. With nothing set, psql's default local socket is used.

    npm run test:db                                   # = supabase/tests/db/run_all.sh
    PGHOST=/tmp PGPORT=54329 supabase/tests/db/run_all.sh
    DB=gbig_x EXCLUDE="202609230002_live_rounds.sql" supabase/tests/db/run_all.sh
    DB=x [LEGACY=1] [ONLY_COMMITTED=1] [EXCLUDE="a.sql b.sql"] supabase/tests/db/run_migrations.sh
    python3 supabase/tests/db/check_rpc_params.py gbig_ci   # client .rpc() calls vs pg_proc arg names

`run_all.sh` exits non-zero if any of these happen:
- a migration fails to apply
- the seed logs an `ERROR`
- any `harness.ok()` check fails
- a suite records no results at all

It prints a per-suite summary at the end, and full logs are written to `supabase/tests/db/logs/` (gitignored; override the location with `LOG_DIR`).

## What run_all.sh does
1. **`$DB`** (default `gbig_ci`): runs the shim, the base schema, the legacy (undated) migrations and then the dated migrations. Each file runs with `ON_ERROR_STOP`, and `logs/$DB/summary.txt` records OK or FAIL for each one. Next it loads `10_harness_helpers.sql` and seeds `20_seed.sql`.
2. It snapshots the seeded database as **`${DB}_tpl`**.
3. **`30_` to `34_tests.sql`** run in order on `$DB`, sharing state.
4. **Every `[5-9]x_*.sql` file** (`50_fix_tests.sql`, `60_*_tests.sql`, …) runs on its own fresh clone of the template, named `${DB}_<file>`. To add a suite, drop a file named like `6x_<feature>_tests.sql` into this folder; it is picked up automatically. It should expect a just-seeded database.
5. **`$LEGACY_DB`** (default `${DB}_legacy`) inserts legacy-shaped data before any migration runs, then runs `40_legacy_tests.sql`.

Every result is recorded in `harness.results` (label, pass, info) inside the database where its suite ran.

## Writing tests
Start with `\ir 29_ids.psql`, which loads the seeded ids as psql variables: `loc_a`, `loc_b`, `league_a`, `course_a`, `p1`…`p9`, `t1`…`t4`, `e1`…`e4`, `admin_a`, `u1`…`u8` and more. Then `TRUNCATE harness.results`. For each check:
- Call `harness.login(uid, email)` and then `SET ROLE authenticated` to act as a user.
- Use `harness.try(sql)` to capture `OK: <value>` or `ERR <sqlstate>: <message>`.
- Record the outcome with `harness.ok(label, condition, info)`.

`RESET ROLE` gives you the service role and superuser, which is what edge functions and the dashboard use. See `50_fix_tests.sql` or `60_archive_tests.sql` for examples.

## Files
| File | Purpose |
|---|---|
| `00_supabase_shim.sql` | Creates the anon/authenticated/service_role/authenticator roles, Supabase default grants and privileges, `auth.users`, `auth.uid/jwt/role/email` (read from `request.jwt.claims`), pgcrypto, and the `supabase_realtime` publication. |
| `01_base_schema.sql` | Reconstructed schema from before any migration (see below). |
| `05_legacy_data.sql` | Legacy data used only for `LEGACY=1`: duplicate scores, a course with only `pars int[]`, FKs pointing at `leagues`, an `admins` row, and similar. |
| `10_harness_helpers.sql` | `harness.login/logout/try/ok` and `harness.results`. |
| `20_seed.sql` | Creates 2 locations, admins A and B, a working league, a 9-hole course, 9 players in A and 2 in B (linked to auth users as the service role, the way `create-player-account` does), 4 teams and a 4-week schedule. |
| `29_ids.psql` | Loads the seeded ids into psql variables. |
| `30`–`34_tests.sql` | The main suite, grouped by feature (see the `\echo` headers). |
| `40_legacy_tests.sql` | Publishes the migrated legacy open week, then runs recalc and the player RPCs. |
| `50_fix_tests.sql` | Covers `202609230001_review_fixes.sql`. |
| `60_archive_tests.sql` | Covers `202609230004_season_archive.sql` (archive/un-archive RPC, archived ≠ working, season reads). |
| `61_checkin_tests.sql` | Covers `202609230006_bay_checkin.sql` (team check-in/move/checkout, finished-team auto-clear, partner suggestions, admin clear/clear-all/set bays, stale expiry, `sim_bay`). |
| `check_rpc_params.py` | Checks each `.rpc('name', { p_… })` call in `src/` and `supabase/functions/` against the argument names in `pg_proc`. It exits 1 on any mismatch. |

## Invented base-schema items
None of these come from a migration. Each was inferred from `SUPABASE_SCHEMA.md`, from references in the migrations, or from client code.
- **Tables:** `leagues(id,name)`, `admins(id,user_id,email,role)`, `skins`, `alerts(title,body,sent_by)`, `push_subscriptions(endpoint UNIQUE,p256dh,auth_key,user_id)`, `follows`, `messages`.
- **`league_config`:** `name, num_weeks, start_date, is_active, is_working`.
- **`courses`:** `num_holes, start_hole, hole_pars jsonb, total_par`, plus the legacy column `pars int[]`.
- **`players`, `teams`, `events`, `scores`, `handicap_history`, `news_posts`, `subs`:** columns come from the doc and client code. There is no `events.is_playoff`; `30_tests.sql` adds it as a harness-only workaround.
- **Auth seed:** the auth user `acd6c8a3-35e1-4892-a928-0a8996c02d10`, which `add_super_admins.sql` hard-codes.

## Known expectations
- The first-login "claim own profile" RLS policy was dropped on purpose in `202609230001_review_fixes.sql`. `30_tests.sql` asserts that a client-side claim updates 0 rows.

## Not covered
- The PostgREST HTTP layer. Named arguments are checked statically by `check_rpc_params.py` instead.
- Edge functions, Storage (the avatars bucket) and Realtime.
- Concurrency: the `FOR UPDATE` serialization between `submit_scores`, `publish_week` and bulk approve.
- Supabase's non-superuser `postgres` role. SECURITY DEFINER functions here are owned by a superuser, so they bypass RLS, as they do on Supabase.
- pgcrypto is installed in `public` here, not in `extensions`.

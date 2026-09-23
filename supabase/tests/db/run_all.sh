#!/usr/bin/env bash
# Full DB test run: fresh databases, migrations, harness helpers, seed, every
# test batch. Exits non-zero if a migration fails, the seed errors, or any
# harness.ok() check fails (a suite that records no results also fails).
#
#   PGHOST=/tmp PGPORT=54329 ./run_all.sh                # local cluster
#   DB=gbig_x EXCLUDE="202609230002_live_rounds.sql" ./run_all.sh
#
# Databases (all dropped + recreated each run):
#   $DB          main suite: 30_ … 34_tests.sql, in order, sharing state
#   $DB_tpl      migrated + seeded snapshot, cloned for each isolated suite
#   $DB_<file>   one fresh clone per [5-9]x_*.sql file (50_fix_tests.sql,
#                60_*_tests.sql, …) — each expects a just-seeded database
#   $LEGACY_DB   legacy-shaped data before migrations, 40_legacy_tests.sql
set -u
H="$(cd "$(dirname "$0")" && pwd)"
cd "$H"
export PGUSER="${PGUSER:-postgres}"
export DB=${DB:-gbig_ci}
LEGACY_DB=${LEGACY_DB:-${DB}_legacy}
TPL="${DB}_tpl"
export LOG_DIR="${LOG_DIR:-$H/logs}"
PSQL="psql -X"
# psql command tags that are just noise in the test logs
F='^(SET|RESET|ALTER TABLE|INSERT 0 1|DELETE 1|UPDATE [0-9]+|TRUNCATE TABLE|CREATE [A-Z]+|GRANT|Pager usage is off\.|)$'
FAILED=0
SUMMARY=()

# Tally harness.results in a DB; any failure (or no results at all) fails the run.
tally() {
  local db="$1" suite="$2" counts pass fail
  counts=$($PSQL -d "$db" -At -F ' ' -c "SELECT count(*) FILTER (WHERE pass), count(*) FILTER (WHERE NOT pass) FROM harness.results" 2>/dev/null)
  pass=${counts% *}; fail=${counts#* }
  if [ -z "$counts" ]; then pass=0; fail='?'; fi
  SUMMARY+=("$suite: $pass passed, $fail failed")
  if [ "$fail" != "0" ] || [ "$pass" = "0" ]; then
    FAILED=1
    while IFS= read -r line; do SUMMARY+=("  $line"); done < <(
      $PSQL -d "$db" -At -c "SELECT 'FAIL: ' || label || ' :: ' || COALESCE(info, '') FROM harness.results WHERE NOT pass ORDER BY n" 2>/dev/null)
  fi
}

run_file() {   # db file log
  $PSQL -d "$1" -f "$2" 2>&1 | grep -vE "$F" | tee "$3"
}

# 1) main DB: migrations, helpers, seed
if ! ./run_migrations.sh; then FAILED=1; SUMMARY+=("migrations ($DB): FAILED — see $LOG_DIR/$DB/summary.txt"); fi
LOG="$LOG_DIR/$DB"
$PSQL -q -d "$DB" -f 10_harness_helpers.sql 2>&1 | grep -v NOTICE
$PSQL -d "$DB" -f 20_seed.sql > "$LOG/seed.log" 2>&1
if grep -q 'ERROR' "$LOG/seed.log"; then
  FAILED=1; SUMMARY+=("seed: ERROR — $(grep -m1 ERROR "$LOG/seed.log")")
fi

# Snapshot the seeded DB for the isolated suites before the main suite mutates it.
$PSQL -q -d postgres -c "DROP DATABASE IF EXISTS \"$TPL\" WITH (FORCE)" -c "CREATE DATABASE \"$TPL\" TEMPLATE \"$DB\""

# 2) main suite (the batches share state, so they run in order on one DB)
for t in 30 31 32 33 34; do
  run_file "$DB" "${t}_tests.sql" "$LOG/tests_${t}.log"
done
tally "$DB" "30-34 main suite ($DB)"

# 3) isolated suites: 50_fix_tests.sql, 6x_*_tests.sql, … each on a fresh clone
for f in [5-9][0-9]_*.sql; do
  [ -e "$f" ] || continue
  name=$(basename "$f" .sql)
  clone="${DB}_$(echo "$name" | tr -c 'a-zA-Z0-9_\n' '_' | cut -c1-40)"
  $PSQL -q -d postgres -c "DROP DATABASE IF EXISTS \"$clone\" WITH (FORCE)" -c "CREATE DATABASE \"$clone\" TEMPLATE \"$TPL\""
  run_file "$clone" "$f" "$LOG/$name.log"
  tally "$clone" "$f ($clone)"
done

# 4) legacy-shaped data run (exercises backfills / data gates)
if ! DB="$LEGACY_DB" LEGACY=1 ./run_migrations.sh; then FAILED=1; SUMMARY+=("migrations ($LEGACY_DB): FAILED — see $LOG_DIR/$LEGACY_DB/summary.txt"); fi
run_file "$LEGACY_DB" 40_legacy_tests.sql "$LOG_DIR/$LEGACY_DB/tests_40.log"
tally "$LEGACY_DB" "40 legacy suite ($LEGACY_DB)"

echo; echo "=== SUMMARY ==="
printf '%s\n' "${SUMMARY[@]}"
if [ "$FAILED" -ne 0 ]; then echo "RESULT: FAILED"; exit 1; fi
echo "RESULT: all passed"

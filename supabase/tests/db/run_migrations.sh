#!/usr/bin/env bash
# Recreate one database and apply shim + base schema + every repo migration.
# Usage: DB=name [LEGACY=1] [ONLY_COMMITTED=1] [EXCLUDE="a.sql b.sql"] ./run_migrations.sh [--stop-on-fail]
# Connection comes from the usual libpq env (PGHOST / PGPORT / PGUSER /
# PGPASSWORD); PGUSER defaults to postgres (needs superuser: the shim creates
# roles and the auth schema). Exits non-zero if any file failed to apply.
set -u
H="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$H/../../.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations"
export PGUSER="${PGUSER:-postgres}"
DB=${DB:-gbig_ci}
PSQL="psql -X -q"
STOP=${1:-}
LOG="${LOG_DIR:-$H/logs}/$DB"; mkdir -p "$LOG"
: > "$LOG/summary.txt"
FAILS=0

$PSQL -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" -c "CREATE DATABASE \"$DB\"" || exit 1

apply() {
  local f="$1" name; name=$(basename "$f")
  if $PSQL -d "$DB" -v ON_ERROR_STOP=1 -f "$f" > "$LOG/$name.log" 2>&1; then
    echo "OK    $name" | tee -a "$LOG/summary.txt"
  else
    FAILS=$((FAILS + 1))
    echo "FAIL  $name :: $(grep -m1 -E 'ERROR' "$LOG/$name.log")" | tee -a "$LOG/summary.txt"
    [ "$STOP" = "--stop-on-fail" ] && exit 1
  fi
}

apply "$H/00_supabase_shim.sql"
apply "$H/01_base_schema.sql"
if [ "${LEGACY:-0}" = "1" ]; then apply "$H/05_legacy_data.sql"; fi

# Legacy (undated) migrations, in git-history order
for f in add_multi_location_safe.sql enable_rls_phase1.sql add_missed_week_penalty.sql \
         add_location_logos.sql data_model_cleanup.sql add_alerts_expires_at.sql \
         add_super_admins.sql add_events_signups.sql; do
  apply "$MIG/$f"
done

# Dated migrations in name order. ONLY_COMMITTED=1 skips untracked files;
# EXCLUDE drops named files (e.g. a half-written migration).
if [ "${ONLY_COMMITTED:-0}" = "1" ]; then
  DATED=$(git -C "$REPO_ROOT" ls-files supabase/migrations | xargs -n1 basename | grep -E '^20[0-9]{6}' | sort)
else
  DATED=$(ls "$MIG" | grep -E '^20[0-9]{6}.*\.sql$' | sort)
fi
[ -n "${EXCLUDE:-}" ] && DATED=$(echo "$DATED" | grep -vxF -e "${EXCLUDE// /$'\n'}")
for f in $DATED; do
  apply "$MIG/$f"
  # Optional harness-only patch applied right after a specific migration
  if [ -f "$H/patches/after_$f" ]; then apply "$H/patches/after_$f"; fi
done

[ "$FAILS" -eq 0 ]

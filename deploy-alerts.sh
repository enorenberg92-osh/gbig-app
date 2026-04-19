#!/bin/bash
# ─────────────────────────────────────────────────────────
#  GBIG — Deploy Alerts Edge Functions
#
#  Reads VAPID_* secrets from the environment (never from this file).
#  Generate new keys with:   npx web-push generate-vapid-keys
#
#  Run:
#    PROJECT_REF=mtuzmasicpcxcvtslevm \
#    VAPID_PUBLIC_KEY=... \
#    VAPID_PRIVATE_KEY=... \
#    VAPID_EMAIL=admin@your-domain.com \
#      bash deploy-alerts.sh
# ─────────────────────────────────────────────────────────
set -euo pipefail

PROJECT_REF="${PROJECT_REF:-mtuzmasicpcxcvtslevm}"

require_var() {
  if [ -z "${!1:-}" ]; then
    echo "❌  Missing env var: $1"
    echo "    See header of this script for required variables."
    exit 1
  fi
}

require_var VAPID_PUBLIC_KEY
require_var VAPID_PRIVATE_KEY
require_var VAPID_EMAIL

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Alerts — Edge Function Deployment"
echo "  Project: $PROJECT_REF"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 1. Check Supabase CLI is installed
if ! command -v supabase &> /dev/null; then
  echo "❌  Supabase CLI not found."
  echo "    Mac:     brew install supabase/tap/supabase"
  echo "    Windows: scoop install supabase"
  echo "             (or download from https://github.com/supabase/cli/releases)"
  exit 1
fi

echo "✅  Supabase CLI found: $(supabase --version)"

# 2. Login (will open browser if not already logged in)
echo "▶  Logging in to Supabase..."
supabase login

# 3. Deploy the functions
echo "▶  Deploying send-alert function..."
supabase functions deploy send-alert --project-ref "$PROJECT_REF"

echo "▶  Deploying send-social-push function..."
supabase functions deploy send-social-push --project-ref "$PROJECT_REF"

# 4. Set VAPID secrets
echo "▶  Setting VAPID secrets..."
supabase secrets set \
  VAPID_PUBLIC_KEY="$VAPID_PUBLIC_KEY" \
  VAPID_PRIVATE_KEY="$VAPID_PRIVATE_KEY" \
  VAPID_EMAIL="$VAPID_EMAIL" \
  --project-ref "$PROJECT_REF"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅  Done! Push notifications are live."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Remember: if you rotated the VAPID keys, update VITE_VAPID_PUBLIC_KEY"
echo "in every location's .env.local and redeploy the web app."
echo ""

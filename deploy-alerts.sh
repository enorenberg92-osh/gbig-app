#!/bin/bash
# ─────────────────────────────────────────────────────────
#  GBIG — Deploy Alerts Edge Function
#  Run this once from inside the gbig-app folder:
#    bash deploy-alerts.sh
# ─────────────────────────────────────────────────────────

PROJECT_REF="mtuzmasicpcxcvtslevm"

VAPID_PUBLIC="BMGFvooGfypUObkswA1564UrONV4h3KOKcJcGojmo-v5KlnFwDX2jWpWEWCkKTGiNbHxdo0HHnhGpsk2DxBdzkw"
VAPID_PRIVATE="ThkvK3QTx5Z_tFH9EH43vKFFIzp-OXoYqeCX8VTDGvQ"
VAPID_EMAIL="admin@greenbayindoorgolf.com"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  GBIG Alerts — Edge Function Deployment"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 1. Check Supabase CLI is installed
if ! command -v supabase &> /dev/null; then
  echo "❌  Supabase CLI not found."
  echo ""
  echo "   Install it first, then re-run this script:"
  echo ""
  echo "   Mac:     brew install supabase/tap/supabase"
  echo "   Windows: scoop install supabase"
  echo "            (or download from https://github.com/supabase/cli/releases)"
  echo ""
  exit 1
fi

echo "✅  Supabase CLI found: $(supabase --version)"
echo ""

# 2. Login (will open browser if not already logged in)
echo "▶  Logging in to Supabase..."
supabase login
echo ""

# 3. Deploy the function
echo "▶  Deploying send-alert function..."
supabase functions deploy send-alert --project-ref $PROJECT_REF
echo ""

# 4. Set VAPID secrets
echo "▶  Setting VAPID secrets..."
supabase secrets set VAPID_PUBLIC_KEY="$VAPID_PUBLIC" --project-ref $PROJECT_REF
supabase secrets set VAPID_PRIVATE_KEY="$VAPID_PRIVATE" --project-ref $PROJECT_REF
supabase secrets set VAPID_EMAIL="$VAPID_EMAIL" --project-ref $PROJECT_REF
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅  All done! Push notifications are live."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

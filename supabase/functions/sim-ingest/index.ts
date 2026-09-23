// Supabase Edge Function — sim-ingest
//
// Hole-by-hole scores from the simulator software (or any trusted bay PC).
// Each finished hole is POSTed here and lands on the player's live card, so
// the Tonight leaderboard updates in realtime. When the round is done the sim
// sends { finalize: true } and the team's pending submission is created —
// exactly what the Submit button in the app would create. Admins then review
// it as usual. Full docs: docs/SIM_INTEGRATION.md
//
// Auth: a per-location API key (NOT a user JWT), sent as
//   Authorization: Bearer gbig_sim_…      or      x-api-key: gbig_sim_…
// Keys are created/rotated by a location admin with
//   select admin_create_location_api_key('<location uuid>');
// Only the SHA-256 of the key is stored; we hash here and the database
// resolves the key to its location.
//
// Body (JSON):
//   { player_id | player_email, hole, strokes, bay?, event_id?, finalize? }
//   { player_id | player_email, holes: [{hole, strokes}, …], … }   (catch-up)
//   { player_id | player_email, finalize: true }
//
// All validation and writes happen in public.sim_ingest (service-role only),
// which shares its code path with the app's record_live_hole RPC.
//
// Deploy: supabase functions deploy sim-ingest --project-ref mtuzmasicpcxcvtslevm --no-verify-jwt
// (--no-verify-jwt is required: callers present an API key, not a Supabase JWT.)

import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-api-key, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// SQLSTATEs raised on purpose by public.sim_ingest / its helpers.
const CLIENT_ERRORS = new Set(['22023', '22P02', 'P0001'])

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405)

  try {
    const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
    const apiKey = (req.headers.get('x-api-key') || bearer).trim()
    if (!apiKey || !apiKey.startsWith('gbig_')) return json({ error: 'Missing API key' }, 401)

    let payload: Record<string, unknown>
    try {
      payload = await req.json()
    } catch {
      return json({ error: 'Body must be JSON' }, 400)
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return json({ error: 'Body must be a JSON object' }, 400)
    }

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    )

    const keyHash = await sha256Hex(apiKey)
    const call = () => admin.rpc('sim_ingest', { p_key_hash: keyHash, p_payload: payload })
    let { data, error } = await call()
    // Deadlock / serialization conflict with a concurrent bay: safe to retry once.
    if (error && (error.code === '40P01' || error.code === '40001')) {
      ({ data, error } = await call())
    }

    if (error) {
      if (error.code === '28000') return json({ error: 'Invalid API key' }, 401)
      if (CLIENT_ERRORS.has(error.code || '')) return json({ error: error.message }, 422)
      console.error('sim-ingest rpc error:', error)
      return json({ error: 'Could not record the score. Try again.' }, 500)
    }

    return json({ ok: true, ...data })
  } catch (e) {
    console.error('sim-ingest error:', e)
    return json({ error: 'Could not record the score. Try again.' }, 500)
  }
})

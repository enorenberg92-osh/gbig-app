// Supabase Edge Function — create-player-account
//
// Creates a Supabase auth user for a `players` row so that player can log in.
// Called by AdminPlayers when an admin adds (or retroactively enables) a player.
//
// Security model:
//   1. Caller must pass their user JWT in Authorization.
//   2. Caller must be an admin for the target player's location (location_admins).
//   3. Only then do we use the service-role key to create the auth user + link.
//
// Deploy: supabase functions deploy create-player-account --project-ref mtuzmasicpcxcvtslevm

import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { player_id, email, password } = await req.json()
    if (!player_id || !email || !password) return json({ error: 'missing fields' }, 400)

    const url         = Deno.env.get('SUPABASE_URL')!
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey     = Deno.env.get('SUPABASE_ANON_KEY')!
    const clean       = email.toLowerCase().trim()

    // ── 1. Identify the caller from their JWT ──────────────────────────────
    const authHeader = req.headers.get('Authorization') || ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (!jwt) return json({ error: 'Missing Authorization header' }, 401)

    const userClient = createClient(url, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser(jwt)
    if (userErr || !userData?.user) return json({ error: 'Invalid session' }, 401)
    const callerUserId = userData.user.id

    // ── 2. Look up the target player's location ────────────────────────────
    const admin = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: targetPlayer, error: targetErr } = await admin
      .from('players')
      .select('id, location_id')
      .eq('id', player_id)
      .maybeSingle()

    if (targetErr) throw targetErr
    if (!targetPlayer) return json({ error: 'Player not found' }, 404)

    // ── 3. Verify caller is an admin for THAT location ─────────────────────
    const { data: adminRow, error: adminErr } = await admin
      .from('location_admins')
      .select('role')
      .eq('user_id', callerUserId)
      .eq('location_id', targetPlayer.location_id)
      .maybeSingle()

    if (adminErr) throw adminErr
    if (!adminRow) return json({ error: 'Not authorized for this location' }, 403)

    // ── 4. Create the auth user (or look up existing) ──────────────────────
    let r1 = await fetch(url + '/auth/v1/admin/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + serviceKey,
        'apikey': serviceKey,
      },
      body: JSON.stringify({ email: clean, password, email_confirm: true }),
    })
    let b1 = await r1.json()
    console.log('[create-player-account] createUser status', r1.status)

    if (!r1.ok && (b1.message || '').toLowerCase().includes('already')) {
      const listRes = await fetch(
        url + '/auth/v1/admin/users?email=' + encodeURIComponent(clean),
        { headers: { 'Authorization': 'Bearer ' + serviceKey, 'apikey': serviceKey } }
      )
      const listBody = await listRes.json()
      const existing = (listBody.users || []).find((u: { email: string }) => u.email === clean)
      if (existing) {
        b1 = existing
      } else {
        return json({ error: b1.message || 'create failed' }, 400)
      }
    } else if (!r1.ok) {
      return json({ error: b1.message || 'create failed' }, 400)
    }

    // ── 5. Link the player row to the auth user ────────────────────────────
    const { error: linkErr } = await admin
      .from('players')
      .update({ user_id: b1.id, email: clean })
      .eq('id', player_id)
    if (linkErr) throw linkErr

    console.log('[create-player-account] linked player', player_id, '→ user', b1.id)
    return json({ success: true, user_id: b1.id })

  } catch (e) {
    console.error('[create-player-account] fatal:', String(e))
    return json({ error: String(e) }, 500)
  }
})

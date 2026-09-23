// Supabase Edge Function — create-player-account
//
// Creates (or reuses) a Supabase auth user for a `players` row so that player
// can log in. Called by AdminPlayers when an admin adds a player, or clicks
// "Create Account" on a player that was added without an email.
//
// Modes (request body):
//   create (default): { player_id, email, password }
//     Creates the auth user with `password`, or links an existing auth user
//     with that email WITHOUT touching its password.
//   reset_password:   { mode: 'reset_password', player_id, password }
//     Sets a new password on the player's already-linked auth user. The
//     password is never stored on the players row (league_password is
//     readable location-wide, so it is no longer used).
//
// Security model:
//   1. Caller must pass their user JWT in Authorization.
//   2. Caller must be an admin for the target player's location (location_admins)
//      OR a super-admin (super_admins).
//   3. Only then do we use the service-role key to create the auth user + link.
//
// Orphan-prevention design:
//   We look up any existing auth user by email BEFORE attempting to create
//   one. That avoids depending on the fragile "create fails with already-
//   exists → fall back to lookup" path that previously left orphan auth users
//   behind. If the player-link UPDATE fails AFTER we created a fresh auth
//   user, we delete that auth user as a rollback so we never leak records.
//
// Deploy: supabase functions deploy create-player-account --project-ref mtuzmasicpcxcvtslevm --no-verify-jwt
//
// IMPORTANT — the --no-verify-jwt flag is REQUIRED, not optional:
//   Supabase's platform-level JWT verifier uses HS256, but Supabase user
//   tokens are signed with ES256. Without --no-verify-jwt, the platform
//   rejects every authenticated request with a bare 401 before our code
//   runs, and the client just sees "account creation failed: 401" with no
//   context. The flag disables *platform* verification only; authorization
//   is fully enforced inside this function via getUser(jwt) plus the
//   location_admins / super_admins membership check below.

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

const MIN_PASSWORD_LENGTH = 6

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { player_id, email, password: rawPassword, mode } = await req.json()
    // Trim like LoginScreen does, so a stray keyboard space can't lock anyone out.
    const password = typeof rawPassword === 'string' ? rawPassword.trim() : rawPassword
    const isReset = mode === 'reset_password'
    if (mode != null && !isReset && mode !== 'create') return json({ error: 'unknown mode' }, 400)
    if (!player_id || !password || (!isReset && !email)) return json({ error: 'missing fields' }, 400)
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, 400)
    }

    const url        = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey    = Deno.env.get('SUPABASE_ANON_KEY')!
    const clean      = String(email || '').toLowerCase().trim()

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
      .select('id, location_id, user_id')
      .eq('id', player_id)
      .maybeSingle()

    if (targetErr) throw targetErr
    if (!targetPlayer) return json({ error: 'Player not found' }, 404)

    // ── 3. Verify caller is an admin for THAT location ─────────────────────
    // Super-admins are allowed to hit this from any location; location admins
    // must match the target's location.
    const [adminRowRes, superRes] = await Promise.all([
      admin.from('location_admins')
        .select('role')
        .eq('user_id', callerUserId)
        .eq('location_id', targetPlayer.location_id)
        .maybeSingle(),
      admin.from('super_admins')
        .select('user_id')
        .eq('user_id', callerUserId)
        .maybeSingle(),
    ])
    if (adminRowRes.error) throw adminRowRes.error
    const isLocationAdmin = !!adminRowRes.data
    const isSuperAdmin    = !!superRes.data
    if (!isLocationAdmin && !isSuperAdmin) {
      return json({ error: 'Not authorized for this location' }, 403)
    }

    // ── 3b. Reset mode: set a new password on the linked auth user ─────────
    if (isReset) {
      if (!targetPlayer.user_id) {
        return json({ error: 'This player has no login account yet — create one first' }, 400)
      }
      const targetUserId = targetPlayer.user_id

      // The same auth user can also be an admin (or a player elsewhere). A
      // location admin must not be able to take over an account that has
      // more reach than their own, so every location the target user is
      // attached to must be one the caller administers (super-admins skip).
      if (!isSuperAdmin) {
        const [targetSuper, targetAdminLocs, targetPlayerLocs, callerAdminLocs] = await Promise.all([
          admin.from('super_admins').select('user_id').eq('user_id', targetUserId).maybeSingle(),
          admin.from('location_admins').select('location_id').eq('user_id', targetUserId),
          admin.from('players').select('location_id').eq('user_id', targetUserId),
          admin.from('location_admins').select('location_id').eq('user_id', callerUserId),
        ])
        for (const r of [targetSuper, targetAdminLocs, targetPlayerLocs, callerAdminLocs]) {
          if (r.error) throw r.error
        }
        const callerLocs = new Set((callerAdminLocs.data || []).map((r) => r.location_id))
        const targetLocs = [
          ...(targetAdminLocs.data || []),
          ...(targetPlayerLocs.data || []),
        ].map((r) => r.location_id)
        if (targetSuper.data || targetLocs.some((loc) => !callerLocs.has(loc))) {
          return json({ error: 'This account is linked outside your locations; ask a super-admin to reset it' }, 403)
        }
      }

      const { error: resetErr } = await admin.auth.admin.updateUserById(targetUserId, { password })
      if (resetErr) return json({ error: resetErr.message }, 400)
      console.log('[create-player-account] reset password for player', player_id)
      return json({ success: true, user_id: targetUserId, reset: true })
    }

    // ── 4. Lookup-first: does an auth user with this email already exist? ──
    // Using the SDK's listUsers rather than the raw ?email= querystring — the
    // querystring doesn't actually filter on current GoTrue versions, which
    // is what caused previous "create account" clicks to leave orphan users.
    //
    // perPage 1000 handles any realistic tenant size; we page only if needed.
    let existingUser: { id: string; email?: string } | null = null
    for (let page = 1; page < 10 && !existingUser; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
      if (error) throw error
      existingUser = (data?.users || []).find(
        (u) => (u.email || '').toLowerCase() === clean
      ) || null
      if (!data?.users?.length || data.users.length < 1000) break
    }

    let authUserId: string
    let createdNewAuthUser = false

    if (existingUser) {
      // Deliberately leave the existing user's password alone — resetting it
      // is only done through the explicit reset_password mode above.
      authUserId = existingUser.id
      console.log('[create-player-account] reusing existing auth user', authUserId)
    } else {
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: clean,
        password,
        email_confirm: true,
      })
      if (createErr) return json({ error: createErr.message }, 400)
      // Supabase JS always returns { user: {...} } from createUser; read user.id.
      authUserId = created?.user?.id || ''
      if (!authUserId) return json({ error: 'createUser returned no user id' }, 500)
      createdNewAuthUser = true
      console.log('[create-player-account] created new auth user', authUserId)
    }

    // ── 5. Link the player row to the auth user ────────────────────────────
    // If this UPDATE fails AFTER we just created a fresh auth user, roll it
    // back by deleting the auth user. Otherwise we leak orphans (which is the
    // exact bug that stranded Jordan's account on 2026-04-20).
    const { error: linkErr } = await admin
      .from('players')
      .update({ user_id: authUserId, email: clean })
      .eq('id', player_id)

    if (linkErr) {
      if (createdNewAuthUser) {
        console.warn('[create-player-account] link failed, rolling back auth user', authUserId)
        await admin.auth.admin.deleteUser(authUserId).catch((e) =>
          console.warn('[create-player-account] rollback deleteUser failed:', String(e))
        )
      }
      throw linkErr
    }

    console.log('[create-player-account] linked player', player_id, '→ user', authUserId)
    return json({ success: true, user_id: authUserId, reused: !createdNewAuthUser })

  } catch (e) {
    // Log the detail server-side; never echo internals to the client.
    console.error('[create-player-account] fatal:', String(e))
    return json({ error: 'Account request failed due to a server error' }, 500)
  }
})

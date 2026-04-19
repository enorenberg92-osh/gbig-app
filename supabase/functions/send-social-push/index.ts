// Supabase Edge Function — send-social-push
//
// Sends a targeted push notification to one player's devices, triggered by
// social events (follow, friend, message).
//
// Security model:
//   1. Caller must pass their user JWT in Authorization.
//   2. We resolve caller -> players row (via user_id) to get caller.location_id.
//   3. Target player must be in the same location_id as the caller.
//   4. Fan-out is restricted to push_subscriptions for that target's user_id
//      AND that location_id (belt + suspenders).
//
// Deploy:  supabase functions deploy send-social-push --project-ref mtuzmasicpcxcvtslevm
// Secrets: same VAPID_* secrets as send-alert

import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

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
    const { target_player_id, title, body } = await req.json()
    if (!target_player_id || !title || !body) {
      return json({ error: 'target_player_id, title, and body are required' }, 400)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey     = Deno.env.get('SUPABASE_ANON_KEY')!
    const vapidPub    = Deno.env.get('VAPID_PUBLIC_KEY')!
    const vapidPriv   = Deno.env.get('VAPID_PRIVATE_KEY')!
    const vapidEmail  = Deno.env.get('VAPID_EMAIL') || 'no-reply@example.com'

    // ── 1. Identify caller ──────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') || ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (!jwt) return json({ error: 'Missing Authorization header' }, 401)

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser(jwt)
    if (userErr || !userData?.user) return json({ error: 'Invalid session' }, 401)
    const callerUserId = userData.user.id

    // ── 2. Look up caller's player record for their location_id ─────────────
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: callerPlayer, error: callerErr } = await admin
      .from('players')
      .select('id, location_id')
      .eq('user_id', callerUserId)
      .maybeSingle()

    if (callerErr) throw callerErr
    if (!callerPlayer?.location_id) {
      return json({ error: 'Caller has no linked player record' }, 403)
    }

    // ── 3. Verify target is in the SAME location ────────────────────────────
    const { data: target, error: targetErr } = await admin
      .from('players')
      .select('id, user_id, location_id')
      .eq('id', target_player_id)
      .maybeSingle()

    if (targetErr) throw targetErr
    if (!target) return json({ error: 'Target player not found' }, 404)
    if (target.location_id !== callerPlayer.location_id) {
      return json({ error: 'Cross-location pushes are not permitted' }, 403)
    }
    if (!target.user_id) {
      return json({ ok: true, sent: 0, fails: 0, message: 'Target has no linked account' })
    }

    // ── 4. Load subscriptions for target user, scoped to location ───────────
    const { data: subs, error: subErr } = await admin
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth_key')
      .eq('user_id', target.user_id)
      .eq('location_id', callerPlayer.location_id)

    if (subErr) throw subErr

    if (!subs || subs.length === 0) {
      return json({ ok: true, sent: 0, fails: 0, message: 'No subscriptions for target' })
    }

    // ── 5. Fan out ──────────────────────────────────────────────────────────
    webpush.setVapidDetails(`mailto:${vapidEmail}`, vapidPub, vapidPriv)

    const payload = JSON.stringify({ title, body })
    const results = await Promise.allSettled(
      subs.map(s =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
          payload
        )
      )
    )

    const expired: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const code = (r.reason as { statusCode?: number })?.statusCode
        console.error(`[send-social-push] sub ${i} failed statusCode=${code}`)
        if (code === 410) expired.push(subs[i].endpoint)
      }
    })

    if (expired.length) {
      await admin.from('push_subscriptions').delete().in('endpoint', expired)
    }

    const sent  = results.filter(r => r.status === 'fulfilled').length
    const fails = results.filter(r => r.status === 'rejected').length
    return json({ ok: true, sent, fails })

  } catch (e) {
    console.error('[send-social-push] fatal:', String(e))
    return json({ error: String(e) }, 500)
  }
})

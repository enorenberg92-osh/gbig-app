// Supabase Edge Function — send-social-push
//
// Sends a targeted push notification to one player's devices, triggered by
// social events (follow, friend, message).
//
// Request body: { target_player_id, type: 'follow' | 'message', preview? }
// Title/body are built HERE — callers can't relay arbitrary text.
//
// Security model:
//   1. Caller must pass their user JWT in Authorization.
//   2. We resolve caller -> players row (via user_id) to get caller.location_id.
//   3. Target player must be in the same location_id as the caller.
//   4. The location's 'friends' feature must be enabled.
//   5. 'follow' requires the caller to actually follow the target; 'message'
//      requires a follow in either direction. Message previews are truncated.
//   6. Fan-out is restricted to push_subscriptions for that target's user_id
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PREVIEW_MAX = 120

type PlayerName = { first_name?: string | null; last_name?: string | null; name?: string | null }
const displayName = (p: PlayerName) =>
  (p.first_name ? `${p.first_name} ${p.last_name || ''}`.trim() : p.name) || 'A player'

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { target_player_id, type, preview } = await req.json()
    if (typeof target_player_id !== 'string' || !UUID_RE.test(target_player_id)) {
      return json({ error: 'A valid target_player_id is required' }, 400)
    }
    if (type !== 'follow' && type !== 'message') {
      return json({ error: "type must be 'follow' or 'message'" }, 400)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey     = Deno.env.get('SUPABASE_ANON_KEY')!
    const vapidPub    = Deno.env.get('VAPID_PUBLIC_KEY')!
    const vapidPriv   = Deno.env.get('VAPID_PRIVATE_KEY')!
    const vapidEmail  = Deno.env.get('VAPID_EMAIL')
    // Fail loudly if VAPID_EMAIL is unset — placeholder domains are a known
    // deliverability-flag trigger on Android FCM + Apple Web Push.
    if (!vapidEmail || vapidEmail.endsWith('example.com') || !vapidEmail.includes('@')) {
      return json({ error: 'VAPID_EMAIL secret must be set to a real admin email' }, 500)
    }

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
      .select('id, location_id, first_name, last_name, name')
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
    if (target.id === callerPlayer.id) return json({ error: 'Cannot notify yourself' }, 400)

    // ── 3b. Social must be enabled for this location ────────────────────────
    // Called as the user: check_feature_enabled is granted to authenticated.
    const { data: friendsOn, error: featErr } = await userClient.rpc('check_feature_enabled', {
      p_location_id: callerPlayer.location_id,
      p_league_id:   null,
      p_key:         'friends',
    })
    if (featErr) throw featErr
    if (friendsOn === false) return json({ error: 'Social features are disabled' }, 403)

    // ── 3c. Require a real follow relationship ──────────────────────────────
    const { data: links, error: linkErr } = await admin
      .from('follows')
      .select('follower_id, following_id')
      .or(
        `and(follower_id.eq.${callerPlayer.id},following_id.eq.${target.id}),` +
        `and(follower_id.eq.${target.id},following_id.eq.${callerPlayer.id})`
      )
    if (linkErr) throw linkErr
    const callerFollows = (links || []).some(l => l.follower_id === callerPlayer.id)
    const targetFollows = (links || []).some(l => l.follower_id === target.id)
    if (type === 'follow' && !callerFollows) {
      return json({ error: 'You do not follow this player' }, 403)
    }
    if (type === 'message' && !callerFollows && !targetFollows) {
      return json({ error: 'You are not connected with this player' }, 403)
    }

    // ── 3d. Build the notification text server-side ─────────────────────────
    const myName = displayName(callerPlayer)
    let title: string
    let body: string
    if (type === 'follow') {
      title = targetFollows ? '🤝 New Friend!' : '👥 New Follower'
      body  = targetFollows
        ? `You and ${myName} are now mutual followers!`
        : `${myName} started following you.`
    } else {
      const text = typeof preview === 'string' ? preview.replace(/\s+/g, ' ').trim() : ''
      title = `💬 ${myName}`
      body  = text
        ? (text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) + '…' : text)
        : 'Sent you a message'
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

    // Payload mirrors public/sw.js. Tag + url + icon help native OS
    // renderers show a full branded notification rather than a generic fallback.
    const payload = JSON.stringify({
      title,
      body,
      tag:  'gbig-social',
      url:  '/league/friends',
      icon: '/icon-192.png',
    })

    // TTL 24h, urgency high — social pings are time-sensitive and
    // user-visible (not marketing), which is the correct urgency class.
    const pushOptions = { TTL: 60 * 60 * 24, urgency: 'high' as const }

    const results = await Promise.allSettled(
      subs.map(s =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
          payload,
          pushOptions
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
    // Log the detail server-side; never echo internals to the caller.
    console.error('[send-social-push] fatal:', e)
    return json({ error: 'Could not send notification' }, 500)
  }
})

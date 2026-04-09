// Supabase Edge Function — send-social-push
// Sends a push notification to a specific player's devices (by player_id).
// Used for social events: follows, mutual-follow (friend), messages.
//
// Deploy:  supabase functions deploy send-social-push --project-ref mtuzmasicpcxcvtslevm
// Secrets: same VAPID_* secrets as send-alert (already set)

import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { target_player_id, title, body } = await req.json()
    if (!target_player_id || !title || !body) {
      return new Response(
        JSON.stringify({ error: 'target_player_id, title, and body are required' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const vapidPub    = Deno.env.get('VAPID_PUBLIC_KEY')!
    const vapidPriv   = Deno.env.get('VAPID_PRIVATE_KEY')!
    const vapidEmail  = Deno.env.get('VAPID_EMAIL') || 'admin@greenbayindoorgolf.com'

    webpush.setVapidDetails(`mailto:${vapidEmail}`, vapidPub, vapidPriv)

    const supabase = createClient(supabaseUrl, serviceKey)

    // 1. Look up the auth user_id for this player
    const { data: player, error: playerErr } = await supabase
      .from('players')
      .select('user_id')
      .eq('id', target_player_id)
      .maybeSingle()

    if (playerErr) throw playerErr
    if (!player?.user_id) {
      console.log(`Player ${target_player_id} has no linked user account — skipping push`)
      return new Response(
        JSON.stringify({ ok: true, sent: 0, fails: 0, message: 'Player has no linked account' }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    // 2. Load push subscriptions for that user
    const { data: subs, error: subErr } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('user_id', player.user_id)

    if (subErr) throw subErr

    console.log(`Player ${target_player_id} → user ${player.user_id} → ${subs?.length ?? 0} subscription(s)`)

    if (!subs || subs.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, sent: 0, fails: 0, message: 'No subscriptions for this player' }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    // 3. Fan out to all of this player's devices
    const payload = JSON.stringify({ title, body })
    const results = await Promise.allSettled(
      subs.map(s =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
          payload
        )
      )
    )

    // Clean up expired subscriptions
    const expired: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        console.log(`Sub ${i}: statusCode=${r.value.statusCode}`)
      } else {
        const code = (r.reason as { statusCode?: number })?.statusCode
        console.error(`Sub ${i} failed: statusCode=${code} reason=${r.reason}`)
        if (code === 410) expired.push(subs[i].endpoint)
      }
    })

    if (expired.length) {
      await supabase.from('push_subscriptions').delete().in('endpoint', expired)
      console.log(`Removed ${expired.length} expired subscription(s)`)
    }

    const sent  = results.filter(r => r.status === 'fulfilled').length
    const fails = results.filter(r => r.status === 'rejected').length

    return new Response(
      JSON.stringify({ ok: true, sent, fails }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

  } catch (e) {
    console.error('send-social-push fatal error:', String(e))
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})

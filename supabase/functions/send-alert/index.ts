// Supabase Edge Function — send-alert
// Uses npm:web-push for reliable VAPID + aes128gcm encryption.
//
// Deploy:  supabase functions deploy send-alert --project-ref mtuzmasicpcxcvtslevm
// Secrets: supabase secrets set VAPID_PRIVATE_KEY=<key> VAPID_PUBLIC_KEY=<key> VAPID_EMAIL=<email>

import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { title, body, sentBy } = await req.json()
    if (!title || !body) {
      return new Response(
        JSON.stringify({ error: 'title and body required' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const vapidPub    = Deno.env.get('VAPID_PUBLIC_KEY')!
    const vapidPriv   = Deno.env.get('VAPID_PRIVATE_KEY')!
    const vapidEmail  = Deno.env.get('VAPID_EMAIL') || 'admin@greenbayindoorgolf.com'

    // Configure web-push with VAPID credentials
    webpush.setVapidDetails(`mailto:${vapidEmail}`, vapidPub, vapidPriv)

    const supabase = createClient(supabaseUrl, serviceKey)

    // 1. Save alert to DB
    const { error: insertErr } = await supabase
      .from('alerts')
      .insert({ title, body, sent_by: sentBy || 'Admin' })
    if (insertErr) throw insertErr

    // 2. Load all push subscriptions
    const { data: subs, error: subErr } = await supabase
      .from('push_subscriptions')
      .select('*')
    if (subErr) throw subErr

    console.log(`Loaded ${subs?.length ?? 0} subscription(s)`)

    if (!subs || subs.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, sent: 0, fails: 0, message: 'No subscribers yet' }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    // 3. Fan out to all subscribers
    const payload = JSON.stringify({ title, body })
    const results = await Promise.allSettled(
      subs.map(s =>
        webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dh, auth: s.auth_key },
          },
          payload
        )
      )
    )

    // Log each result so we can see what happened in the Supabase logs
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

    // Clean up expired subscriptions (push service returned 410 Gone)
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
    console.error('send-alert fatal error:', String(e))
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})

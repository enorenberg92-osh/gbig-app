// Supabase Edge Function — send-alert
//
// Sends a broadcast push notification + writes an `alerts` row.
// Scoped to the caller's location: the function resolves location from the
// caller's `location_admins` row rather than trusting client input.
//
// Auth:  caller must pass their user's JWT in the `Authorization` header.
//        Non-admins get 403.
//
// Deploy:  supabase functions deploy send-alert --project-ref mtuzmasicpcxcvtslevm
// Secrets: supabase secrets set VAPID_PRIVATE_KEY=<key> VAPID_PUBLIC_KEY=<key> VAPID_EMAIL=<email>

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
    const { title, body, sentBy } = await req.json()
    if (!title || !body) return json({ error: 'title and body required' }, 400)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const vapidPub    = Deno.env.get('VAPID_PUBLIC_KEY')!
    const vapidPriv   = Deno.env.get('VAPID_PRIVATE_KEY')!
    const vapidEmail  = Deno.env.get('VAPID_EMAIL') || 'no-reply@example.com'

    // ── 1. Identify the caller from their JWT ───────────────────────────────
    const authHeader = req.headers.get('Authorization') || ''
    const jwt = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (!jwt) return json({ error: 'Missing Authorization header' }, 401)

    // Use the anon key here so we can call getUser(jwt) to verify the token
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
    })
    const { data: userData, error: userErr } = await userClient.auth.getUser(jwt)
    if (userErr || !userData?.user) return json({ error: 'Invalid session' }, 401)
    const userId = userData.user.id

    // ── 2. Verify caller is an admin for some location ──────────────────────
    // (Service-role client bypasses RLS to look up the admin row.)
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data: adminRow, error: adminErr } = await admin
      .from('location_admins')
      .select('location_id, role')
      .eq('user_id', userId)
      .maybeSingle()

    if (adminErr) throw adminErr
    if (!adminRow) return json({ error: 'Not an admin for any location' }, 403)

    const locationId = adminRow.location_id

    // ── 3. Configure web-push and record the alert ──────────────────────────
    webpush.setVapidDetails(`mailto:${vapidEmail}`, vapidPub, vapidPriv)

    const { error: insertErr } = await admin
      .from('alerts')
      .insert({ title, body, sent_by: sentBy || 'Admin', location_id: locationId })
    if (insertErr) throw insertErr

    // ── 4. Load subscriptions FOR THIS LOCATION ONLY ────────────────────────
    const { data: subs, error: subErr } = await admin
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth_key')
      .eq('location_id', locationId)

    if (subErr) throw subErr
    console.log(`[send-alert] location=${locationId} subs=${subs?.length ?? 0}`)

    if (!subs || subs.length === 0) {
      return json({ ok: true, sent: 0, fails: 0, message: 'No subscribers yet' })
    }

    // ── 5. Fan out ──────────────────────────────────────────────────────────
    const payload = JSON.stringify({ title, body })
    const results = await Promise.allSettled(
      subs.map(s =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
          payload
        )
      )
    )

    // ── 6. Clean up expired (410) subscriptions ─────────────────────────────
    const expired: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        console.log(`[send-alert] sub ${i}: statusCode=${r.value.statusCode}`)
      } else {
        const code = (r.reason as { statusCode?: number })?.statusCode
        console.error(`[send-alert] sub ${i} failed: statusCode=${code}`)
        if (code === 410) expired.push(subs[i].endpoint)
      }
    })

    if (expired.length) {
      await admin.from('push_subscriptions').delete().in('endpoint', expired)
      console.log(`[send-alert] removed ${expired.length} expired subscription(s)`)
    }

    const sent  = results.filter(r => r.status === 'fulfilled').length
    const fails = results.filter(r => r.status === 'rejected').length
    return json({ ok: true, sent, fails })

  } catch (e) {
    console.error('[send-alert] fatal:', String(e))
    return json({ error: String(e) }, 500)
  }
})

// Supabase Edge Function — send-score-reminders
//
// Weekly "Scores due" push. Two callers, told apart by the bearer token:
//
//   1. Scheduler (hourly): Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>.
//      Calls score_reminders_claim_due(), which picks every location whose
//      LOCAL weekday + hour match its score_reminder_settings (default Friday
//      09:00, locations.timezone) and claims one 'scheduled' slot per open week.
//      Any other token that isn't a valid admin session is rejected.
//
//   2. Admin "Send reminder now" (AdminAlerts): Authorization: Bearer <user JWT>,
//      body { locationId }. Calls admin_start_score_reminder() AS THE USER, so
//      the admin check (require_location_admin) happens in SQL.
//
// Both RPCs claim a row in score_reminder_log (UNIQUE location + event + kind
// + local date) BEFORE anything is pushed, so re-runs in the same hour/day
// never double-send. Title/body/audience are all built in SQL; this function
// only fans out and records the outcome (score_reminder_finish).
//
// Deploy:  supabase functions deploy send-score-reminders --project-ref mtuzmasicpcxcvtslevm
// Secrets: same VAPID_* secrets as send-alert (SUPABASE_* are built in)
//
// Schedule (pick one):
//   a) Dashboard → Integrations → Cron → new job, every hour ("0 * * * *"),
//      type "Supabase Edge Function" → send-score-reminders, POST, header
//      Authorization: Bearer <service role key>.
//   b) SQL (needs pg_cron + pg_net enabled, key stored in Vault):
//        select vault.create_secret('<service role key>', 'service_role_key');
//        select cron.schedule('send-score-reminders', '0 * * * *', $$
//          select net.http_post(
//            url     := 'https://mtuzmasicpcxcvtslevm.supabase.co/functions/v1/send-score-reminders',
//            headers := jsonb_build_object(
//              'Content-Type',  'application/json',
//              'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
//            body    := '{}'::jsonb,
//            timeout_milliseconds := 30000);
//        $$);

import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

// Constant-time compare so the service-key check doesn't leak via timing.
function sameSecret(a: string, b: string) {
  const ea = new TextEncoder().encode(a)
  const eb = new TextEncoder().encode(b)
  let diff = ea.length ^ eb.length
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0)
  return diff === 0
}

// Shape returned by score_reminder_claim() (via both RPCs).
type Send = {
  log_id: string
  location_id: string
  event_id: string
  week_number: number | null
  kind: 'scheduled' | 'manual'
  title: string
  body: string
  user_ids: string[]
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const anonKey     = Deno.env.get('SUPABASE_ANON_KEY')!
    const vapidPub    = Deno.env.get('VAPID_PUBLIC_KEY')!
    const vapidPriv   = Deno.env.get('VAPID_PRIVATE_KEY')!
    const vapidEmail  = Deno.env.get('VAPID_EMAIL')
    // Checked BEFORE claiming: a claimed slot is never retried, so a missing
    // secret must not burn this week's reminder.
    if (!vapidPub || !vapidPriv || !vapidEmail || vapidEmail.endsWith('example.com') || !vapidEmail.includes('@')) {
      return json({ error: 'VAPID secrets must be set (VAPID_EMAIL must be a real admin email)' }, 500)
    }

    const authHeader = req.headers.get('Authorization') || ''
    const token = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (!token) return json({ error: 'Missing Authorization header' }, 401)

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // ── 1. Claim the sends ──────────────────────────────────────────────────
    let mode: 'scheduled' | 'manual'
    let sends: Send[] = []
    let alreadySent = 0

    if (sameSecret(token, serviceKey)) {
      mode = 'scheduled'
      const { data, error } = await admin.rpc('score_reminders_claim_due')
      if (error) throw error
      sends = (data || []) as Send[]
    } else {
      mode = 'manual'
      const { locationId } = await req.json().catch(() => ({}))
      if (typeof locationId !== 'string' || !UUID_RE.test(locationId)) {
        return json({ error: 'A valid locationId is required' }, 400)
      }
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { autoRefreshToken: false, persistSession: false },
      })
      const { data: userData, error: userErr } = await userClient.auth.getUser(token)
      if (userErr || !userData?.user) return json({ error: 'Invalid session' }, 401)

      // Runs as the caller: require_location_admin() inside rejects non-admins.
      const { data, error } = await userClient.rpc('admin_start_score_reminder', { p_location_id: locationId })
      if (error) {
        if (error.code === '42501') return json({ error: 'Not an admin for this location' }, 403)
        throw error
      }
      sends = (data?.sends || []) as Send[]
      alreadySent = data?.already_sent || 0
    }

    console.log(`[send-score-reminders] mode=${mode} claimed=${sends.length} already=${alreadySent}`)
    if (!sends.length) return json({ ok: true, mode, reminders: 0, alreadySent, devices: 0, sent: 0, fails: 0 })

    // ── 2. Fan out, one claimed (location, week) at a time ──────────────────
    webpush.setVapidDetails(`mailto:${vapidEmail}`, vapidPub, vapidPriv)
    const pushOptions = { TTL: 60 * 60 * 24, urgency: 'high' as const }
    const iconCache = new Map<string, string>()

    let devices = 0, sent = 0, fails = 0
    for (const s of sends) {
      if (!s.user_ids?.length) continue // logged as 'empty' at claim time

      // Per-location push branding, same convention as send-alert.
      if (!iconCache.has(s.location_id)) {
        const { data: loc } = await admin.from('locations').select('slug').eq('id', s.location_id).maybeSingle()
        iconCache.set(s.location_id, loc?.slug ? `/branding/${loc.slug}-icon-192.png` : '/icon-192.png')
      }

      // Devices of the audience at THIS location (chunked to keep URLs short).
      const subs: { endpoint: string; p256dh: string; auth_key: string }[] = []
      for (let i = 0; i < s.user_ids.length; i += 100) {
        const { data, error } = await admin
          .from('push_subscriptions')
          .select('endpoint, p256dh, auth_key')
          .eq('location_id', s.location_id)
          .in('user_id', s.user_ids.slice(i, i + 100))
        if (error) throw error
        subs.push(...(data || []))
      }

      const payload = JSON.stringify({
        title: s.title,
        body:  s.body,
        tag:   `scores-due-${s.event_id}`,
        url:   '/league',
        icon:  iconCache.get(s.location_id),
      })

      const results = await Promise.allSettled(
        subs.map(sub =>
          webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth_key } },
            payload,
            pushOptions
          )
        )
      )

      // Clean up dead subscriptions (404 Not Found / 410 Gone).
      const expired: string[] = []
      results.forEach((r, i) => {
        if (r.status === 'rejected') {
          const code = (r.reason as { statusCode?: number })?.statusCode
          console.error(`[send-score-reminders] event=${s.event_id} sub ${i} failed: statusCode=${code}`)
          if (code === 404 || code === 410) expired.push(subs[i].endpoint)
        }
      })
      if (expired.length) {
        await admin.from('push_subscriptions').delete().in('endpoint', expired)
        console.log(`[send-score-reminders] removed ${expired.length} expired subscription(s)`)
      }

      const ok  = results.filter(r => r.status === 'fulfilled').length
      const bad = results.length - ok
      devices += subs.length; sent += ok; fails += bad

      const { error: finErr } = await admin.rpc('score_reminder_finish', {
        p_log_id: s.log_id, p_devices: subs.length, p_sent: ok, p_failed: bad,
      })
      if (finErr) console.error('[send-score-reminders] finish failed:', finErr.message)
      console.log(`[send-score-reminders] location=${s.location_id} event=${s.event_id} players=${s.user_ids.length} devices=${subs.length} sent=${ok}`)
    }

    return json({
      ok: true,
      mode,
      reminders: sends.length,
      alreadySent,
      players: sends.reduce((n, s) => n + (s.user_ids?.length || 0), 0),
      devices,
      sent,
      fails,
    })

  } catch (e) {
    console.error('[send-score-reminders] fatal:', e instanceof Error ? e.message : JSON.stringify(e))
    return json({ error: 'Could not send score reminders' }, 500)
  }
})

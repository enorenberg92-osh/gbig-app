import { createClient } from 'npm:@supabase/supabase-js@2.45.0'
import webpush from 'npm:web-push@3.6.7'
import { deliverAccountNotification } from '../_shared/accountPush.mjs'

// Invoked by the database scheduler. Never accepts recipient IDs or message copy.
Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  const secret = Deno.env.get('NOTIFICATION_WORKER_SECRET')
  const supplied = req.headers.get('x-notification-secret') || ''
  if (!secret || secret.length !== supplied.length) return new Response('Unauthorized', { status: 401 })
  const a = new TextEncoder().encode(secret), b = new TextEncoder().encode(supplied)
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i]
  if (difference) return new Response('Unauthorized', { status: 401 })
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const pub = Deno.env.get('VAPID_PUBLIC_KEY'), priv = Deno.env.get('VAPID_PRIVATE_KEY'), email = Deno.env.get('VAPID_EMAIL')
    const configured = Boolean(pub && priv && email?.includes('@') && !email.endsWith('example.com'))
    if (configured) webpush.setVapidDetails(`mailto:${email}`, pub!, priv!)
    const { error: scheduleError } = await admin.rpc('service_process_score_reminders')
    if (scheduleError) throw scheduleError
    const { data, error } = await admin.rpc('service_claim_account_pushes')
    if (error) throw error
    await Promise.all((data || []).map((notification: any) => deliverAccountNotification(notification, {
      admin, configured,
      send: (subscription: any, payload: any) => webpush.sendNotification({
        endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth_key },
      }, JSON.stringify(payload), { TTL: 3600, urgency: 'high', timeout: 10000 }),
      finish: async (n: any, state: string, delivered: string[], failure: string | null) => {
        const { error } = await admin.rpc('service_finish_account_push', {
          p_id: n.id, p_lease: n.lease_token, p_state: state, p_delivered: delivered, p_error: failure,
        })
        if (error) throw error
      },
    })))
    return Response.json({ ok: true, processed: data?.length || 0, push_configured: configured })
  } catch {
    console.error('Account notification worker failed')
    return Response.json({ error: 'Notification worker failed' }, { status: 500 })
  }
})

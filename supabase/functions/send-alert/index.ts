// Supabase Edge Function — send-alert
// Fans out a web push notification to all subscribed users
// and saves the alert to the `alerts` table.
//
// Deploy:  supabase functions deploy send-alert
// Secret:  supabase secrets set VAPID_PRIVATE_KEY=<your-private-key>

import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Minimal VAPID / Web Push implementation ────────────────────
// We build the JWT and encrypt the payload per RFC 8291 / RFC 8188
// using only Web Crypto (available in Deno / Edge Functions).

async function uint8ToBase64url(buf: Uint8Array): Promise<string> {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

async function base64urlToUint8(b64: string): Promise<Uint8Array> {
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - b64.length % 4)
  return Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/') + pad), c => c.charCodeAt(0))
}

async function makeVapidJwt(audience: string, subject: string, privateKeyB64: string): Promise<string> {
  const header  = { alg: 'ES256', typ: 'JWT' }
  const now     = Math.floor(Date.now() / 1000)
  const payload = { aud: audience, exp: now + 12 * 3600, sub: subject }

  const enc     = new TextEncoder()
  const toSign  = `${btoa(JSON.stringify(header)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')}.${btoa(JSON.stringify(payload)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_')}`

  const rawKey  = await base64urlToUint8(privateKeyB64)
  const cryptoKey = await crypto.subtle.importKey(
    'raw', rawKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  )
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, cryptoKey, enc.encode(toSign))
  return `${toSign}.${await uint8ToBase64url(new Uint8Array(sig))}`
}

async function sendWebPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: string,
  vapidPublicKey: string,
  vapidPrivateKey: string,
  vapidEmail: string
) {
  const url      = new URL(subscription.endpoint)
  const audience = `${url.protocol}//${url.host}`
  const jwt      = await makeVapidJwt(audience, `mailto:${vapidEmail}`, vapidPrivateKey)

  // ── Encrypt payload (aes128gcm per RFC 8291) ──────────────────
  const salt       = crypto.getRandomValues(new Uint8Array(16))
  const serverKey  = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const serverPub  = await crypto.subtle.exportKey('raw', serverKey.publicKey)

  const receiverPub = await base64urlToUint8(subscription.p256dh)
  const authSecret  = await base64urlToUint8(subscription.auth)

  const clientKey  = await crypto.subtle.importKey('raw', receiverPub, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, serverKey.privateKey, 256)

  const enc  = new TextEncoder()
  const hkdf = async (ikm: ArrayBuffer, salt: Uint8Array, info: string, len: number) => {
    const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
    return crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, key, len * 8)
  }

  const prk      = await hkdf(sharedBits, authSecret, 'WebPush: info\x00' + String.fromCharCode(...receiverPub, ...new Uint8Array(serverPub)), 32)
  const cek      = await hkdf(prk, salt, 'Content-Encoding: aes128gcm\x00', 16)
  const nonce    = await hkdf(prk, salt, 'Content-Encoding: nonce\x00', 12)

  const aesKey   = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const msgBytes = enc.encode(payload)
  const padded   = new Uint8Array(msgBytes.length + 1)
  padded.set(msgBytes); padded[msgBytes.length] = 2   // delimiter

  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded)

  // ── Build the HTTP/2 record layer header ──────────────────────
  const serverPubBytes = new Uint8Array(serverPub)
  const header = new Uint8Array(16 + 4 + 1 + serverPubBytes.length)
  header.set(salt)
  new DataView(header.buffer).setUint32(16, 4096, false)
  header[20] = serverPubBytes.length
  header.set(serverPubBytes, 21)

  const body = new Uint8Array(header.length + ciphertext.byteLength)
  body.set(header)
  body.set(new Uint8Array(ciphertext), header.length)

  return fetch(subscription.endpoint, {
    method:  'POST',
    headers: {
      'Content-Type':     'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL':              '86400',
      'Authorization':    `vapid t=${jwt},k=${vapidPublicKey}`,
    },
    body,
  })
}

// ── Edge Function handler ──────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { title, body, sentBy } = await req.json()
    if (!title || !body) return new Response(JSON.stringify({ error: 'title and body required' }), { status: 400, headers: CORS })

    const supabaseUrl  = Deno.env.get('SUPABASE_URL')!
    const serviceKey   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const vapidPub     = Deno.env.get('VAPID_PUBLIC_KEY')!
    const vapidPriv    = Deno.env.get('VAPID_PRIVATE_KEY')!
    const vapidEmail   = Deno.env.get('VAPID_EMAIL') || 'admin@greenbayindoorgolf.com'

    const supabase = createClient(supabaseUrl, serviceKey)

    // 1. Save alert to DB
    const { error: insertErr } = await supabase
      .from('alerts')
      .insert({ title, body, sent_by: sentBy || 'Admin' })
    if (insertErr) throw insertErr

    // 2. Load all subscriptions
    const { data: subs, error: subErr } = await supabase.from('push_subscriptions').select('*')
    if (subErr) throw subErr

    // 3. Fan out — fire and forget, don't fail the whole request on one bad sub
    const payload = JSON.stringify({ title, body })
    const results = await Promise.allSettled(
      (subs || []).map(s => sendWebPush(
        { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth_key },
        payload, vapidPub, vapidPriv, vapidEmail
      ))
    )

    // Remove expired subscriptions (410 Gone)
    const expired: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.status === 410) {
        expired.push((subs![i] as { endpoint: string }).endpoint)
      }
    })
    if (expired.length) {
      await supabase.from('push_subscriptions').delete().in('endpoint', expired)
    }

    const sent  = results.filter(r => r.status === 'fulfilled').length
    const fails = results.filter(r => r.status === 'rejected').length

    return new Response(JSON.stringify({ ok: true, sent, fails }), { headers: { ...CORS, 'Content-Type': 'application/json' } })

  } catch (e) {
    console.error(e)
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
})

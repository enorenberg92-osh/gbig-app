// Supabase Edge Function — signup-webhook
//
// Public endpoint for the location website's league sign-up form (WPForms
// Webhooks addon, or a Zapier/Make zap). Each POST is one sign-up (a team of
// two). The entry is stored in signup_submissions and, when it's clean,
// imported as players + a team in the working league (all in SQL:
// signup_webhook_ingest → process_signup_submission). The location's admins
// then get a push notification.
//
// Auth: a per-location key generated in Admin → Sign-ups, passed as
//   ?key=gbsk_…              (query string — simplest for WPForms), or
//   X-Signup-Key: gbsk_…     (header).
// Only its SHA-256 digest is stored; the lookup is by digest.
//
// Body: JSON object, application/x-www-form-urlencoded or multipart/form-data
// with flat keys p1_name, p1_email, p1_phone, p1_handicap, p2_name, p2_email,
// p2_phone, p2_handicap, day, time, message, team_name (aliases accepted —
// see SIGNUP_FIELD_ALIASES). Max 32 KB; past 30 sign-ups per location per hour, entries are stored for
// review instead of imported; 300/hour is refused.
//
// Deploy:  supabase functions deploy signup-webhook --no-verify-jwt --project-ref mtuzmasicpcxcvtslevm
// Secrets: same VAPID_* secrets as send-alert (push is skipped if unset).

import { createClient } from 'npm:@supabase/supabase-js@2'
import webpush from 'npm:web-push@3.6.7'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-signup-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

const MAX_BODY  = 32 * 1024
const KEY_RE    = /^gbsk_[0-9a-f]{64}$/
const ADMIN_URL = '/league/admin/signups'  // BrowserRouter path, see AdminPanel.jsx

// ── Field mapping ────────────────────────────────────────────────────────────
// KEEP IN SYNC with src/lib/signupImport.js (splitName, parseHandicap,
// buildSignupRow, SIGNUP_FIELD_ALIASES, flattenPayload, mapSignupPayload).
// That file is unit-tested; this is a line-for-line port because edge
// functions can't import from src/.
type Dict = Record<string, string>

function splitName(fullName: string) {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean)
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '' }
}

function parseHandicap(val: unknown) {
  const n = parseFloat(String(val ?? ''))
  return Number.isFinite(n) ? Math.round(n) : null
}

function buildPlayer(fullName: string, phone: string, email: string, handicap: string) {
  const name = (fullName || '').trim().replace(/\s+/g, ' ')
  const { firstName, lastName } = splitName(name)
  return {
    firstName, lastName, fullName: name,
    phone: (phone || '').trim(),
    email: (email || '').trim(),
    handicap: parseHandicap(handicap),
  }
}

function buildSignupRow(f: Dict) {
  const p1 = buildPlayer(f.p1Name, f.p1Phone, f.p1Email, f.p1Handicap)
  const p2 = buildPlayer(f.p2Name, f.p2Phone, f.p2Email, f.p2Handicap)
  const lastName1 = p1.lastName || p1.firstName
  const lastName2 = p2.lastName || p2.firstName
  const day  = (f.day || '').trim()
  const time = (f.time || '').trim()
  return {
    p1, p2, day, time,
    teamName: (f.teamName || '').trim()
      || (lastName1 && lastName2 ? `${lastName1}/${lastName2}` : p1.fullName),
    slot: [day, time].filter(Boolean).join(' '),
    message: (f.message || '').trim(),
    submissionId: (f.submissionId || '').trim(),
    submittedAt: (f.submittedAt || '').trim(),
  }
}

const SIGNUP_FIELD_ALIASES: Record<string, string[]> = {
  p1Name:      ['p1_name', 'player1_name', 'player_1_name', 'name', 'name_1', 'full_name', 'your_name'],
  p1First:     ['p1_first_name', 'player1_first_name', 'player_1_first_name', 'first_name', 'name_first'],
  p1Last:      ['p1_last_name', 'player1_last_name', 'player_1_last_name', 'last_name', 'name_last'],
  p1Email:     ['p1_email', 'player1_email', 'player_1_email', 'email', 'email_1', 'email_address'],
  p1Phone:     ['p1_phone', 'player1_phone', 'player_1_phone', 'phone', 'phone_1', 'phone_number'],
  p1Handicap:  ['p1_handicap', 'player1_handicap', 'player_1_handicap', 'handicap', 'handicap_1', 'hcp', '9_hole_handicap'],
  p2Name:      ['p2_name', 'player2_name', 'player_2_name', 'partner_name', 'teammate_name', 'name_2'],
  p2First:     ['p2_first_name', 'player2_first_name', 'player_2_first_name', 'partner_first_name'],
  p2Last:      ['p2_last_name', 'player2_last_name', 'player_2_last_name', 'partner_last_name'],
  p2Email:     ['p2_email', 'player2_email', 'player_2_email', 'partner_email', 'teammate_email', 'email_2'],
  p2Phone:     ['p2_phone', 'player2_phone', 'player_2_phone', 'partner_phone', 'teammate_phone', 'phone_2', 'phone_number_2'],
  p2Handicap:  ['p2_handicap', 'player2_handicap', 'player_2_handicap', 'partner_handicap', 'teammate_handicap', 'handicap_2', 'hcp_2', '9_hole_handicap_2'],
  day:         ['day', 'league_day', 'night'],
  time:        ['time', 'tee_time', 'league_time'],
  message:     ['message', 'comments', 'comment', 'notes'],
  teamName:    ['team_name', 'team'],
  submissionId:['entry_id', 'entryid', 'submission_id'],
  submittedAt: ['submitted_at', 'entry_date', 'date'],
}
const MAX_FIELD = 200
const MAX_MESSAGE = 2000

const normalizeKey = (key: string) =>
  String(key).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

function flattenPayload(input: unknown, prefix = '', out: Dict = {}, depth = 0): Dict {
  if (!input || typeof input !== 'object' || depth > 3) return out
  for (const [rawKey, value] of Object.entries(input as Record<string, unknown>)) {
    const key = normalizeKey(prefix ? `${prefix}_${rawKey}` : rawKey)
    if (!key || key in out) continue
    if (value == null) continue
    if (Array.isArray(value)) {
      out[key] = value.filter(v => v != null && typeof v !== 'object').join(', ')
    } else if (typeof value === 'object') {
      flattenPayload(value, key, out, depth + 1)
    } else {
      out[key] = String(value)
    }
  }
  return out
}

function mapSignupPayload(input: unknown) {
  const flat = flattenPayload(input)
  const pick = (field: string) => {
    for (const alias of SIGNUP_FIELD_ALIASES[field]) {
      const v = flat[alias]
      if (v != null && String(v).trim() !== '') {
        return String(v).trim().slice(0, field === 'message' ? MAX_MESSAGE : MAX_FIELD)
      }
    }
    return ''
  }
  const joinName = (full: string, first: string, last: string) => full || [first, last].filter(Boolean).join(' ')
  const row = buildSignupRow({
    p1Name: joinName(pick('p1Name'), pick('p1First'), pick('p1Last')),
    p1Email: pick('p1Email'), p1Phone: pick('p1Phone'), p1Handicap: pick('p1Handicap'),
    p2Name: joinName(pick('p2Name'), pick('p2First'), pick('p2Last')),
    p2Email: pick('p2Email'), p2Phone: pick('p2Phone'), p2Handicap: pick('p2Handicap'),
    day: pick('day'), time: pick('time'), message: pick('message'), teamName: pick('teamName'),
    submissionId: pick('submissionId'), submittedAt: pick('submittedAt'),
  })
  const error = !row.p1.fullName
    ? 'No player name found — check the webhook field mapping (p1_name, p1_email, …).'
    : null
  return { row, error }
}
// ── end of synced mapping ────────────────────────────────────────────────────

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Decode the body by content type; falls back to JSON then form encoding
// because some senders omit or mislabel the header.
async function parseBody(text: string, contentType: string): Promise<Record<string, unknown> | null> {
  const ct = contentType.toLowerCase()
  const fromForm = (params: URLSearchParams | FormData) => {
    const out: Record<string, string> = {}
    for (const [k, v] of params.entries()) {
      if (typeof v === 'string' && !(k in out)) out[k] = v
    }
    return out
  }
  if (ct.includes('multipart/form-data')) {
    const fd = await new Response(text, { headers: { 'Content-Type': contentType } }).formData()
    return fromForm(fd)
  }
  if (ct.includes('application/x-www-form-urlencoded')) return fromForm(new URLSearchParams(text))
  try {
    const parsed = JSON.parse(text)
    // Zapier "send as array" wraps one object in a list.
    const obj = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null
  } catch {
    if (text.includes('=')) return fromForm(new URLSearchParams(text))
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405)

  try {
    // ── 1. Key + size checks before touching the database ─────────────────
    const url = new URL(req.url)
    const key = (req.headers.get('x-signup-key') || url.searchParams.get('key') || '').trim()
    if (!KEY_RE.test(key)) return json({ error: 'Invalid or missing key' }, 401)

    const declared = Number(req.headers.get('content-length') || 0)
    if (declared > MAX_BODY) return json({ error: 'Body too large' }, 413)
    const text = await req.text()
    if (text.length > MAX_BODY) return json({ error: 'Body too large' }, 413)

    const body = await parseBody(text, req.headers.get('content-type') || '')
    if (!body) return json({ error: 'Body must be a JSON object or form fields' }, 400)

    const { row } = mapSignupPayload(body)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    // ── 2. Store + process (SQL does auth-by-digest, rate limit, dedupe) ───
    // Optional ?source=zapier|make|wpforms label shown in the inbox.
    const sourceParam = url.searchParams.get('source') || ''
    const source = /^[a-z0-9_-]{1,40}$/i.test(sourceParam) ? sourceParam.toLowerCase() : 'webhook'
    const { data: result, error: rpcErr } = await admin.rpc('signup_webhook_ingest', {
      p_key_hash: await sha256Hex(key),
      p_raw: body,
      p_parsed: row,
      p_source: source,
    })
    if (rpcErr) throw rpcErr
    if (!result?.ok) {
      const code = result?.error
      if (code === 'invalid_key')  return json({ error: 'Invalid or missing key' }, 401)
      if (code === 'rate_limited') return json({ error: 'Too many sign-ups this hour' }, 429)
      if (code === 'too_large')    return json({ error: 'Body too large' }, 413)
      throw new Error(`ingest failed: ${code}`)
    }
    console.log(`[signup-webhook] location=${result.location_id} id=${result.id} status=${result.status}`)

    // ── 3. Push to this location's admins (never fails the webhook) ────────
    try {
      await notifyAdmins(admin, result)
    } catch (e) {
      console.error('[signup-webhook] push failed:', String(e))
    }

    return json({ ok: true, id: result.id, status: result.status })
  } catch (e) {
    // Log the detail server-side; never echo internals to the caller.
    console.error('[signup-webhook] fatal:', String(e))
    return json({ error: 'Sign-up could not be recorded due to a server error' }, 500)
  }
})

type IngestResult = {
  id: string
  location_id: string
  status: 'imported' | 'needs_review' | 'duplicate' | 'dismissed'
  reason: string | null
  team_name: string | null
  player_names: string[]
}

// deno-lint-ignore no-explicit-any
async function notifyAdmins(admin: any, result: IngestResult) {
  const vapidPub   = Deno.env.get('VAPID_PUBLIC_KEY')
  const vapidPriv  = Deno.env.get('VAPID_PRIVATE_KEY')
  const vapidEmail = Deno.env.get('VAPID_EMAIL')
  // Same guard as send-alert: placeholder sender identities get pushes dropped.
  if (!vapidPub || !vapidPriv || !vapidEmail || vapidEmail.endsWith('example.com') || !vapidEmail.includes('@')) {
    console.warn('[signup-webhook] VAPID secrets not set — skipping push')
    return
  }

  const { data: admins, error: adminErr } = await admin
    .from('location_admins')
    .select('user_id')
    .eq('location_id', result.location_id)
  if (adminErr) throw adminErr
  const userIds = [...new Set((admins || []).map((a: { user_id: string }) => a.user_id).filter(Boolean))]
  if (!userIds.length) return

  const [{ data: subs, error: subErr }, { data: locRow }] = await Promise.all([
    admin.from('push_subscriptions').select('endpoint, p256dh, auth_key').in('user_id', userIds),
    admin.from('locations').select('slug').eq('id', result.location_id).maybeSingle(),
  ])
  if (subErr) throw subErr
  console.log(`[signup-webhook] admin subs=${subs?.length ?? 0}`)
  if (!subs?.length) return

  const names = (result.player_names || []).join(' & ') || 'Unknown player'
  const body = result.status === 'imported'
    ? `${names}${result.team_name ? ` (${result.team_name})` : ''}`
    : result.status === 'duplicate'
      ? `Duplicate of an earlier sign-up: ${names}`
      : `Needs review — ${result.reason || names}`

  webpush.setVapidDetails(`mailto:${vapidEmail}`, vapidPub, vapidPriv)
  // Payload mirrors what public/sw.js reads: title, body, tag, url, icon.
  const payload = JSON.stringify({
    title: 'New league sign-up',
    body:  body.slice(0, 180),
    tag:   `league-signup-${result.id}`,
    url:   ADMIN_URL,
    icon:  locRow?.slug ? `/branding/${locRow.slug}-icon-192.png` : '/icon-192.png',
  })
  const pushOptions = { TTL: 60 * 60 * 24, urgency: 'normal' as const }

  const results = await Promise.allSettled(
    subs.map((s: { endpoint: string; p256dh: string; auth_key: string }) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
        payload,
        pushOptions
      )
    )
  )

  // Gone (410) or unknown (404) endpoints will never work again — drop them.
  const expired: string[] = []
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const code = (r.reason as { statusCode?: number })?.statusCode
      console.error(`[signup-webhook] sub ${i} failed: statusCode=${code}`)
      if (code === 404 || code === 410) expired.push(subs[i].endpoint)
    }
  })
  if (expired.length) {
    await admin.from('push_subscriptions').delete().in('endpoint', expired)
    console.log(`[signup-webhook] removed ${expired.length} expired subscription(s)`)
  }
}

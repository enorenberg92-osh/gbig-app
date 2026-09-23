import { parseCSV } from './csv'

// WPForms "League Sign Up" form → team rows. Two entry points share one
// row builder so the CSV export (AdminImport) and the live webhook
// (supabase/functions/signup-webhook, AdminSignups) agree on names, team
// names and handicap rounding.
//
// KEEP IN SYNC: supabase/functions/signup-webhook/index.ts carries a Deno
// port of splitName / parseHandicap / buildSignupRow / mapSignupPayload
// (edge functions can't import from src/). Change both together.
//
// CSV column layout (0-indexed):
//  0  Name*          (P1)
//  1  Phone Number*  (P1)
//  2  Email*         (P1)
//  3  9 Hole Handicap* (P1)
//  4  Day*
//  5  Time*
//  6,7,8  blank
//  9  Name*          (P2)
// 10  Phone Number*  (P2)
// 11  Email*         (P2)
// 12  9 Hole Handicap* (P2)
// 13  Message
// 14+ metadata (15 = entry id, 16 = submitted at)

export function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] || '',
    lastName:  parts.slice(1).join(' ') || '',
  }
}

// League handicaps are whole numbers; sign-up forms often collect decimals
// (e.g. "12.4"), so round here rather than letting the server truncate.
export function parseHandicap(val) {
  const n = parseFloat(val)
  return Number.isFinite(n) ? Math.round(n) : null
}

export function normalizeEmail(email) {
  return (email || '').trim().toLowerCase()
}

function buildPlayer(fullName, phone, email, handicap) {
  const name = (fullName || '').trim().replace(/\s+/g, ' ')
  const { firstName, lastName } = splitName(name)
  return {
    firstName,
    lastName,
    fullName: name,
    phone:    (phone || '').trim(),
    email:    (email || '').trim(),
    handicap: parseHandicap(handicap),
  }
}

// One sign-up (two players) → the row shape both importers use.
// Team name defaults to "Last1/Last2" (a one-word name counts as the last).
export function buildSignupRow(f) {
  const p1 = buildPlayer(f.p1Name, f.p1Phone, f.p1Email, f.p1Handicap)
  const p2 = buildPlayer(f.p2Name, f.p2Phone, f.p2Email, f.p2Handicap)
  const lastName1 = p1.lastName || p1.firstName
  const lastName2 = p2.lastName || p2.firstName
  const day  = (f.day || '').trim()
  const time = (f.time || '').trim()
  return {
    p1,
    p2,
    day,
    time,
    teamName: (f.teamName || '').trim()
      || (lastName1 && lastName2 ? `${lastName1}/${lastName2}` : p1.fullName),
    slot:     [day, time].filter(Boolean).join(' '),
    message:  (f.message || '').trim(),
    submissionId: (f.submissionId || '').trim(),
    submittedAt:  (f.submittedAt || '').trim(),
  }
}

export function parseSignupCSV(text) {
  const table = parseCSV(text)
  if (table.length < 2) return { rows: [], error: 'CSV appears empty.' }

  const parsed = []
  for (let i = 1; i < table.length; i++) {
    const cols = table[i].map(c => (c ?? '').trim())
    if (!cols[0]) continue  // skip empty rows

    parsed.push(buildSignupRow({
      p1Name: cols[0], p1Phone: cols[1], p1Email: cols[2], p1Handicap: cols[3],
      day: cols[4], time: cols[5],
      p2Name: cols[9], p2Phone: cols[10], p2Email: cols[11], p2Handicap: cols[12],
      message: cols[13],
      submissionId: cols[15], submittedAt: cols[16],
    }))
  }

  return { rows: parsed, error: null }
}

// ── Webhook payloads ─────────────────────────────────────────────────────────
// WPForms' Webhooks addon, Zapier and Make all send flat key/value pairs whose
// keys the admin chooses. Keys are normalized (lowercase, runs of anything
// that isn't a letter/digit → "_") and matched against these aliases, first
// match wins. Nested objects are flattened with "_" ({p1:{name}} → p1_name).
// The documented keys are the first entry of each list.
export const SIGNUP_FIELD_ALIASES = {
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

export function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

// Flatten to { normalized_key: string }. Arrays are joined (checkbox fields),
// depth is capped so a hostile body can't recurse forever.
export function flattenPayload(input, prefix = '', out = {}, depth = 0) {
  if (!input || typeof input !== 'object' || depth > 3) return out
  for (const [rawKey, value] of Object.entries(input)) {
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

// Webhook body (already JSON-decoded or form-decoded to an object) → row.
// Returns { row, error }; error is a human-readable reason the admin sees in
// the sign-ups inbox when the field mapping is wrong.
export function mapSignupPayload(input) {
  const flat = flattenPayload(input)
  const pick = (field) => {
    for (const alias of SIGNUP_FIELD_ALIASES[field]) {
      const v = flat[alias]
      if (v != null && String(v).trim() !== '') {
        return String(v).trim().slice(0, field === 'message' ? MAX_MESSAGE : MAX_FIELD)
      }
    }
    return ''
  }
  const joinName = (full, first, last) => full || [first, last].filter(Boolean).join(' ')

  const row = buildSignupRow({
    p1Name:     joinName(pick('p1Name'), pick('p1First'), pick('p1Last')),
    p1Email:    pick('p1Email'),
    p1Phone:    pick('p1Phone'),
    p1Handicap: pick('p1Handicap'),
    p2Name:     joinName(pick('p2Name'), pick('p2First'), pick('p2Last')),
    p2Email:    pick('p2Email'),
    p2Phone:    pick('p2Phone'),
    p2Handicap: pick('p2Handicap'),
    day:        pick('day'),
    time:       pick('time'),
    message:    pick('message'),
    teamName:   pick('teamName'),
    submissionId: pick('submissionId'),
    submittedAt:  pick('submittedAt'),
  })

  const error = !row.p1.fullName
    ? 'No player name found — check the webhook field mapping (p1_name, p1_email, …).'
    : null
  return { row, error }
}

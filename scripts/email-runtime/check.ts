import { reset, state, userId, venueId, senderId } from './mock-supabase.ts'

let handler: (req: Request) => Promise<Response>
const originalServe = Deno.serve
Deno.serve = ((callback: typeof handler) => { handler = callback; return {} }) as typeof Deno.serve
try { await import('../../supabase/functions/weekly-email/index.ts') } finally { Deno.serve = originalServe }
Deno.env.set('SUPABASE_URL', 'https://invalid.example')
Deno.env.set('SUPABASE_ANON_KEY', 'test-only-anon')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-only-service')
Deno.env.set('RESEND_API_KEY', 'test-only-never-sent')

function assert(condition: unknown, message = 'Assertion failed'): asserts condition { if (!condition) throw new Error(message) }
const request = (body: unknown, token = 'test-user') => handler(new Request('https://invalid.example/weekly-email', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) }))
const scope = { mode: 'direct', location_id: venueId }

Deno.test('missing and invalid user JWTs are denied before any database access', async () => {
  reset()
  assert((await request({ action: 'status', ...scope }, '')).status === 401)
  state.authenticated = false
  assert((await request({ action: 'status', ...scope })).status === 401)
  assert(state.calls.length === 0)
})
Deno.test('ordinary users cannot check another venue’s email configuration', async () => {
  reset(); state.admin = false
  assert((await request({ action: 'status', ...scope })).status === 403)
  assert(!state.calls.includes('weekly_email_senders'))
})
Deno.test('status exposes separate readiness checks and verified IDs without secrets or provider calls', async () => {
  reset()
  const result = await (await request({ action: 'status', ...scope })).json()
  assert(result.setup.configured === true)
  assert(result.setup.account_id === userId && result.setup.location_id === venueId)
  assert(result.setup.checks.storage === true && result.setup.checks.service_key === true)
  assert(!JSON.stringify(result).includes('test-only-never-sent'))
  assert(!state.calls.some(table => ['events', 'league_config', 'roster_at', 'players'].includes(table)))
})
Deno.test('sender access is independent from storage and service configuration', async () => {
  reset(); state.assigned = false
  const result = await (await request({ action: 'status', ...scope })).json()
  assert(result.setup.configured === false && result.setup.checks.sender === false)
  assert(result.setup.checks.storage === true && result.setup.checks.service_key === true)
  assert(result.senders.length === 0)
})
Deno.test('missing private storage is reported as an actionable readiness failure', async () => {
  reset(); state.storage = false
  const result = await (await request({ action: 'status', ...scope })).json()
  assert(result.setup.configured === false && result.setup.checks.storage === false)
})
Deno.test('a direct preview saves exactly one explicit recipient without loading a round or roster', async () => {
  reset()
  const response = await request({ action: 'preview', ...scope, compose_id: '00000000-0000-4000-8000-000000000004', sender_id: senderId, to: 'owner@example.com', subject: 'Private test', text: 'Only one person.' })
  assert(response.status === 200)
  const result = await response.json()
  assert(result.recipient_count === 1 && result.to === 'owner@example.com')
  assert(state.campaign.event_id === null && state.campaign.league_id === null)
  assert(!state.calls.some(table => ['events', 'league_config', 'roster_at', 'players'].includes(table)))
})
Deno.test('an unassigned From and a multi-recipient To cannot save a direct preview', async () => {
  reset()
  const input = { action: 'preview', ...scope, compose_id: '00000000-0000-4000-8000-000000000004', sender_id: senderId, to: 'one@example.com,two@example.com', subject: 'Test', text: 'Private' }
  assert((await request(input)).status === 400)
  state.assigned = false
  assert((await request({ ...input, to: 'one@example.com' })).status === 403)
  assert(state.campaign === null)
})

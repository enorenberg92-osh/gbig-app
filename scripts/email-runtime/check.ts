import { reset, state, userId, venueId, senderId } from './mock-supabase.ts'
import { seal } from '../../supabase/functions/_shared/gmailEmail.mjs'

let handler: (req: Request) => Promise<Response>
const originalServe = Deno.serve
Deno.serve = ((callback: typeof handler) => { handler = callback; return {} }) as typeof Deno.serve
try { await import('../../supabase/functions/weekly-email/index.ts') } finally { Deno.serve = originalServe }
Deno.env.set('SUPABASE_URL', 'https://invalid.example')
Deno.env.set('SUPABASE_ANON_KEY', 'test-only-anon')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-only-service')
Deno.env.set('GMAIL_CLIENT_ID', 'test.apps.googleusercontent.com')
Deno.env.set('GMAIL_CLIENT_SECRET', 'test-only-never-sent')
Deno.env.set('GMAIL_TOKEN_ENCRYPTION_KEY', btoa(String.fromCharCode(...new Uint8Array(32).fill(7))))

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
  assert(result.setup.checks.storage === true && result.setup.checks.service_key === false)
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
Deno.test('a recipient list is normalized and private, while an unassigned From remains denied', async () => {
  reset()
  const input = { action: 'preview', ...scope, compose_id: '00000000-0000-4000-8000-000000000004', sender_id: senderId, to: 'one@example.com,two@example.com', subject: 'Test', text: 'Private' }
  const result=await (await request(input)).json()
  assert(result.recipient_count===2 && result.to_addresses.join(',')==='one@example.com,two@example.com')
  assert(!state.calls.some(table=>['events','league_config','roster_at','players'].includes(table)))
  reset()
  state.assigned = false
  assert((await request({ ...input, to: 'one@example.com' })).status === 403)
  assert(state.campaign === null)
})

await import('./gmail-check.ts')

Deno.test('1000-recipient anytime preview is accepted without a round, roster or daily allowance access',async()=>{
  reset()
  const to=Array.from({length:1000},(_,i)=>`p${i}@example.com`).join(';\n')
  const input={action:'preview',...scope,compose_id:'00000000-0000-4000-8000-000000000004',sender_id:senderId,to,subject:'Anytime announcement',text:'Independent of all rounds.'}
  const response=await request(input),result=await response.json()
  assert(response.status===200&&result.recipient_count===1000)
  assert(!state.calls.some(table=>['events','league_config','roster_at','players','weekly_email_direct_quota'].includes(table)))
  reset()
  assert((await request({...input,to:to+';overflow@example.com'})).status===400)
  assert(state.campaign===null)
})
Deno.test('member picker paginates and isolates active venue contacts, filters league teams, and rejects another venue',async()=>{
  reset()
  const league='00000000-0000-4000-8000-000000000020'
  state.leagues=[{id:league,location_id:venueId,name:'Current league'}]
  state.contacts=Array.from({length:501},(_,i)=>({id:'player-'+i,email:`p${i}@example.com`,location_id:venueId,is_active:true}))
  state.contacts.push({id:'wrong',email:'wrong@example.com',location_id:'other',is_active:true},{id:'inactive',email:'inactive@example.com',location_id:venueId,is_active:false},{id:'invalid',email:'',location_id:venueId,is_active:true})
  state.teams=[{id:'team',league_id:league,location_id:venueId,player1_id:'player-0',player2_id:'player-500'},{id:'other-team',league_id:league,location_id:'other',player1_id:'player-1'}]
  const all=await(await request({action:'audience',...scope,source:'venue'})).json()
  assert(all.addresses.length===501&&all.missing_count===1)
  assert(!all.addresses.includes('wrong@example.com')&&!all.addresses.includes('inactive@example.com'))
  const selected=await(await request({action:'audience',...scope,source:'league',league_id:league})).json()
  assert(selected.addresses.join(',')==='p0@example.com,p500@example.com')
  assert((await request({action:'audience',...scope,source:'league',league_id:'00000000-0000-4000-8000-000000000021'})).status===403)
  state.admin=false
  assert((await request({action:'audience_options',...scope})).status===403)
})

Deno.test('a large saved campaign resumes untouched copies through the real Gmail adapter with private To headers and no daily ledger',async()=>{
  reset()
  const to=Array.from({length:500},(_,i)=>`p${i}@example.com`).join(',')
  await request({action:'preview',...scope,compose_id:'00000000-0000-4000-8000-000000000004',sender_id:senderId,to,subject:'Anytime update',text:'Offline runtime test only.'})
  state.campaign.recipients.slice(0,498).forEach((r:any)=>{r.status='accepted';r.provider_id='previous-mock'})
  state.connection={sender_id:senderId,mailbox:'trent@greenbayindoorgolf.com',refresh_token_ciphertext:await seal('test-refresh',Deno.env.get('GMAIL_TOKEN_ENCRYPTION_KEY')!,`sender:${senderId}:trent@greenbayindoorgolf.com`)}
  const originalFetch=globalThis.fetch,sent:string[]=[]
  globalThis.fetch=(async(url:any,init:any)=>{
    if(String(url)==='https://oauth2.googleapis.com/token')return Response.json({access_token:'mock-access',token_type:'Bearer'})
    assert(String(url)==='https://gmail.googleapis.com/gmail/v1/users/me/messages/send','Unexpected network destination')
    const raw=JSON.parse(init.body).raw.replace(/-/g,'+').replace(/_/g,'/')
    const mime=atob(raw)
    assert(!/^Cc:|^Bcc:/mi.test(mime))
    sent.push(mime.match(/^To: (.+)$/m)![1].trim())
    return Response.json({id:'mock-message-'+sent.length})
  }) as typeof fetch
  try{
    state.calls=[]
    const response=await request({action:'send',...scope,draft_id:state.campaign.id}),result=await response.json()
    assert(response.status===200&&result.accepted_count===500&&result.pending_count===0)
    assert(sent.join(',')==='p498@example.com,p499@example.com')
    assert(state.calls.includes('claim_email_send_batch')&&state.calls.includes('save_email_send_progress'))
    assert(!state.calls.includes('weekly_email_direct_quota'))
  }finally{globalThis.fetch=originalFetch}
})

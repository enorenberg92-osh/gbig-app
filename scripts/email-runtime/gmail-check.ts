import { reset, state, senderId } from './mock-supabase.ts'
import { GMAIL_SCOPE } from '../../supabase/functions/_shared/gmailEmail.mjs'

let handler:(req:Request)=>Promise<Response>
const originalServe=Deno.serve
Deno.serve=((callback:typeof handler)=>{handler=callback;return {}}) as typeof Deno.serve
try{await import('../../supabase/functions/gmail-oauth/index.ts')}finally{Deno.serve=originalServe}
function assert(value:unknown,message='Gmail assertion failed'):asserts value{if(!value)throw new Error(message)}
const origin='https://gbig-app.vercel.app'
const start=(id=senderId,jwt='test-user',requestOrigin=origin)=>handler(new Request('https://invalid.example/gmail-oauth',{method:'POST',headers:{Origin:requestOrigin,Authorization:`Bearer ${jwt}`},body:JSON.stringify({sender_id:id})}))
async function oauthState(){const response=await start();assert(response.status===200);return new URL((await response.json()).url).searchParams.get('state')!}
const callback=(value:string)=>handler(new Request(`https://invalid.example/gmail-oauth?state=${encodeURIComponent(value)}&code=test-google-code`))

Deno.test('Gmail connection start denies missing identity, unrelated sender, unassigned user, and untrusted origin',async()=>{
  reset();assert((await start(senderId,'')).status===401)
  assert((await start(senderId,'test-user','https://evil.example')).status===403)
  assert((await start('00000000-0000-4000-8000-000000000099')).status===400)
  state.assigned=false;assert((await start()).status===400)
  state.assigned=true;state.admin=false;assert((await start()).status===400)
  assert(state.oauthStates.length===0)
})
Deno.test('Gmail state stores a hash and encrypted PKCE verifier, with bounded pending attempts',async()=>{
  reset();const value=await oauthState()
  assert(!JSON.stringify(state.oauthStates).includes(value))
  assert(state.oauthStates[0].verifier_ciphertext.startsWith('v1.'))
  for(let index=1;index<10;index++)await oauthState()
  assert((await start()).status===429)
})
Deno.test('Gmail callback connects only the exact verified mailbox, never enables sending, and consumes state once',async()=>{
  reset();state.enabled=false;const value=await oauthState()
  let calls=0
  const originalFetch=globalThis.fetch
  globalThis.fetch=(async(input:URL|RequestInfo)=>{
    calls++
    if(String(input)==='https://oauth2.googleapis.com/token')return Response.json({access_token:'test-access-token',refresh_token:'test-refresh-token',token_type:'Bearer',scope:`openid email ${GMAIL_SCOPE}`})
    if(String(input)==='https://openidconnect.googleapis.com/v1/userinfo')return Response.json({email:'trent@greenbayindoorgolf.com',email_verified:true,sub:'google-trent'})
    throw new Error('Unexpected outbound request')
  }) as typeof fetch
  try{
    const response=await callback(value)
    assert(response.status===303)
    assert(response.headers.get('Location')===`${origin}/league/admin/email`)
    assert(!response.headers.get('Location')?.includes('code='))
    assert(state.connection.mailbox==='trent@greenbayindoorgolf.com')
    assert(!state.connection.refresh_token_ciphertext.includes('test-refresh-token'))
    assert(state.enabled===false)
    assert((await callback(value)).status===400)
    assert(calls===2,'Replayed state must not contact Google')
  }finally{globalThis.fetch=originalFetch}
})
Deno.test('Gmail rejects expired state and revoked sender access before contacting Google',async()=>{
  reset();let value=await oauthState();state.oauthStates[0].expires_at='2000-01-01T00:00:00Z'
  assert((await callback(value)).status===400)
  reset();value=await oauthState();state.assigned=false
  assert((await callback(value)).status===400)
  assert(state.connection===null)
})
Deno.test('Gmail refuses a different mailbox or an inbox-reading grant',async()=>{
  const originalFetch=globalThis.fetch
  try{
    for(const scenario of ['wrong-mailbox','broad-scope']){
      reset();const value=await oauthState()
      globalThis.fetch=(async(input:URL|RequestInfo)=>String(input)==='https://oauth2.googleapis.com/token'
        ?Response.json({access_token:'test-token',refresh_token:'test-refresh',token_type:'Bearer',scope:scenario==='broad-scope'?`${GMAIL_SCOPE} https://www.googleapis.com/auth/gmail.readonly`:`openid email ${GMAIL_SCOPE}`})
        :Response.json({email:'other@example.com',email_verified:true,sub:'other'})) as typeof fetch
      assert((await callback(value)).status===400)
      assert(state.connection===null)
    }
  }finally{globalThis.fetch=originalFetch}
})

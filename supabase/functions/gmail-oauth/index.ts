import { createClient } from 'npm:@supabase/supabase-js@2.101.1'
import { UUID } from '../_shared/weeklyEmail.mjs'
import { GMAIL_ORIGINS, gmailConfiguration, randomSecret, digest, seal, unseal, oauthURL, exchangeGoogleToken, googleMailbox, requireSendingScope } from '../_shared/gmailEmail.mjs'

const baseHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }
const cors = (origin:string) => ({ ...baseHeaders, 'Access-Control-Allow-Origin':origin, 'Vary':'Origin', 'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods':'POST, OPTIONS' })
const json = (body:unknown, status:number, origin:string) => new Response(JSON.stringify(body), { status, headers:{...cors(origin),'Content-Type':'application/json'} })
async function checked(query:any) { const {data,error}=await query; if(error)throw new Error('Gmail setup storage could not be checked.');return data }
async function senderForUser(admin:any, senderId:string, userId:string) {
  const sender=await checked(admin.from('weekly_email_senders').select('id,location_id,email').eq('id',senderId).maybeSingle())
  if(!sender)throw new Error('This sender is unavailable.')
  const [assignment,staff,owner]=await Promise.all([
    checked(admin.from('weekly_email_sender_users').select('sender_id').eq('sender_id',senderId).eq('user_id',userId).maybeSingle()),
    checked(admin.from('location_admins').select('user_id').eq('location_id',sender.location_id).eq('user_id',userId).maybeSingle()),
    checked(admin.from('super_admins').select('user_id').eq('user_id',userId).maybeSingle()),
  ])
  if(!assignment||(!staff&&!owner))throw new Error('Current venue administrator and sender permission are required.')
  return sender
}

// The callback has no Supabase JWT. Every POST validates auth.getUser; every GET
// consumes a single-use OAuth state and rechecks the saved user's current grants.
Deno.serve(async(req:Request)=>{
  const origin=req.headers.get('Origin')||''
  if(req.method==='OPTIONS')return new Response(null,{status:GMAIL_ORIGINS.includes(origin)?204:403,headers:cors(GMAIL_ORIGINS.includes(origin)?origin:'null')})
  const config=gmailConfiguration((name:string)=>Deno.env.get(name))
  if(!config)return json({error:'The owner needs to finish Google app setup before connecting Gmail.'},503,GMAIL_ORIGINS.includes(origin)?origin:'null')
  const admin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}})
  const redirectUri=`${Deno.env.get('SUPABASE_URL')}/functions/v1/gmail-oauth`
  if(req.method==='POST'){
    if(!GMAIL_ORIGINS.includes(origin))return json({error:'Open Gmail setup from the GBIG or AIG app.'},403,'null')
    try{
      const jwt=(req.headers.get('Authorization')||'').match(/^Bearer\s+(\S+)$/i)?.[1]||''
      if(!jwt)return json({error:'Sign in as an approved venue administrator first.'},401,origin)
      const {data,error}=await admin.auth.getUser(jwt)
      if(!jwt||error||!data.user)return json({error:'Sign in as an approved venue administrator first.'},401,origin)
      // Small bounded body, including requests without Content-Length.
      const reader=req.body?.getReader();if(!reader)return json({error:'Choose an approved sender.'},400,origin)
      const chunks:Uint8Array[]=[];let size=0
      while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>2048){await reader.cancel();return json({error:'Request too large.'},413,origin)}chunks.push(value)}
      const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length}
      const input=JSON.parse(new TextDecoder().decode(raw))
      if(!input||typeof input.sender_id!=='string'||!UUID.test(input.sender_id))return json({error:'Choose an approved sender.'},400,origin)
      const sender=await senderForUser(admin,input.sender_id,data.user.id)
      const now=new Date()
      const pending=await checked(admin.from('gmail_email_oauth_states').select('state_hash').eq('user_id',data.user.id).is('consumed_at',null).gt('expires_at',now.toISOString()).limit(10))
      if(pending.length>=10)return json({error:'Finish an existing Gmail connection or wait ten minutes before starting another.'},429,origin)
      const state=randomSecret(),hash=await digest(state),verifier=randomSecret()
      const binding=`oauth:${hash}:${sender.id}:${data.user.id}:${origin}`
      await checked(admin.from('gmail_email_oauth_states').insert({state_hash:hash,sender_id:sender.id,user_id:data.user.id,return_origin:origin,
        verifier_ciphertext:await seal(verifier,config.encryptionKey,binding),expires_at:new Date(now.getTime()+600000).toISOString()}))
      return json({url:oauthURL({clientId:config.clientId,redirectUri,state,challenge:await digest(verifier),email:sender.email})},200,origin)
    }catch{return json({error:'Gmail connection could not start. Confirm your sender access and Google app setup.'},400,origin)}
  }
  if(req.method!=='GET')return json({error:'Use POST to connect Gmail.'},405,'null')
  try{
    const url=new URL(req.url),state=url.searchParams.get('state')||''
    if(!/^[A-Za-z0-9_-]{43}$/.test(state))throw new Error('Invalid state')
    const now=new Date().toISOString(),hash=await digest(state)
    // CAS consumes the state BEFORE token exchange. Replays cannot reconnect.
    const saved=await checked(admin.from('gmail_email_oauth_states').update({consumed_at:now}).eq('state_hash',hash).is('consumed_at',null).gt('expires_at',now).select('*').maybeSingle())
    if(!saved||!GMAIL_ORIGINS.includes(saved.return_origin))throw new Error('Expired state')
    const sender=await senderForUser(admin,saved.sender_id,saved.user_id)
    const code=url.searchParams.get('code')||''
    if(url.searchParams.has('error')||!code||code.length>4096)throw new Error('Google authorization not completed')
    const verifier=await unseal(saved.verifier_ciphertext,config.encryptionKey,`oauth:${hash}:${saved.sender_id}:${saved.user_id}:${saved.return_origin}`)
    const token=await exchangeGoogleToken({client_id:config.clientId,client_secret:config.clientSecret,redirect_uri:redirectUri,grant_type:'authorization_code',code,code_verifier:verifier})
    requireSendingScope(token.scope)
    const mailbox=await googleMailbox(token.access_token)
    if(mailbox.email!==sender.email.toLowerCase()||typeof token.refresh_token!=='string'||!token.refresh_token)throw new Error('Mailbox mismatch or missing offline consent')
    // Recheck grants after network calls too. Connecting does not enable a sender.
    await senderForUser(admin,saved.sender_id,saved.user_id)
    await checked(admin.from('gmail_email_connections').upsert({sender_id:sender.id,mailbox:mailbox.email,google_subject:mailbox.sub,
      refresh_token_ciphertext:await seal(token.refresh_token,config.encryptionKey,`sender:${sender.id}:${mailbox.email}`),connected_by:saved.user_id,connected_at:now}))
    return new Response(null,{status:303,headers:{...baseHeaders,Location:`${saved.return_origin}/league/admin/email`}})
  }catch{
    return new Response('Gmail was not connected. Return to the app and start again with the exact approved business Gmail account. No email was sent.',{status:400,headers:{...baseHeaders,'Content-Type':'text/plain; charset=utf-8'}})
  }
})

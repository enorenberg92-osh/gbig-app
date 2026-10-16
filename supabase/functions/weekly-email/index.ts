import { createClient } from 'npm:@supabase/supabase-js@2.101.1'
import { UUID, emailSetupStatus, reserveDirectAllowance, DirectQuotaError, authorizedSenders, resolveEmailAudience, validateMessage, resolveRecipients, summary, sendChunk } from '../_shared/weeklyEmail.mjs'

const headers = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods':'POST, OPTIONS' }
const json = (body:unknown, status=200) => new Response(JSON.stringify(body), { status, headers:{...headers,'Content-Type':'application/json'} })
class RequestError extends Error { constructor(message:string, public status=400) { super(message) } }
type ApprovedSender = { id:string; from:string; reply_to:string; is_default:boolean }
async function checked(query:any) { const {data,error}=await query; if(error)throw error; return data }

Deno.serve(async req => {
  if(req.method==='OPTIONS')return new Response('ok',{headers})
  if(req.method!=='POST')return json({error:'Use POST.'},405)
  try {
    const jwt=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'').trim()
    if(!jwt)throw new RequestError('Sign in as a venue administrator first.',401)
    const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{auth:{persistSession:false},global:{headers:{Authorization:`Bearer ${jwt}`}}})
    const {data:auth,error:authError}=await client.auth.getUser(jwt)
    if(authError||!auth.user)throw new RequestError('Your session expired. Sign in again.',401)
    // Bound the stream, including requests without Content-Length.
    const reader=req.body?.getReader(); if(!reader)throw new RequestError('Choose a round.')
    let bytes=0; const chunks:Uint8Array[]=[]
    while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>90000){await reader.cancel();throw new RequestError('The message is too long.',413)}chunks.push(value)}
    const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length}
    let input:any;try{input=JSON.parse(new TextDecoder().decode(raw))}catch{throw new RequestError('The request must contain valid JSON.')}
    if(!input||!['status','preview','send'].includes(input.action)||!['league','direct'].includes(input.mode||'league'))throw new RequestError('Choose a valid email action.')
    const direct=input.mode==='direct'
    const scopeId=direct?input.location_id:input.event_id
    if(typeof scopeId!=='string'||!UUID.test(scopeId))throw new RequestError(direct?'Choose a valid venue.':'Choose a valid round.')
    if(input.action==='send'&&(typeof input.draft_id!=='string'||!UUID.test(input.draft_id)))throw new RequestError('Preview this email before sending.')
    if(direct&&(input.action==='preview'||input.compose_id!=null)&&(typeof input.compose_id!=='string'||!UUID.test(input.compose_id)))throw new RequestError('Start a new email before previewing.')
    const admin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}})
    // Direct messages do not query events, leagues, rosters, scores, or notifications.
    const event=direct?{location_id:input.location_id,id:null,league_id:null,status:null}:await checked(admin.from('events').select('id,location_id,league_id,status').eq('id',input.event_id).maybeSingle())
    if(!event)throw new RequestError('Round not found.',404)
    // Follow the existing venue-admin model; no client role, sender, or recipients are trusted.
    const [staff,superAdmin]=await Promise.all([
      checked(admin.from('location_admins').select('user_id').eq('user_id',auth.user.id).eq('location_id',event.location_id).maybeSingle()),
      checked(admin.from('super_admins').select('user_id').eq('user_id',auth.user.id).maybeSingle()),
    ])
    if(!staff&&!superAdmin)throw new RequestError('You are not an administrator for this venue.',403)
    const apiKey=Deno.env.get('RESEND_API_KEY')
    const readiness=(storage:boolean|null,sender:boolean|null,message:string)=>emailSetupStatus({storage,sender,serviceKey:Boolean(apiKey),accountId:auth.user.id,locationId:event.location_id,message})
    const league=direct?null:await checked(admin.from('league_config').select('id,location_id,is_working').eq('id',event.league_id).eq('location_id',event.location_id).single())
    const [senderConfigs,senderAssignments]=await Promise.all([
      admin.from('weekly_email_senders').select('id,location_id,display_name,email,reply_to,is_default,enabled').eq('location_id',event.location_id).eq('enabled',true).limit(101),
      admin.from('weekly_email_sender_users').select('sender_id,user_id').eq('user_id',auth.user.id).limit(1001),
    ])
    if(senderConfigs.error||senderAssignments.error||senderConfigs.data.length>100||senderAssignments.data.length>1000){
      if(input.action==='status')return json({from:'',senders:[],latest:null,setup:readiness(null,null,'Approved sender setup could not be checked. Ask the owner to configure this venue’s email senders.')})
      throw new RequestError('Approved sender setup is unavailable. Ask the owner to check this venue’s sender permissions.',503)
    }
    const senders:ApprovedSender[]=authorizedSenders(senderConfigs.data,senderAssignments.data,auth.user.id,event.location_id)
    const preferredFrom=senders[0]?.from||''
    const table=()=>admin.from('weekly_email_campaigns')
    let savedQuery=table().select('*').eq('location_id',event.location_id).eq('mode',direct?'direct':'league')
    if(direct){
      savedQuery=savedQuery.eq('created_by',auth.user.id)
      if(input.action==='preview'||(input.action==='status'&&input.compose_id))savedQuery=savedQuery.eq('compose_id',input.compose_id)
      else if(input.action==='send')savedQuery=savedQuery.eq('id',input.draft_id)
      else savedQuery=savedQuery.order('created_at',{ascending:false}).limit(1)
    } else savedQuery=savedQuery.eq('event_id',event.id)
    const stored=await savedQuery.maybeSingle()
    if(stored.error){
      if(input.action==='status')return json({from:preferredFrom,senders,latest:null,setup:readiness(false,senders.length>0,'Email history storage could not be checked. Ask the owner to verify the email database setup. No message was sent.')})
      throw new RequestError('Email history storage is unavailable. Ask the owner to check setup before sending.',503)
    }
    let row=stored.data
    if(direct&&input.action==='status'){
      const allowance=await admin.from('weekly_email_direct_quota').select('slot').eq('location_id',event.location_id).eq('user_id',auth.user.id).limit(1)
      if(allowance.error)return json({from:preferredFrom,senders,latest:summary(row),setup:readiness(false,senders.length>0,'The direct-email daily allowance could not be checked. Ask the owner to verify the email setup before sending.')})
    }
    if(input.action==='status')return json({from:preferredFrom,senders,latest:summary(row),setup:readiness(true,senders.length>0,!senders.length?'The owner needs to approve at least one venue sender for your signed-in account.':apiKey?'Your approved venue senders, email service key, and history storage are present. Live sender-domain verification and delivery have not been checked here.':'The owner needs to connect the email service. No message was sent.')})
    if(!direct&&(event.status!=='open'||!league?.is_working))throw new RequestError('Use the open round in the working league. This action never closes a round.',409)
    if(input.action==='preview'){
      const sender=senders.find(s=>s.id===input.sender_id)
      if(!sender)throw new RequestError('Choose a sender approved for your account at this venue.',403)
      let content;try{content=validateMessage(input.subject,input.text)}catch(e){throw new RequestError((e as Error).message)}
      if(row?.started_at)throw new RequestError('This email already started. Check its status and continue that saved email instead.',409)
      let audience
      try{audience=await resolveEmailAudience(direct?'direct':'league',input.to,async()=>{
      const roster=await checked(admin.from('roster_at').select('event_id,location_id,league_id,team_id,player_id').eq('event_id',event.id).eq('location_id',event.location_id).eq('league_id',event.league_id).limit(501))
      if(!roster.length||roster.length>500)throw new RequestError('This round needs a roster of 1–500 players.')
      const [players,teams]=await Promise.all([
        checked(admin.from('players').select('id,email,location_id').eq('location_id',event.location_id).in('id',roster.map((r:any)=>r.player_id)).limit(501)),
        checked(admin.from('teams').select('id,location_id,league_id').eq('location_id',event.location_id).eq('league_id',event.league_id).limit(501)),
      ])
      return resolveRecipients(roster,players,teams,event)
      })}catch(e){if(e instanceof RequestError)throw e;throw new RequestError('The recipient list could not be prepared. Check the address or round roster before previewing.')}
      const next={id:crypto.randomUUID(),mode:direct?'direct':'league',compose_id:direct?input.compose_id:null,event_id:event.id,location_id:event.location_id,league_id:event.league_id,created_by:auth.user.id,sender_id:sender.id,sender:sender.from,reply_to:sender.reply_to,subject:content.subject,body:content.text,...audience,created_at:new Date().toISOString(),last_error:null}
      // Compare-and-set: stale previews cannot replace a campaign once Send has claimed it.
      const result=row
        ? await table().update(next).eq('id',row.id).is('started_at',null).select('*').maybeSingle()
        : await table().insert(next).select('*').single()
      if(result.error||!result.data)throw new RequestError('Another administrator changed this email. Check status and preview again.',409)
      return json(summary(result.data))
    }
    if(!row||row.id!==input.draft_id)throw new RequestError('This preview is out of date. Check status and preview again.',409)
    if(summary(row)?.status==='accepted')return json(summary(row))
    const approvedSender=senders.find(s=>s.id===row.sender_id)
    if(!approvedSender)throw new RequestError('You no longer have permission to use this email’s sender. Ask the owner to review the approved sender settings.',403)
    if(approvedSender.from!==row.sender||approvedSender.reply_to!==row.reply_to)throw new RequestError('This sender changed after preview. Before sending starts, preview again; after sending starts, ask the owner to review the saved email. Retries cannot change the sender.',409)
    if(!apiKey)throw new RequestError('The owner needs to connect the email service before sending.',503)
    if(!direct&&!row.started_at){
      const currentRoster=await checked(admin.from('roster_at').select('event_id,location_id,league_id,team_id,player_id').eq('event_id',event.id).eq('location_id',event.location_id).eq('league_id',event.league_id).limit(501))
      if(!currentRoster.length||currentRoster.length>500)throw new RequestError('The roster changed. Preview the email again.',409)
      const [currentPlayers,currentTeams]=await Promise.all([
        checked(admin.from('players').select('id,email,location_id').eq('location_id',event.location_id).in('id',currentRoster.map((r:any)=>r.player_id)).limit(501)),
        checked(admin.from('teams').select('id,location_id,league_id').eq('location_id',event.location_id).eq('league_id',event.league_id).limit(501)),
      ])
      let audience;try{audience=resolveRecipients(currentRoster,currentPlayers,currentTeams,event)}catch{throw new RequestError('The roster changed. Preview the email again.',409)}
      if(JSON.stringify(audience.recipients.map((r:any)=>r.email))!==JSON.stringify(row.recipients.map((r:any)=>r.email))||audience.missing_count!==row.missing_count)throw new RequestError('The recipient list changed. Preview the email again before sending.',409)
    }
    if(direct&&!row.started_at){
      try{await reserveDirectAllowance(row.id,{
        readSlots:async(day:string)=>checked(admin.from('weekly_email_direct_quota').select('slot,campaign_id').eq('quota_day',day).eq('location_id',event.location_id).eq('user_id',auth.user.id).limit(51)),
        claimSlot:async(day:string,slot:number,campaignId:string)=>{
          const result=await admin.from('weekly_email_direct_quota').insert({quota_day:day,location_id:event.location_id,user_id:auth.user.id,slot,campaign_id:campaignId})
          if(result.error?.code==='23505')return false
          if(result.error)throw result.error
          return true
        },
      })}catch(e){if(e instanceof DirectQuotaError)throw new RequestError(e.message,429);throw new RequestError('The direct-email sending allowance could not be checked. No new send was started; ask the owner to check setup.',503)}
    }
    const token=crypto.randomUUID(), now=new Date()
    const claimed=await table().update({lease_token:token,lease_until:new Date(now.getTime()+180000).toISOString(),started_at:row.started_at||now.toISOString()})
      .eq('id',row.id).or(`lease_until.is.null,lease_until.lt.${now.toISOString()}`).select('*').maybeSingle()
    if(claimed.error)throw claimed.error
    if(!claimed.data)throw new RequestError('This email is already being processed. Wait a moment, then check status.',409)
    row=claimed.data
    try {
      const result=await sendChunk(row,{
        save:async (state:any)=>{
          const saved=await table().update({recipients:state.recipients,last_error:state.last_error,lease_until:new Date(Date.now()+180000).toISOString()}).eq('id',row.id).eq('lease_token',token).select('id').maybeSingle()
          if(saved.error||!saved.data)throw new Error('Send progress could not be recorded. Check status before retrying.')
        },
        send:async (payload:any,key:string)=>{
          const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)})
          const body=await response.json()
          if(!response.ok||!body.id)throw new Error('The email service did not confirm acceptance.')
          return body
        },
        pause:()=>new Promise(resolve=>setTimeout(resolve,600)),
      })
      return json(summary(result))
    } finally {
      // An uncertain release expires automatically. Never erase another worker's lease.
      await table().update({lease_token:null,lease_until:null}).eq('id',row.id).eq('lease_token',token)
    }
  } catch(error) {
    if(error instanceof RequestError)return json({error:error.message},error.status)
    // Never expose database details, credentials, recipient addresses, or provider payloads.
    return json({error:'Weekly Email could not finish. Check status before retrying; some messages may already have been accepted.'},500)
  }
})

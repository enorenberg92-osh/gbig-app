import { createClient } from 'npm:@supabase/supabase-js@2'
import { authUsersByEmail, LEAGUE_VENUES, processLeagueRegistration } from '../_shared/leagueWelcome.mjs'

const headers = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods':'POST, OPTIONS' }
const json = (body:unknown,status=200) => new Response(JSON.stringify(body),{status,headers:{...headers,'Content-Type':'application/json'}})
Deno.serve(async req => {
  if(req.method==='OPTIONS')return new Response('ok',{headers})
  if(req.method!=='POST')return json({error:'Use POST.'},405)
  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i,'').trim()
    if(!jwt)return json({error:'Sign in as a staff member first.'},401)
    const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:`Bearer ${jwt}`}}})
    const {data:auth,error:authError}=await client.auth.getUser(jwt)
    if(authError || !auth.user)return json({error:'Your session expired. Sign in again.'},401)
    const {league_id,player_ids}=await req.json()
    if(typeof league_id!=='string' || (player_ids!=null && (!Array.isArray(player_ids)||player_ids.length>300||player_ids.some((id:unknown)=>typeof id!=='string'))))return json({error:'Choose a league and valid player records.'},400)
    const admin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{autoRefreshToken:false,persistSession:false}})
    const {data:league,error:leagueError}=await admin.from('league_config').select('id,name,location_id,is_working').eq('id',league_id).maybeSingle()
    if(leagueError)throw leagueError
    if(!league)return json({error:'League not found.'},404)
    const [staff,superAdmin]=await Promise.all([
      admin.from('location_admins').select('role').eq('user_id',auth.user.id).eq('location_id',league.location_id).maybeSingle(),
      admin.from('super_admins').select('user_id').eq('user_id',auth.user.id).maybeSingle(),
    ])
    if(staff.error)throw staff.error
    if(superAdmin.error)throw superAdmin.error
    if(!staff.data&&!superAdmin.data)return json({error:'You are not staff for this venue.'},403)
    if(!league.is_working)return json({error:'Choose this session as the working league first.'},409)
    const {data:location,error:locationError}=await admin.from('locations').select('slug').eq('id',league.location_id).single()
    if(locationError)throw locationError
    if(!LEAGUE_VENUES[location.slug as keyof typeof LEAGUE_VENUES])return json({error:'This venue needs a welcome email configuration.'},409)
    const {data:jobs,error:claimError}=await admin.rpc('service_claim_league_onboarding',{p_league_id:league_id,p_player_ids:player_ids || null,p_limit:10})
    if(claimError)throw claimError
    const apiKey=Deno.env.get('RESEND_API_KEY')
    const emailConfigured=Boolean(apiKey)
    if(!jobs?.length)return json({results:[],email_configured:emailConfigured})
    const results=[]
    try {
      const users=await authUsersByEmail(admin)
      for(const job of jobs) {
        const {data:player,error:playerError}=await admin.from('players').select('id,name,email,location_id,user_id').eq('id',job.player_id).eq('location_id',league.location_id).single()
        if(playerError)throw playerError
        const save=async (patch:Record<string,unknown>) => {
          const {data,error}=await admin.from('league_onboarding').update({...patch,updated_at:new Date().toISOString()}).eq('id',job.id).eq('lease_token',job.lease_token).select('id').single()
          if(error||!data)throw new Error('Registration is being handled by another staff request. Refresh its status.')
        }
        results.push(await processLeagueRegistration({job,player,slug:location.slug,leagueName:league.name,users,admin,save,emailConfigured,
          verifyPlayer:async () => {
            const clean=(player.email||'').trim().toLowerCase()
            const pattern=clean.replace(/[\\%_]/g,'\\$&')
            const {data:matches,error:matchError}=await admin.from('players').select('id').eq('location_id',league.location_id).ilike('email',pattern).limit(2)
            if(matchError)throw matchError
            if(matches?.length!==1)throw new Error('Different golfers share this email. Give each golfer a separate email first.')
            if(player.user_id&&users.get(clean)?.id!==player.user_id)throw new Error('The roster email differs from the linked app account. Ask staff to correct it before registering.')
          },
          sendEmail:async (payload:unknown,key:string) => {
            const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)})
            const body=await response.json()
            if(!response.ok || !body.id)throw new Error(response.status===429?'The email service is busy or its sending limit was reached. App access is ready; retry the email later.':`Welcome email was not accepted by the email service (${response.status}). Check the sender setup or retry.`)
            // Stay below the provider's default request rate for large rosters.
            await new Promise(resolve=>setTimeout(resolve,600))
            return body
          },
        }))
      }
    } finally {
      for(const job of jobs)await admin.from('league_onboarding').update({lease_token:null,lease_until:null}).eq('id',job.id).eq('lease_token',job.lease_token)
    }
    return json({results,email_configured:emailConfigured})
  } catch(error) { return json({error:error instanceof Error?error.message:'Registration could not finish. Retry from the staff screen.'},500) }
})

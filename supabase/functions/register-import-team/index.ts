import { createClient } from 'npm:@supabase/supabase-js@2'
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS'}
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...headers,'Content-Type':'application/json'}})
Deno.serve(async req=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers})
  if(req.method!=='POST')return json({error:'Use POST.'},405)
  try {
    const jwt=(req.headers.get('Authorization')||'').replace(/^Bearer\s+/i,'').trim()
    if(!jwt)return json({error:'Sign in as staff before importing.'},401)
    const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_ANON_KEY')!,{global:{headers:{Authorization:`Bearer ${jwt}`}}})
    const {data:auth,error:authError}=await client.auth.getUser(jwt)
    if(authError||!auth.user)return json({error:'Your session expired. Sign in again.'},401)
    const {league_id,payload}=await req.json()
    if(typeof league_id!=='string'||!payload)return json({error:'Choose a session and partnership.'},400)
    // The caller's JWT is forwarded to the atomic RPC, which checks venue staff
    // permission and the working session before writing any roster records.
    const {data,error}=await client.rpc('admin_import_league_team',{p_league_id:league_id,p_payload:payload})
    if(error)return json({error:error.message},400)
    // Start account preparation on the server as each partnership is saved.
    // Browser navigation cannot cancel the subsequent server-side request.
    try {
      const registered=await client.functions.invoke('league-onboarding',{body:{league_id,player_ids:data.player_ids},headers:{Authorization:`Bearer ${jwt}`}})
      return json({...data,onboarding_error:registered.error? 'The partnership is saved. Retry pending registrations to finish app access and welcomes.':registered.data?.error||null})
    } catch {
      return json({...data,onboarding_error:'The partnership is saved. Retry pending registrations to finish app access and welcomes.'})
    }
  } catch(error){return json({error:error instanceof Error?error.message:'The partnership could not be imported.'},500)}
})

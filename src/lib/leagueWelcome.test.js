import { describe,it,expect,vi } from 'vitest'
import { buildLeagueWelcome,processLeagueRegistration,authUsersByEmail } from '../../supabase/functions/_shared/leagueWelcome.mjs'
function fixture(options={}) {
  const job={id:'job-1',email:'alex@example.invalid',account_status:'pending',email_status:'pending',...options.job}
  const player={id:'player-1',name:'Alex Smith',email:'alex@example.invalid',...options.player}
  const updates=[], users=options.users||new Map()
  const admin={auth:{admin:{createUser:vi.fn(async()=>({data:{user:{id:'auth-1',email:player.email}},error:null}))}},rpc:vi.fn(async()=>({error:null}))}
  const sendEmail=vi.fn(async()=>({id:'mail-1'}))
  const args={slug:'gbig',leagueName:'Fall 2026',admin,save:async patch=>{updates.push(patch);Object.assign(job,patch)},sendEmail,emailConfigured:true,...options,job,player,users}
  return {args,job,admin,updates,sendEmail}
}
describe('automatic league access and welcome',()=>{
  it.each(['gbig','appleton'])('uses the correct %s sender and app link',slug=>{
    const m=buildLeagueWelcome({slug,leagueName:'Fall 2026',playerName:'Alex Smith',email:'alex@example.invalid',loginKind:'new'})
    expect(m.from).toContain(slug==='gbig'?'trent@greenbayindoorgolf.com':'jordan@appletonindoorgolf.com')
    expect(m.text).toContain(slug==='gbig'?'https://gbig-app.vercel.app/league':'https://appleton-app.vercel.app/league')
    expect(m.text).toContain('password (all lowercase)');expect(m.to).toEqual(['alex@example.invalid'])
  })
  it('creates a confirmed login with the agreed starting password before emailing',async()=>{
    const f=fixture();const result=await processLeagueRegistration(f.args)
    expect(f.admin.auth.admin.createUser).toHaveBeenCalledWith({email:'alex@example.invalid',password:'password',email_confirm:true})
    expect(f.admin.rpc).toHaveBeenCalledWith('service_link_player_account',{p_player_id:'player-1',p_user_id:'auth-1',p_email:'alex@example.invalid'})
    expect(result.account_status).toBe('ready');expect(result.email_status).toBe('sent')
  })
  it('keeps existing app passwords and tells returning users to use them',async()=>{
    const f=fixture({users:new Map([['alex@example.invalid',{id:'old-auth',email:'alex@example.invalid'}]])});await processLeagueRegistration(f.args)
    expect(f.admin.auth.admin.createUser).not.toHaveBeenCalled();expect(f.sendEmail.mock.calls[0][0].text).toContain('existing app password')
    expect(f.sendEmail.mock.calls[0][0].text).not.toContain('starting password')
  })
  it('does not send again after a recorded success',async()=>{
    const f=fixture();await processLeagueRegistration(f.args);await processLeagueRegistration(f.args)
    expect(f.sendEmail).toHaveBeenCalledTimes(1);expect(f.admin.auth.admin.createUser).toHaveBeenCalledTimes(1)
  })
  it('creates access when email setup is absent and marks the welcome as waiting',async()=>{
    const f=fixture({emailConfigured:false});const r=await processLeagueRegistration(f.args)
    expect(r.account_status).toBe('ready');expect(r.email_status).toBe('not_configured');expect(f.sendEmail).not.toHaveBeenCalled()
  })
  it('never creates an account or sends a welcome for a missing email',async()=>{
    const f=fixture({player:{email:null}});const r=await processLeagueRegistration(f.args)
    expect(r.account_status).toBe('needs_email');expect(f.admin.auth.admin.createUser).not.toHaveBeenCalled();expect(f.sendEmail).not.toHaveBeenCalled()
  })
  it('rejects shared emails before account creation',async()=>{
    const f=fixture({verifyPlayer:async()=>{throw new Error('Different golfers share this email')}});const r=await processLeagueRegistration(f.args)
    expect(r.account_status).toBe('error');expect(f.admin.auth.admin.createUser).not.toHaveBeenCalled();expect(f.sendEmail).not.toHaveBeenCalled()
  })
  it('never emails when the roster account link fails',async()=>{
    const f=fixture();f.admin.rpc.mockResolvedValue({error:{message:'Different golfers share this email'}})
    expect((await processLeagueRegistration(f.args)).account_status).toBe('error');expect(f.sendEmail).not.toHaveBeenCalled()
  })
  it('retains new-password advice after an interrupted link and retry',async()=>{
    const f=fixture();f.admin.rpc.mockResolvedValueOnce({error:{message:'temporary error'}})
    await processLeagueRegistration(f.args);await processLeagueRegistration(f.args)
    expect(f.admin.auth.admin.createUser).toHaveBeenCalledTimes(1);expect(f.sendEmail.mock.calls[0][0].text).toContain('starting password')
  })
  it('retries an email with the same payload and idempotency key',async()=>{
    const f=fixture();f.sendEmail.mockRejectedValueOnce(new Error('timeout'))
    expect((await processLeagueRegistration(f.args)).email_status).toBe('error')
    f.args.leagueName='Edited league name';await processLeagueRegistration(f.args)
    expect(f.sendEmail.mock.calls[0]).toEqual(f.sendEmail.mock.calls[1]);expect(f.admin.auth.admin.createUser).toHaveBeenCalledTimes(1)
  })
  it('does not automatically retry an uncertain send outside the safe duplicate window',async()=>{
    const f=fixture({job:{email_attempted_at:'2026-10-01T12:00:00Z'},now:()=>new Date('2026-10-06T12:00:00Z')})
    expect((await processLeagueRegistration(f.args)).email_status).toBe('review');expect(f.sendEmail).not.toHaveBeenCalled()
  })
  it('escapes player and league text in email HTML',()=>{
    const m=buildLeagueWelcome({slug:'appleton',leagueName:'Fall <script>',playerName:'A & B',email:'a@example.invalid',loginKind:'new'})
    expect(m.html).toContain('Fall &lt;script&gt;');expect(m.html).not.toContain('Fall <script>')
  })
  it('fully checks a user directory larger than one page',async()=>{
    const listUsers=vi.fn().mockResolvedValueOnce({data:{users:Array.from({length:1000},(_,i)=>({id:String(i),email:`u${i}@example.invalid`}))}}).mockResolvedValueOnce({data:{users:[{id:'last',email:'last@example.invalid'}]}})
    const users=await authUsersByEmail({auth:{admin:{listUsers}}});expect(users.size).toBe(1001);expect(users.get('last@example.invalid').id).toBe('last')
  })
})

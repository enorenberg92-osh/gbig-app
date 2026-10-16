import fs from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import { reserveDirectAllowance, DirectQuotaError, authorizedSenders, directRecipient, resolveEmailAudience, validateMessage, resolveRecipients, summary, sendChunk } from '../../supabase/functions/_shared/weeklyEmail.mjs'
const event={id:'round',location_id:'gb',league_id:'league'}
const roster=[{event_id:'round',location_id:'gb',league_id:'league',team_id:'team',player_id:'a'},{event_id:'round',location_id:'gb',league_id:'league',team_id:'team',player_id:'b'}]
const teams=[{id:'team',location_id:'gb',league_id:'league'}]
const players=[{id:'a',location_id:'gb',email:' A@example.com '},{id:'b',location_id:'gb',email:'b@example.com'}]
const job=(n=2)=>({id:'draft',sender_id:'trent',sender:'Trent <trent@greenbayindoorgolf.com>',reply_to:'trent@greenbayindoorgolf.com',subject:'Hello',body:'Weekly news',recipients:Array.from({length:n},(_,i)=>({email:`p${i}@example.com`,status:'pending',attempted_at:null})),missing_count:0,started_at:'2026-10-16T10:00:00Z'})
const now=()=>new Date('2026-10-16T10:00:00Z')
describe('Weekly Email input and venue boundaries',()=>{
 it('validates subject and plain-text body',()=>{expect(validateMessage(' Hi ',' text ')).toEqual({subject:'Hi',text:'text'});for(const subject of ['', 'a\nb','a'.repeat(201)])expect(()=>validateMessage(subject,'body')).toThrow();for(const body of ['','x'.repeat(20001)])expect(()=>validateMessage('subject',body)).toThrow()})
 it('resolves only the round roster and normalizes duplicate addresses',()=>{const p=[...players,{id:'outside',location_id:'gb',email:'outside@example.com'}];p[1]={...p[1],email:'a@EXAMPLE.com'};expect(resolveRecipients(roster,p,teams,event).recipients.map(r=>r.email)).toEqual(['a@example.com'])})
 it('reports skipped missing or malformed addresses',()=>{const p=[players[0],{...players[1],email:'bad\n@example.com'}];expect(resolveRecipients(roster,p,teams,event).missing_count).toBe(1)})
 it('fails closed across venue, league, event, and team boundaries',()=>{for(const patch of [{location_id:'appleton'},{league_id:'other'},{event_id:'other'},{team_id:'other'},{player_id:'other'}])expect(()=>resolveRecipients([{...roster[0],...patch}],players,teams,event)).toThrow();expect(()=>resolveRecipients(roster,[{...players[0],location_id:'appleton'},players[1]],teams,event)).toThrow()})
 it('rejects duplicate roster players, empty and oversized rosters',()=>{expect(()=>resolveRecipients([roster[0],roster[0]],players,teams,event)).toThrow();expect(()=>resolveRecipients([],players,teams,event)).toThrow();expect(()=>resolveRecipients(Array(501).fill(roster[0]),players,teams,event)).toThrow()})
})
describe('Weekly Email durable sends, without network calls',()=>{
 it('saves each attempt before sending, one recipient per private email',async()=>{const operations=[];const save=vi.fn(async s=>operations.push(['save',structuredClone(s)]));const send=vi.fn(async(p,k)=>{operations.push(['send',p,k]);return{id:k}});const result=await sendChunk(job(),{save,send,now});expect(operations[0][0]).toBe('save');expect(operations[0][1].recipients[0].attempted_at).toBe(now().toISOString());expect(send.mock.calls[0][0].to).toEqual(['p0@example.com']);expect(send.mock.calls[0][0]).not.toHaveProperty('bcc');expect(summary(result).status).toBe('accepted');expect(summary(result)).not.toHaveProperty('recipients')})
 it('does not contact provider if initial durable write fails',async()=>{const send=vi.fn();await expect(sendChunk(job(),{save:async()=>{throw Error('db')},send,now})).rejects.toThrow();expect(send).not.toHaveBeenCalled()})
 it('retries uncertain calls using exactly the same payload and key',async()=>{const calls=[];let saved;const save=async s=>{saved=structuredClone(s)};await sendChunk(job(1),{save,send:async(p,k)=>{calls.push([p,k]);throw Error('timeout')},now});expect(saved.recipients[0].status).toBe('pending');const result=await sendChunk(saved,{save,send:async(p,k)=>{calls.push([p,k]);return{id:'accepted'}},now});expect(calls[1]).toEqual(calls[0]);expect(summary(result).status).toBe('accepted')})
 it('does not resend accepted recipients after partial failure',async()=>{let saved;let n=0;await sendChunk(job(),{save:async s=>{saved=structuredClone(s)},send:async()=>{if(n++)throw Error('timeout');return{id:'ok'}},now});const send=vi.fn(async()=>({id:'next'}));await sendChunk(saved,{save:async()=>{},send,now});expect(send).toHaveBeenCalledTimes(1);expect(send.mock.calls[0][0].to).toEqual(['p1@example.com'])})
 it('stops after ten recipients for bounded requests',async()=>{const send=vi.fn(async()=>({id:'ok'}));const result=await sendChunk(job(12),{save:async()=>{},send,now});expect(send).toHaveBeenCalledTimes(10);expect(summary(result).pending_count).toBe(2)})
 it('never retries an uncertain attempt outside the safe provider window',async()=>{const j=job(1);j.recipients[0].attempted_at='2026-10-15T10:00:00Z';const send=vi.fn();const result=await sendChunk(j,{save:async()=>{},send,now});expect(send).not.toHaveBeenCalled();expect(summary(result).review_count).toBe(1);expect(summary(result).status).toBe('review')})
 it('accepted history is a no-op on retries',async()=>{const j=job(1);j.recipients[0].status='accepted';const send=vi.fn();await sendChunk(j,{save:async()=>{},send,now});expect(send).not.toHaveBeenCalled()})
})


describe('Approved senders by venue and signed-in administrator',()=>{
 const configs=[
  {id:'trent',location_id:'gb',display_name:'Trent',email:'trent@greenbayindoorgolf.com',reply_to:'trent@greenbayindoorgolf.com',enabled:true,is_default:true},
  {id:'jordan',location_id:'ap',display_name:'Jordan',email:'jordan@appletonindoorgolf.com',reply_to:'jordan@appletonindoorgolf.com',enabled:true,is_default:true},
  {id:'other',location_id:'gb',display_name:'Staff',email:'staff@greenbayindoorgolf.com',reply_to:'staff@greenbayindoorgolf.com',enabled:true,is_default:false},
 ]
 it('requires explicit user assignment and the correct venue',()=>{
  const assignments=[{sender_id:'trent',user_id:'admin'},{sender_id:'jordan',user_id:'admin'},{sender_id:'other',user_id:'other-admin'}]
  expect(authorizedSenders(configs,assignments,'admin','gb').map(s=>s.id)).toEqual(['trent'])
  expect(authorizedSenders(configs,assignments,'admin','ap').map(s=>s.id)).toEqual(['jordan'])
  expect(authorizedSenders(configs,assignments,'unassigned','gb')).toEqual([])
 })
 it('orders the authorized venue default first and supports added venues without code mapping',()=>{
  const assignments=configs.map(s=>({sender_id:s.id,user_id:'admin'}))
  expect(authorizedSenders(configs,assignments,'admin','gb').map(s=>s.id)).toEqual(['trent','other'])
  const extra={...configs[0],id:'new',location_id:'new-venue',email:'owner@newvenue.example',reply_to:'owner@newvenue.example'}
  expect(authorizedSenders([extra],[{sender_id:'new',user_id:'admin'}],'admin','new-venue')[0].from).toBe('Trent <owner@newvenue.example>')
 })
 it('hides disabled senders and rejects header injection in configuration',()=>{
  const assignments=[{sender_id:'trent',user_id:'admin'}]
  expect(authorizedSenders([{...configs[0],enabled:false}],assignments,'admin','gb')).toEqual([])
  for(const patch of [{display_name:'Trent\nBcc:evil'},{email:'trent@example.com\n'+'Bcc:evil'},{reply_to:'not an email'}])expect(()=>authorizedSenders([{...configs[0],...patch}],assignments,'admin','gb')).toThrow()
 })
 it('freezes chosen sender and reply address through retry payloads',async()=>{
  const j=job(1);j.sender_id='jordan';j.sender='Jordan <jordan@appletonindoorgolf.com>';j.reply_to='jordan@appletonindoorgolf.com'
  const send=vi.fn(async()=>({id:'sent'}));const result=await sendChunk(j,{save:async()=>{},send,now})
  expect(send.mock.calls[0][0].from).toBe(j.sender);expect(send.mock.calls[0][0].reply_to).toBe(j.reply_to)
  expect(summary(result).sender_id).toBe('jordan')
 })
})


describe('Direct email isolation',()=>{
 it('accepts exactly one explicit address and never supplies a roster',()=>{
  expect(directRecipient(' Owner@Example.com ')).toEqual({recipients:[{email:'owner@example.com',status:'pending',attempted_at:null}],missing_count:0})
  for(const value of ['',undefined,['owner@example.com'],'a@example.com,b@example.com','Owner <a@example.com>','a@example.com\nBcc:b@example.com'])expect(()=>directRecipient(value)).toThrow()
 })
 it('retries only the frozen direct target, sender and content',async()=>{
  const j={...job(1),mode:'direct',compose_id:'compose',...directRecipient('owner@example.com')};let saved;const calls=[]
  await sendChunk(j,{save:async state=>{saved=structuredClone(state)},send:async(p,k)=>{calls.push([p,k]);throw Error('timeout')},now})
  await sendChunk(saved,{save:async()=>{},send:async(p,k)=>{calls.push([p,k]);return{id:'ok'}},now})
  expect(calls[0]).toEqual(calls[1]);expect(calls[0][0].to).toEqual(['owner@example.com']);expect(summary(j).to).toBe('owner@example.com');expect(summary(j).mode).toBe('direct')
 })
})


it('never calls the league roster loader for a direct/test preview',async()=>{
 const rosterLoader=vi.fn(async()=>{throw Error('Must never load roster for a direct email')})
 const result=await resolveEmailAudience('direct','owner@example.com',rosterLoader)
 expect(result.recipients.map(r=>r.email)).toEqual(['owner@example.com']);expect(rosterLoader).not.toHaveBeenCalled()
 await expect(resolveEmailAudience('direct','invalid',rosterLoader)).rejects.toThrow();expect(rosterLoader).not.toHaveBeenCalled()
 await expect(resolveEmailAudience('unknown','owner@example.com',rosterLoader)).rejects.toThrow();expect(rosterLoader).not.toHaveBeenCalled()
})


it('has no push/alert integration in either email path',()=>{
 const endpoint=fs.readFileSync(new URL('../../supabase/functions/weekly-email/index.ts',import.meta.url),'utf8')
 const shared=fs.readFileSync(new URL('../../supabase/functions/_shared/weeklyEmail.mjs',import.meta.url),'utf8')
 expect(endpoint+shared).not.toMatch(/send-alert|send-social-push|push_subscriptions|webpush|publish_week/)
})


describe('Atomic direct-email daily allowance',()=>{
 function store(){const rows=[];return{rows,readSlots:async day=>rows.filter(r=>r.day===day),claimSlot:async(day,slot,campaign_id)=>{if(rows.some(r=>r.day===day&&(r.slot===slot||r.campaign_id===campaign_id)))return false;rows.push({day,slot,campaign_id});return true},now}}
 it('allows 50 new campaigns and blocks the 51st with reset information',async()=>{
  const storage=store();for(let i=0;i<50;i++)await reserveDirectAllowance('campaign-'+i,storage)
  await expect(reserveDirectAllowance('campaign-51',storage)).rejects.toThrow(/2026-10-17 00:00 UTC/)
  expect(storage.rows).toHaveLength(50)
 })
 it('repeated and concurrent reservations cannot charge the same campaign twice or exceed the cap',async()=>{
  const storage=store();await Promise.all(Array.from({length:5},()=>reserveDirectAllowance('same',storage)));expect(storage.rows).toHaveLength(1)
  const results=await Promise.allSettled(Array.from({length:60},(_,i)=>reserveDirectAllowance('parallel-'+i,storage)))
  expect(storage.rows).toHaveLength(50);expect(results.filter(r=>r.status==='rejected')).toHaveLength(11)
  expect(results.find(r=>r.status==='rejected').reason).toBeInstanceOf(DirectQuotaError)
 })
 it('gives a new day a separate allowance and propagates storage failures',async()=>{
  const storage=store();await reserveDirectAllowance('one',storage);await reserveDirectAllowance('two',{...storage,now:()=>new Date('2026-10-17T00:00:00Z')});expect(storage.rows.map(r=>r.day)).toEqual(['2026-10-16','2026-10-17'])
  await expect(reserveDirectAllowance('three',{...storage,readSlots:async()=>{throw Error('db')}})).rejects.toThrow('db')
 })
})

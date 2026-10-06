import {it,expect,vi} from 'vitest'
import {finishLeagueRegistrations,registrationSummary} from './leagueRegistration'
it('finishes 300 golfers in bounded batches without repeating a failed email in the same run',async()=>{
  const invoke=vi.fn(async(_name,{body})=>({data:{results:body.player_ids.map(id=>({player_id:id,email_status:id==='p1'?'error':'sent'}))}}))
  const client={auth:{getSession:async()=>({data:{session:{access_token:'test-only-token'}}})},functions:{invoke}}
  const progress=vi.fn(),ids=Array.from({length:300},(_,i)=>'p'+i)
  const results=await finishLeagueRegistrations(client,'league',ids,progress)
  expect(invoke).toHaveBeenCalledTimes(30);expect(results).toHaveLength(300)
  expect(invoke.mock.calls.flatMap(c=>c[1].body.player_ids)).toEqual(ids);expect(progress).toHaveBeenLastCalledWith(300,300)
})
it('stops after a service error and leaves persisted registrations for a later retry',async()=>{
  const invoke=vi.fn(async()=>({data:{error:'Session expired'}}))
  const client={auth:{getSession:async()=>({data:{session:{access_token:'test-only-token'}}})},functions:{invoke}}
  await expect(finishLeagueRegistrations(client,'league',['a','b'])).rejects.toThrow('Session expired');expect(invoke).toHaveBeenCalledTimes(1)
})
it('keeps access-ready, missing-email and waiting-email counts distinct',()=>{
  expect(registrationSummary([{account_status:'ready',email_status:'sent'},{account_status:'ready',email_status:'not_configured'},{account_status:'needs_email',email_status:'needs_email'}])).toMatchObject({total:3,ready:2,sent:1,waiting:1,needsEmail:1})
})

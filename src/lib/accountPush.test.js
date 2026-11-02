import { expect, it, vi } from 'vitest'
import { deliverAccountNotification } from '../../supabase/functions/_shared/accountPush.mjs'
const notification = {id:'n',kind:'sub_request',location_id:'green-bay',user_id:'admin',title:'Sub requested',body:'Review it',url:'/league/admin/subs',event_id:'week-2'}
function setup(tables={}, overrides={}) {
  const queries=[]
  const admin={from(table){
    const filters=[];let deletion=false
    const query={select(){return query},eq(k,v){filters.push([k,v]);return query},in(k,v){filters.push([k,v]);return query},delete(){deletion=true;return query},
      then(resolve,reject){queries.push({table,filters,deletion});return Promise.resolve({data:tables[table]||[],error:null}).then(resolve,reject)}}
    return query
  }}
  const context={admin,send:vi.fn(async()=>{}),finish:vi.fn(async()=>{}),...overrides}
  return {context,queries}
}
const subscription=(id='device-1')=>({id,endpoint:'https://push.invalid/'+id,p256dh:'key',auth_key:'auth'})
it('only targets devices belonging to the location admin account',async()=>{
  const {context,queries}=setup({location_admins:[{}],push_subscriptions:[subscription()]})
  await deliverAccountNotification(notification,context)
  expect(queries.find(q=>q.table==='push_subscriptions').filters).toEqual([['user_id','admin'],['location_id','green-bay']])
  expect(context.send).toHaveBeenCalledWith(subscription(),expect.objectContaining({url:'/league/admin/subs',tag:'account-n'}))
  expect(context.finish).toHaveBeenCalledWith(notification,'sent',[subscription().endpoint],null)
})
it('keeps the account alert even if no phone is subscribed and skips a revoked admin',async()=>{
  const {context}=setup({location_admins:[{}]})
  await deliverAccountNotification(notification,context)
  expect(context.finish).toHaveBeenCalledWith(notification,'no_devices',[],null)
  const revoked=setup()
  await deliverAccountNotification(notification,revoked.context)
  expect(revoked.context.send).not.toHaveBeenCalled()
  expect(revoked.context.finish).toHaveBeenCalledWith(notification,'skipped',[],null)
})
it('rechecks scores immediately before delivery, including substitute-covered pending cards',async()=>{
  const {context}=setup({events:[{}],players:[{id:'p'}],roster_at:[{player_id:'p'}],scores:[{player_id:'p'}],push_subscriptions:[subscription()]})
  await deliverAccountNotification({...notification,kind:'score_reminder'},context)
  expect(context.send).not.toHaveBeenCalled()
  expect(context.finish.mock.calls[0][1]).toBe('skipped')
})
it('retries only failed devices, prunes expired subscriptions, and preserves successful endpoints',async()=>{
  const first=subscription('done'),expired=subscription('expired'),failed=subscription('failed')
  const {context,queries}=setup({location_admins:[{}],push_subscriptions:[first,expired,failed]})
  context.send.mockImplementation(async s=>{throw {statusCode:s.id==='expired'?410:503}})
  const n={...notification,delivered_endpoints:[first.endpoint]}
  await deliverAccountNotification(n,context)
  expect(context.send).toHaveBeenCalledTimes(2)
  expect(queries.find(q=>q.deletion).filters).toContainEqual(['id','expired'])
  expect(context.finish).toHaveBeenCalledWith(n,'pending',[first.endpoint],expect.any(String))
})
it('does not retry a successful device when another failed',async()=>{
  const {context}=setup({location_admins:[{}],push_subscriptions:[subscription('ok'),subscription('bad')]})
  context.send.mockImplementation(async s=>{if(s.id==='bad')throw {statusCode:503}})
  await deliverAccountNotification(notification,context)
  expect(context.finish).toHaveBeenCalledWith(notification,'pending',[subscription('ok').endpoint],expect.any(String))
})
it('fails closed on database errors and missing push configuration',async()=>{
  const {context}=setup({location_admins:[{}]},{configured:false})
  await deliverAccountNotification(notification,context)
  expect(context.send).not.toHaveBeenCalled()
  expect(context.finish.mock.calls[0][1]).toBe('pending')
})

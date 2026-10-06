import { it, expect } from 'vitest'
import { aggregateSeason } from './seasonStandings'
it('preserves historical teams across swaps and excludes substitute mirrors and superseded penalties',()=>{
  const row=(id,event,player,team,net,type='played')=>({id,event_id:event,player_id:player,team_id:team,net_total:net,gross_total:type==='played'?40:null,status:'verified',entry_type:type})
  const scores=[row('a','w1','p1','t1',35),row('b','w2','p1','t2',36),row('c','w1','sub','t1',20),row('d','w1','p1','t1',50,'missed_penalty')]
  const roster=[{event_id:'w1',player_id:'p1',team_id:'t1'},{event_id:'w2',player_id:'p1',team_id:'t2'}]
  const actual=aggregateSeason(scores,[{id:'t1',name:'One'},{id:'t2',name:'Two'}],roster)
  expect(actual.map(r=>[r.teamId,r.teamNet,r.rounds])).toEqual([['t1',35,1],['t2',36,1]])
})

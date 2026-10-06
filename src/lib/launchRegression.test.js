import { it, expect, vi } from 'vitest'
import { skinScoreRows, calcSkins } from './skinsUtils'
import { closeoutSkins } from './closeoutUtils'
import { rosterScores } from './scoreSelection'
import { handicapRounds, calcHandicap, recalcPlayerHandicap } from './handicapCalc'
import { ledgerBalances } from './ledgerUtils'
import { loadSkinsRound } from './loadSkinsRound'

const score = (player, holes, extra = {}) => ({id: player, player_id: player, event_id:'w1', status:'verified', entry_type:'played', hole_scores:holes, ...extra})
const players = ['regular', 'partner', 'sub'].map(id => ({id, name:id, in_skins:true}))
const roster = ['regular', 'partner'].map(player_id => ({event_id:'w1',player_id,team_id:'historic-team'}))

it('counts substitute coverage once in skins, preserving eligibility of the roster slot', () => {
  const scores = [score('regular',[2,4],{sub_played:true}), score('partner',[4,4]), score('sub',[2,4]), score('regular',null,{entry_type:'missed_penalty'})]
  const rows = skinScoreRows(scores,players,roster)
  expect(calcSkins(Object.fromEntries(rows.map(s => [s.player_id,s.hole_scores])),2)).toEqual({1:'regular',2:null})
  expect(closeoutSkins(scores,players,{num_holes:2,start_hole:10},roster)).toEqual([{hole:10,player:players[0],score:2}])
  expect(skinScoreRows(scores,[...players.map(p=>({...p,in_skins:p.id!=='regular'}))],roster)).toHaveLength(1)
})

it('recaps use the historical roster and prefer the played score over its old penalty', () => {
  const rows = rosterScores([score('regular',[4],{team_id:'today-team'}),score('regular',null,{entry_type:'missed_penalty'}),score('sub',[4])],roster)
  expect(rows).toHaveLength(1)
  expect(rows[0].team_id).toBe('historic-team')
  expect(rows[0].entry_type).toBe('played')
})

it('handicap history honors explicit exclusions, scramble defaults and inclusion overrides', () => {
  const round = (id,date,format,config={},extra={}) => ({...score(id,[4]), gross_total:45, sub_played:false, events:{start_date:date,format,format_config:config,courses:{total_par:36}}, ...extra})
  const rows = handicapRounds([
    round('winter','2027-01-01','stroke'), round('scramble','2026-12-01','scramble',{}, {gross_total:20}),
    round('excluded','2026-11-01','stroke',{exclude_from_handicap:true}), round('included','2026-10-01','scramble',{exclude_from_handicap:false}),
    round('covered','2026-09-01','stroke',{}, {sub_played:true}), round('pending','2026-09-01','stroke',{}, {status:'pending'}),
  ])
  expect(rows.map(r=>r.id)).toEqual(['included','winter'])
  expect(calcHandicap(rows.map(r=>r.gross_total-r.events.courses.total_par))).toBe(8)
})

it('handicap writes always use the server calculation', async () => {
  const rpc=vi.fn().mockResolvedValue({data:{updated:true,newHcp:8},error:null})
  expect(await recalcPlayerHandicap({rpc},'regular')).toEqual({updated:true,newHcp:8})
  expect(rpc).toHaveBeenCalledWith('recalculate_player_handicap',{p_player_id:'regular'})
})

it('money balances keep same-name players and teams separate', () => {
  expect(ledgerBalances([{player_id:'alex-1',amount:10},{player_id:'alex-2',amount:20},{team_id:'alex-1',amount:30},{player_id:'alex-1',amount:-5}])
    .map(r=>[r.key,r.amt])).toEqual([['t:alex-1',30],['p:alex-2',20],['p:alex-1',5]])
})

it('failed skins reads are errors rather than a false no-winner result', async () => {
  const failure={message:'connection lost'}
  const chain={select(){return this},eq(){return this},single(){return Promise.resolve({error:failure})}}
  await expect(loadSkinsRound({from:()=>chain},'w1','venue')).rejects.toEqual(failure)
})

it('the shared skins reader loads a full 150-team field even with a lower server page cap', async () => {
  const field = Array.from({length:300},(_,i)=>({id:`p${i}`,name:`Golfer ${i}`,in_skins:true}))
  const rows = field.map((p,i)=>score(p.id,Array(9).fill(i===299?2:4)))
  const memberships=field.map(p=>({event_id:'w1',player_id:p.id,team_id:'t'}))
  const tables={scores:rows,players:field,roster_at:memberships}
  const ranges=[]
  const client={from(table){return {
    select(){return this},eq(){return this},order(){return this},
    single(){return Promise.resolve({data:{courses:{num_holes:9,total_par:36,hole_pars:Array(9).fill(4),start_hole:10}}})},
    range(from,to){ranges.push([table,from]);return Promise.resolve({data:tables[table].slice(from,Math.min(to+1,from+100)),error:null})},
  }}}
  const result=await loadSkinsRound(client,'w1','venue')
  expect(result.scores).toHaveLength(300)
  expect(Object.values(result.skins)).toEqual(Array(9).fill('p299'))
  expect(ranges.filter(r=>r[0]==='scores').map(r=>r[1])).toEqual([0,100,200,300])
})

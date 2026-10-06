import { describe, it, expect } from 'vitest'
import { closeoutStatus, closeoutSkins, closeoutResults, penaltyNet, recapText } from './closeoutUtils'
const roster = [{ team_id:'t',player_id:'a' },{ team_id:'t',player_id:'b' }]
const teams=[{id:'t',name:'Test team'}]
const players=[{id:'a',name:'Alex',in_skins:true},{id:'b',name:'Blair',in_skins:true}]
const score=(player_id,status='verified',extra={})=>({id:player_id,player_id,status,entry_type:'played',net_total:34,hole_scores:[4,4],...extra})
describe('league closeout',()=>{
  it('does not count a half-entered team as complete',()=>{
    const state=closeoutStatus(roster,[score('a')])
    expect(state.completeTeams).toEqual([])
    expect(state.missing).toEqual(['b'])
  })
  it('keeps pending submissions separate from missing rounds',()=>{
    const state=closeoutStatus(roster,[score('a'),score('b','pending')])
    expect(state.pending).toHaveLength(1); expect(state.missing).toEqual([]); expect(state.completeTeams).toEqual([])
  })
  it('rejected scores are missing until resubmitted',()=>{
    expect(closeoutStatus(roster,[score('a'),score('b','rejected')]).missing).toEqual(['b'])
  })
  it('uses played scores rather than an obsolete penalty',()=>{
    const state=closeoutStatus(roster,[score('a'),score('a','verified',{entry_type:'missed_penalty',net_total:45}),score('b')])
    expect(state.penalties).toEqual([]); expect(state.completeTeams).toEqual(['t'])
    expect(closeoutResults({format:'stroke'},[...state.effective.values()],roster,teams,players)[0].result).toBe('Net 68')
  })
  it('blocks empty, duplicate, and incomplete rosters',()=>{
    expect(closeoutStatus([],[]).rosterValid).toBe(false)
    expect(closeoutStatus([roster[0],roster[0]],[]).rosterValid).toBe(false)
    expect(closeoutStatus([roster[0]],[]).rosterValid).toBe(false)
  })
  it('matches database penalty math, including negative half-handicaps',()=>{
    expect(penaltyNet({total_par:36},2)).toBe(45)
    expect(penaltyNet({total_par:35},2.5)).toBe(45)
    expect(penaltyNet({total_par:36},-2.5)).toBe(40)
  })
  it('labels back-nine skins correctly and treats ties as no winner',()=>{
    const course={num_holes:2,start_hole:10}
    expect(closeoutSkins([score('a'),score('b')],players,course,roster)).toEqual([])
    expect(closeoutSkins([score('a','verified',{hole_scores:[3,4]}),score('b')],players,course,roster)[0].hole).toBe(10)
  })
  it('excludes pending and penalty rows from skins',()=>{
    const course={num_holes:2,start_hole:10}
    expect(closeoutSkins([score('a','pending'),score('b','verified',{entry_type:'missed_penalty',hole_scores:null})],players,course,roster)).toEqual([])
  })
  it('never produces an email recap before publishing',()=>{
    expect(recapText({event:{status:'open'}},'Test venue')).toBe('')
  })
  it('uses final penalties in the recap and omits disabled skins',()=>{
    const recap=recapText({event:{status:'closed',format:'stroke',name:'Week 1'},scores:[score('a'),score('b','verified',{entry_type:'missed_penalty',net_total:47})],roster,teams,players,course:{num_holes:2},matchups:[],skinsEnabled:false},'Test venue')
    expect(recap).toContain('Net 81'); expect(recap).not.toContain('SKINS')
  })
  it('does not rank a special format by unrelated stroke totals',()=>{
    expect(closeoutResults({format:'stableford'},[score('a','verified',{format_points:18}),score('b','verified',{format_points:22})],roster,teams,players)[0].name).toBe('Blair')
    expect(closeoutResults({format:'best_ball'},[score('a','verified',{format_points:30}),score('b','verified',{format_points:30})],roster,teams,players)[0].result).toBe('Net 30')
  })
})

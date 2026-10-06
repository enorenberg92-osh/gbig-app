import { describe, it, expect } from 'vitest'
import { fetchAllRows } from './fetchAllRows'
import { aggregateSeason } from './seasonStandings'

function paged(rows, cap = 1000, failAt = Infinity) {
  return () => ({ range: async (from, to) => from >= failAt
    ? { data: null, error: new Error('Connection interrupted') }
    : { data: rows.slice(from, Math.min(to + 1, from + cap)), error: null } })
}

describe('complete league reads', () => {
  it('loads a 150-team, 12-week season and reconciles all 3,600 results', async () => {
    const teams = Array.from({length:150}, (_,i)=>({id:`t${i}`,name:`Team ${i}`}))
    const scores = [], roster = []
    for (let week=1;week<=12;week++) for (let player=0;player<300;player++) {
      const row={id:`${week}:${player}`,event_id:`e${week}`,player_id:`p${player}`,team_id:`t${Math.floor(player/2)}`,gross_total:40,net_total:32,entry_type:'played',status:'verified'}
      scores.push(row);roster.push({event_id:row.event_id,player_id:row.player_id,team_id:row.team_id})
    }
    const loadedScores=await fetchAllRows(paged(scores))
    const loadedRoster=await fetchAllRows(paged(roster))
    expect(loadedScores.data).toHaveLength(3600)
    expect(loadedRoster.data).toHaveLength(3600)
    const result=aggregateSeason(loadedScores.data,teams,loadedRoster.data)
    expect(result).toHaveLength(150)
    expect(result.every(t=>t.teamNet===768&&t.rounds===12)).toBe(true)
    expect(result.reduce((sum,t)=>sum+t.teamNet,0)).toBe(115200)
  })
  it('handles a server cap below the requested page size', async () => {
    const rows=Array.from({length:1101},(_,i)=>i)
    expect((await fetchAllRows(paged(rows,200))).data).toEqual(rows)
  })
  it('rejects a failed later page instead of presenting partial standings', async () => {
    const result=await fetchAllRows(paged(Array.from({length:1500},(_,i)=>i),1000,500))
    expect(result.data).toBeNull()
    expect(result.error.message).toBe('Connection interrupted')
  })
})

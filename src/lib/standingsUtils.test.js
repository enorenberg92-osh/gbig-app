import { describe, expect, it } from 'vitest'
import { aggregateSeasonByTeam, sortStandingRows } from './standingsUtils'

describe('aggregateSeasonByTeam', () => {
  // Wk1: A = {p1, p2}, B = {p3, p4}. Wk2: p2 and p3 swap teams.
  const roster = [
    { event_id: 'e1', team_id: 'A', player_id: 'p1' },
    { event_id: 'e1', team_id: 'A', player_id: 'p2' },
    { event_id: 'e1', team_id: 'B', player_id: 'p3' },
    { event_id: 'e1', team_id: 'B', player_id: 'p4' },
    { event_id: 'e2', team_id: 'A', player_id: 'p1' },
    { event_id: 'e2', team_id: 'A', player_id: 'p3' },
    { event_id: 'e2', team_id: 'B', player_id: 'p2' },
    { event_id: 'e2', team_id: 'B', player_id: 'p4' },
  ]
  const row = (event_id, player_id, gross, net, extra = {}) => ({
    id: `${event_id}-${player_id}-${extra.entry_type || 'p'}`, event_id, player_id,
    gross_total: gross, net_total: net, entry_type: 'played', created_at: '2026-01-01', ...extra,
  })

  it('credits each round to the team the player was rostered on that week', () => {
    const scores = [
      row('e1', 'p1', 40, 35), row('e1', 'p2', 42, 36), row('e1', 'p3', 45, 38), row('e1', 'p4', 44, 37),
      row('e2', 'p1', 41, 36), row('e2', 'p3', 43, 36), row('e2', 'p2', 39, 33), row('e2', 'p4', 46, 39),
    ]
    const out = aggregateSeasonByTeam(scores, roster, { e1: 1, e2: 2 })
    expect(out.A).toMatchObject({ gross: 40 + 42 + 41 + 43, net: 35 + 36 + 36 + 36, rounds: 2, playerRounds: 4, grossMissing: 0 })
    expect(out.B).toMatchObject({ gross: 45 + 44 + 39 + 46, net: 38 + 37 + 33 + 39, rounds: 2, playerRounds: 4 })
    expect(out.A.playerIds).toEqual(['p1', 'p3'])
    expect(out.B.playerIds).toEqual(['p2', 'p4'])
  })

  it('counts penalties toward net but not gross, and keeps one row per player-week', () => {
    const scores = [
      row('e1', 'p1', 40, 35),
      row('e1', 'p2', null, 50, { entry_type: 'missed_penalty' }),
      row('e1', 'p1', null, 50, { entry_type: 'missed_penalty' }), // superseded by played
    ]
    const out = aggregateSeasonByTeam(scores, roster, { e1: 1 })
    expect(out.A).toMatchObject({ gross: 40, net: 85, playerRounds: 2, grossMissing: 1, rounds: 1 })
  })

  it('falls back to score.team_id and ignores team-less rows', () => {
    const scores = [
      row('e3', 'p9', 40, 35, { team_id: 'A' }),
      row('e3', 'sub', 38, 30, { team_id: null }),
    ]
    const out = aggregateSeasonByTeam(scores, roster)
    expect(Object.keys(out)).toEqual(['A'])
    expect(out.A.net).toBe(35)
  })
})

describe('sortStandingRows', () => {
  const base = { hasScore: true, teamNet: 70, teamGross: 80 }

  it('ranks incomplete gross cards after complete ones', () => {
    const rows = [
      { ...base, teamName: 'Missed', teamGross: 40, grossMissing: 1 },
      { ...base, teamName: 'Full', teamGross: 82, grossMissing: 0 },
      { ...base, teamName: 'Fuller', teamGross: 80, grossMissing: 0 },
    ]
    expect(sortStandingRows(rows, 'gross').map(r => r.teamName)).toEqual(['Fuller', 'Full', 'Missed'])
  })

  it('ranks team-night results ascending and Stableford points descending', () => {
    const night = [
      { ...base, teamName: 'a', formatResult: 30, formatDir: 'asc' },
      { ...base, teamName: 'b', formatResult: null, formatDir: 'asc', teamNet: 60 },
      { ...base, teamName: 'c', formatResult: 28, formatDir: 'asc' },
    ]
    expect(sortStandingRows(night, 'format').map(r => r.teamName)).toEqual(['c', 'a', 'b'])
    const stab = [
      { ...base, teamName: 'a', formatResult: 30, formatDir: 'desc' },
      { ...base, teamName: 'c', formatResult: 36, formatDir: 'desc' },
    ]
    expect(sortStandingRows(stab, 'format').map(r => r.teamName)).toEqual(['c', 'a'])
  })

  it('sinks scoreless teams and sorts net ascending', () => {
    const rows = [
      { hasScore: false, teamName: 'none', teamNet: 0 },
      { ...base, teamName: 'y', teamNet: 72 },
      { ...base, teamName: 'x', teamNet: 68 },
    ]
    expect(sortStandingRows(rows, 'net').map(r => r.teamName)).toEqual(['x', 'y', 'none'])
  })
})

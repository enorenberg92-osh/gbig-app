import { describe, expect, it } from 'vitest'
import { aggregatePlayerSeasons, compareSeasonsNewestFirst, pickerSeasons, seasonLabel } from './seasonUtils'

const leagues = [
  { id: 'spring', name: 'Spring 2026', start_date: '2026-03-01', archived_at: '2026-06-01T00:00:00Z', is_working: false, is_active: false },
  { id: 'fall',   name: 'Fall 2026',   start_date: '2026-09-01', archived_at: null, is_working: true,  is_active: true },
  { id: 'winter', name: 'Winter 2025', start_date: '2025-12-01', archived_at: null, is_working: false, is_active: false },
  { id: 'draft',  name: 'Draft',       start_date: null,         archived_at: null, is_working: false, is_active: false },
]

describe('season picker helpers', () => {
  it('orders newest first with undated seasons last', () => {
    expect([...leagues].sort(compareSeasonsNewestFirst).map(l => l.id)).toEqual(['fall', 'spring', 'winter', 'draft'])
  })

  it('shows players only working, live and archived seasons; admins see all', () => {
    expect(pickerSeasons(leagues, { currentId: 'fall' }).map(l => l.id)).toEqual(['fall', 'spring'])
    expect(pickerSeasons(leagues, { adminMode: true }).map(l => l.id)).toEqual(['fall', 'spring', 'winter', 'draft'])
    // The page's default season is always listed, even if it's a hidden draft.
    expect(pickerSeasons(leagues, { currentId: 'winter' }).map(l => l.id)).toEqual(['fall', 'spring', 'winter'])
    expect(pickerSeasons(null)).toEqual([])
  })

  it('labels the current and archived seasons', () => {
    expect(seasonLabel(leagues[1], 'fall')).toBe('Fall 2026 (current)')
    expect(seasonLabel(leagues[0], 'fall')).toBe('Spring 2026 (archived)')
    expect(seasonLabel({ id: 'x', name: '' })).toBe('Untitled season')
  })
})

describe('aggregatePlayerSeasons', () => {
  const row = (id, event_id, league_id, start_date, gross, net, hcp, extra = {}) => ({
    id, event_id, gross_total: gross, net_total: net, handicap_used: hcp, entry_type: 'played',
    sub_played: false, created_at: `${start_date}T20:00:00Z`,
    events: { id: event_id, league_id, start_date, week_number: null }, ...extra,
  })

  const scores = [
    row('s1', 'e1', 'spring', '2026-03-01', 40, 32, 8),
    row('s2', 'e2', 'spring', '2026-03-08', 44, 37, 7),
    row('s3', 'e3', 'spring', '2026-03-15', 38, 31, 7),
    row('f1', 'e10', 'fall', '2026-09-01', 42, 36, 6),
    // Excluded: penalty, sub marker row, and a superseded duplicate for e10.
    row('f2', 'e11', 'fall', '2026-09-08', null, 50, 6, { entry_type: 'missed_penalty' }),
    row('f3', 'e12', 'fall', '2026-09-15', 30, 20, 6, { sub_played: true }),
    row('f0', 'e10', 'fall', '2026-09-01', 50, 44, 6, { created_at: '2026-09-01T19:00:00Z' }),
  ]

  it('builds one line per season, newest first', () => {
    const { seasons } = aggregatePlayerSeasons(scores, leagues)
    expect(seasons.map(s => s.leagueId)).toEqual(['fall', 'spring'])
    expect(seasons[0]).toMatchObject({ name: 'Fall 2026', rounds: 1, avgGross: 42, avgNet: 36, bestNet: 36, endHandicap: 6, isWorking: true, archived: false })
    expect(seasons[1]).toMatchObject({
      name: 'Spring 2026', rounds: 3, avgGross: 40.7, avgNet: 33.3, bestNet: 31, bestGross: 38,
      endHandicap: 7, archived: true, lastPlayed: '2026-03-15',
    })
  })

  it('totals the career across seasons', () => {
    const { career } = aggregatePlayerSeasons(scores, leagues)
    expect(career).toMatchObject({ seasons: 2, rounds: 4, avgGross: 41, avgNet: 34, bestNet: 31, bestGross: 38 })
  })

  it('takes the handicap from the chronologically last round, not input order', () => {
    const shuffled = [scores[2], scores[0], scores[1]]
    expect(aggregatePlayerSeasons(shuffled, leagues).seasons[0].endHandicap).toBe(7)
    const withLate = [...shuffled, row('s4', 'e4', 'spring', '2026-03-22', 41, 36, 5)]
    expect(aggregatePlayerSeasons(withLate, leagues).seasons[0].endHandicap).toBe(5)
  })

  it('groups rounds of unknown leagues together and handles empty input', () => {
    const { seasons } = aggregatePlayerSeasons([row('x', 'ex', 'gone', '2024-01-01', 45, 40, 9)], leagues)
    expect(seasons[0]).toMatchObject({ leagueId: 'gone', name: 'Other rounds', startDate: '2024-01-01', rounds: 1 })
    expect(aggregatePlayerSeasons([], leagues)).toEqual({
      seasons: [], career: { seasons: 0, rounds: 0, avgGross: null, avgNet: null, bestNet: null, bestGross: null },
    })
  })

  it('ignores missing gross in averages but still counts the round', () => {
    const { seasons } = aggregatePlayerSeasons([
      row('a', 'e1', 'fall', '2026-09-01', null, 36, 6),
      row('b', 'e2', 'fall', '2026-09-08', '44', '38', '6'),
    ], leagues)
    expect(seasons[0]).toMatchObject({ rounds: 2, avgGross: 44, avgNet: 37, bestNet: 36, endHandicap: 6 })
  })
})

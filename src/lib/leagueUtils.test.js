import { describe, expect, it } from 'vitest'
import { buildWeekSchedule } from './leagueUtils'

describe('buildWeekSchedule', () => {
  it('builds consecutive 7-day weeks from the start date', () => {
    expect(buildWeekSchedule('2026-12-29', 2)).toEqual([
      { week: 1, start: '2026-12-29', end: '2027-01-04' },
      { week: 2, start: '2027-01-05', end: '2027-01-11' },
    ])
  })

  it('does not drift across daylight-saving changes', () => {
    const weeks = buildWeekSchedule('2026-03-01', 3)
    expect(weeks.map(w => w.start)).toEqual(['2026-03-01', '2026-03-08', '2026-03-15'])
  })

  it('returns nothing without a valid date or week count', () => {
    expect(buildWeekSchedule('', 4)).toEqual([])
    expect(buildWeekSchedule('2026-01-01', '')).toEqual([])
    expect(buildWeekSchedule('2026-01-01', 0)).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { compareEffectiveScores, compareRoundsChronologically } from './roundUtils'

describe('round ordering', () => {
  it('orders by date, then week, then creation time', () => {
    const rounds = [
      { id: 'c', weekNumber: 2, startDate: '2026-01-15' },
      { id: 'b', weekNumber: 1, startDate: '2026-01-08', created_at: '2026-01-09T02:00:00Z' },
      { id: 'a', weekNumber: 1, startDate: '2026-01-08', created_at: '2026-01-09T01:00:00Z' },
    ]
    expect(rounds.sort(compareRoundsChronologically).map(round => round.id)).toEqual(['a', 'b', 'c'])
  })

  it('puts event date ahead of week number (weeks restart each season)', () => {
    const rounds = [
      { id: 'thisSeasonWk2', events: { week_number: 2, start_date: '2026-06-10' } },
      { id: 'lastSeasonWk10', events: { week_number: 10, start_date: '2025-12-01' } },
    ]
    expect(rounds.sort(compareRoundsChronologically).map(r => r.id)).toEqual(['lastSeasonWk10', 'thisSeasonWk2'])
  })

  it('falls back to event_date and sorts dateless rounds first (oldest, like the server)', () => {
    const rounds = [
      { id: 'nodate', events: { week_number: 1 } },
      { id: 'evtDate', events: { week_number: 5, start_date: null, event_date: '2026-02-01' } },
      { id: 'start', events: { week_number: 3, start_date: '2026-01-01' } },
    ]
    expect(rounds.sort(compareRoundsChronologically).map(r => r.id)).toEqual(['nodate', 'start', 'evtDate'])
  })

  it('prefers played over penalty and resolves ties deterministically', () => {
    const rows = [
      { id: 'penalty', entry_type: 'missed_penalty', created_at: '2026-01-02' },
      { id: 'old', entry_type: 'played', created_at: '2026-01-01' },
      { id: 'new', entry_type: 'played', created_at: '2026-01-03' },
    ]
    expect(rows.sort(compareEffectiveScores).map(row => row.id)).toEqual(['new', 'old', 'penalty'])
  })
})


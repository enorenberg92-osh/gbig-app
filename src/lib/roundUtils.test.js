import { describe, expect, it } from 'vitest'
import { compareEffectiveScores, compareRoundsChronologically } from './roundUtils'

describe('round ordering', () => {
  it('orders by week, then date, then creation time', () => {
    const rounds = [
      { id: 'c', weekNumber: 2, startDate: '2026-01-15' },
      { id: 'b', weekNumber: 1, startDate: '2026-01-08', created_at: '2026-01-09T02:00:00Z' },
      { id: 'a', weekNumber: 1, startDate: '2026-01-08', created_at: '2026-01-09T01:00:00Z' },
    ]
    expect(rounds.sort(compareRoundsChronologically).map(round => round.id)).toEqual(['a', 'b', 'c'])
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


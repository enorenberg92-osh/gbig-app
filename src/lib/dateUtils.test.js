import { describe, expect, it } from 'vitest'
import { dateKeyInTimeZone, isDateInRange, isFutureDate, parseLocalDate } from './dateUtils'

describe('dateUtils', () => {
  it('parses a database date in local calendar time', () => {
    const date = parseLocalDate('2026-01-05')
    expect(date.getFullYear()).toBe(2026)
    expect(date.getMonth()).toBe(0)
    expect(date.getDate()).toBe(5)
  })

  it('uses the location timezone at UTC day boundaries', () => {
    const instant = new Date('2026-07-10T02:00:00.000Z')
    expect(dateKeyInTimeZone('America/Chicago', instant)).toBe('2026-07-09')
    expect(dateKeyInTimeZone('Europe/London', instant)).toBe('2026-07-10')
  })

  it('checks date ranges against location today', () => {
    const instant = new Date('2026-07-10T02:00:00.000Z')
    expect(isDateInRange('2026-07-09', '2026-07-09', 'America/Chicago', instant)).toBe(true)
    expect(isFutureDate('2026-07-10', 'America/Chicago', instant)).toBe(true)
  })
})


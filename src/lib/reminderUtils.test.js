import { describe, expect, it } from 'vitest'
import {
  HOUR_OPTIONS, audienceSummaryText, formatHour, lastSentLabel, scheduleLabel,
  sendNowResultText, summarizeAudience,
} from './reminderUtils'

const events = [
  { week_number: 5, counts: { missing: { players: 6, with_app: 5, devices: 4 }, all: { players: 16, with_app: 14, devices: 11 } } },
  { week_number: 2, counts: { missing: { players: 1, with_app: 1, devices: 1 }, all: { players: 8, with_app: 8, devices: 6 } } },
]

describe('reminderUtils', () => {
  it('formats hours on a 12-hour clock', () => {
    expect(formatHour(0)).toBe('12:00 AM')
    expect(formatHour(9)).toBe('9:00 AM')
    expect(formatHour(12)).toBe('12:00 PM')
    expect(formatHour(23)).toBe('11:00 PM')
    expect(formatHour(24)).toBe('')
    expect(HOUR_OPTIONS).toHaveLength(24)
  })

  it('describes the schedule', () => {
    expect(scheduleLabel({ enabled: true, day_of_week: 5, send_hour: 9 }, 'America/Chicago'))
      .toBe('Fridays at 9:00 AM (America/Chicago)')
    expect(scheduleLabel({ enabled: false, day_of_week: 5, send_hour: 9 })).toBe('Off')
  })

  it('sums an audience across open weeks', () => {
    expect(summarizeAudience(events, 'missing')).toEqual({ players: 7, withApp: 6, devices: 5, weeks: [5, 2] })
    expect(summarizeAudience(events, 'all').players).toBe(24)
    expect(summarizeAudience([], 'missing').weeks).toEqual([])
  })

  it('writes the preview line', () => {
    expect(audienceSummaryText(summarizeAudience(events.slice(0, 1), 'missing'), 'missing'))
      .toBe("6 players haven't submitted Week 5 · 4 devices will get it")
    expect(audienceSummaryText(summarizeAudience(events.slice(1), 'missing'), 'missing'))
      .toBe("1 player hasn't submitted Week 2 · 1 device will get it")
    expect(audienceSummaryText(summarizeAudience(events, 'all'), 'all'))
      .toBe('24 players rostered for Weeks 5, 2 · 17 devices will get it')
    expect(audienceSummaryText(summarizeAudience([], 'missing'), 'missing')).toMatch(/No open week/)
    const done = [{ week_number: 3, counts: { missing: { players: 0, with_app: 0, devices: 0 } } }]
    expect(audienceSummaryText(summarizeAudience(done, 'missing'), 'missing')).toMatch(/Every team has submitted Week 3/)
  })

  it('labels the last send in the location timezone', () => {
    expect(lastSentLabel(null)).toBe('Never')
    const label = lastSentLabel(
      { sent_at: '2026-09-25T14:05:00Z', kind: 'scheduled', status: 'sent', sent: 12 }, 'America/Chicago')
    expect(label).toContain('Sep 25')
    expect(label).toContain('9:05')
    expect(label).toContain('Scheduled · 12 devices')
    expect(lastSentLabel({ sent_at: '2026-09-25T14:05:00Z', kind: 'manual', status: 'empty' }, 'Not/AZone'))
      .toContain('Sent by admin · nobody to remind')
  })

  it('summarises the send-now response', () => {
    expect(sendNowResultText({ reminders: 0, alreadySent: 1 })).toMatch(/already went out today/)
    expect(sendNowResultText({ reminders: 0, alreadySent: 0 })).toMatch(/No open week/)
    expect(sendNowResultText({ reminders: 1, players: 0 })).toMatch(/nobody to remind/)
    expect(sendNowResultText({ reminders: 1, players: 6, sent: 4 })).toBe('Reminder sent to 4 devices (6 players).')
  })
})

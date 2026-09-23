import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  strokesReceived, summarizeCard, formatToPar, isTodayAt, isPlayingNow,
  buildTonightRows, buildTeamRows, sortLeaderboard, createLiveSync,
  holesFromLive, resumeHoleIndex,
} from './liveUtils.js'

const course = {
  num_holes: 9,
  hole_pars: [4, 3, 4, 5, 4, 3, 4, 4, 5],
  stroke_index: [3, 9, 1, 5, 7, 8, 2, 6, 4],
}
const TZ = 'America/Chicago'
// 2026-09-23 20:00 in Chicago (CDT, UTC-5)
const NOW = new Date('2026-09-24T01:00:00Z')

describe('strokesReceived (mirrors format_strokes_received)', () => {
  it('spreads strokes onto the hardest holes', () => {
    expect(strokesReceived(3, course.stroke_index, 9)).toEqual([1, 0, 1, 0, 0, 0, 1, 0, 0])
  })
  it('gives a base stroke everywhere past n', () => {
    expect(strokesReceived(10, course.stroke_index, 9)).toEqual([1, 1, 2, 1, 1, 1, 1, 1, 1])
  })
  it('plus handicaps give strokes back on the easiest holes', () => {
    expect(strokesReceived(-1, course.stroke_index, 9)).toEqual([0, -1, 0, 0, 0, 0, 0, 0, 0])
  })
  it('falls back to hole order without a valid index', () => {
    expect(strokesReceived(2, null, 3)).toEqual([1, 1, 0])
    expect(strokesReceived(2, [1, 2], 3)).toEqual([1, 1, 0])
  })
  it('handles empty course', () => {
    expect(strokesReceived(5, null, 0)).toEqual([])
  })
})

describe('summarizeCard', () => {
  it('counts only holes played, even out of order', () => {
    const s = summarizeCard([5, null, 4, null, null, null, null, null, null], course, 3)
    expect(s).toMatchObject({ thru: 2, finished: false, gross: 9, grossToPar: 1 })
    // holes 1 and 3 each receive a stroke at handicap 3
    expect(s.netToPar).toBe(-1)
  })
  it('full round net = gross - handicap - par', () => {
    const s = summarizeCard([4, 3, 4, 5, 4, 3, 4, 4, 5], course, 5)
    expect(s).toMatchObject({ thru: 9, finished: true, gross: 36, grossToPar: 0, netToPar: -5 })
  })
  it('nothing played → nulls', () => {
    expect(summarizeCard(Array(9).fill(null), course, 5)).toMatchObject({ thru: 0, gross: null, netToPar: null })
  })
})

describe('formatting and dates', () => {
  it('formatToPar', () => {
    expect(formatToPar(0)).toBe('E')
    expect(formatToPar(3)).toBe('+3')
    expect(formatToPar(-2)).toBe('-2')
    expect(formatToPar(null)).toBe('—')
  })
  it('isTodayAt uses the location timezone, not UTC', () => {
    // 04:00Z on the 24th is still the 23rd in Chicago
    expect(isTodayAt('2026-09-24T04:00:00Z', TZ, NOW)).toBe(true)
    expect(isTodayAt('2026-09-23T04:00:00Z', TZ, NOW)).toBe(false)
    expect(isTodayAt(null, TZ, NOW)).toBe(false)
  })
  it('isPlayingNow needs an open, recent, started card', () => {
    const recent = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString()
    const old = new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString()
    expect(isPlayingNow({ updated_at: recent, holes_played: 3, submitted: false }, TZ, NOW)).toBe(true)
    expect(isPlayingNow({ updated_at: recent, holes_played: 3, submitted: true }, TZ, NOW)).toBe(false)
    expect(isPlayingNow({ updated_at: recent, holes_played: 0, submitted: false }, TZ, NOW)).toBe(false)
    expect(isPlayingNow({ updated_at: old, holes_played: 3, submitted: false }, TZ, NOW)).toBe(false)
  })
})

describe('buildTonightRows', () => {
  const today = '2026-09-24T00:30:00Z'
  const yesterday = '2026-09-22T23:00:00Z'
  const base = {
    events: { e1: { course_id: 'c1' } },
    courses: { c1: course },
    players: { a: { name: 'Al' }, b: { name: 'Bo' }, c: { name: 'Cy' }, d: { name: 'Di' } },
    teams: { t1: { name: 'Team 1' }, t2: { name: 'Team 2' } },
    timeZone: TZ, now: NOW,
  }
  const liveRows = [
    { event_id: 'e1', player_id: 'a', team_id: 't1', hole_scores: [4, 3, 4, null, null, null, null, null, null], handicap_used: 0, updated_at: today, source: 'app' },
    { event_id: 'e1', player_id: 'b', team_id: 't1', hole_scores: [5, 4, 5, null, null, null, null, null, null], handicap_used: 9, updated_at: today, source: 'sim', bay: '3' },
    { event_id: 'e1', player_id: 'd', team_id: 't2', hole_scores: [4, null, null, null, null, null, null, null, null], handicap_used: 0, updated_at: yesterday },
  ]
  const scoreRows = [
    { event_id: 'e1', player_id: 'c', team_id: 't2', hole_scores: [4, 3, 4, 5, 4, 3, 4, 4, 4], handicap_used: 2, status: 'verified', created_at: today },
    { event_id: 'e1', player_id: 'b', team_id: 't1', hole_scores: [5, 4, 5, 5, 5, 4, 5, 5, 6], handicap_used: 9, status: 'pending', created_at: today },
  ]

  it('merges live cards with today-only score rows and sorts by net', () => {
    const rows = buildTonightRows({ ...base, liveRows, scoreRows })
    expect(rows.map(r => r.playerId)).toEqual(['c', 'b', 'a'])
    const c = rows[0]
    expect(c).toMatchObject({ status: 'approved', thru: 9, finished: true, netToPar: -3 })
    const b = rows.find(r => r.playerId === 'b')
    // submitted card replaces the live one
    expect(b).toMatchObject({ status: 'submitted', thru: 9, gross: 44, netToPar: -1, bay: '3' })
    expect(rows.find(r => r.playerId === 'a')).toMatchObject({ status: 'live', thru: 3, netToPar: 0 })
  })

  it('skips yesterday cards', () => {
    const rows = buildTonightRows({ ...base, liveRows, scoreRows: [] })
    expect(rows.some(r => r.playerId === 'd')).toBe(false)
  })

  it('team rows sum net and take the slower teammate', () => {
    const rows = buildTonightRows({ ...base, liveRows, scoreRows: [] })
    const teams = buildTeamRows(rows)
    expect(teams).toHaveLength(1)
    expect(teams[0]).toMatchObject({ name: 'Team 1', thru: 3, status: 'live' })
    // a: E gross, 0 strokes; b: 14 on par 11 with a stroke on each hole → E
    expect(rows.map(r => r.netToPar)).toEqual([0, 0])
    const sum = rows.reduce((s, r) => s + r.netToPar, 0)
    expect(teams[0].netToPar).toBe(sum)
  })

  it('sortLeaderboard puts empty cards last and breaks ties by holes played', () => {
    const sorted = sortLeaderboard([
      { name: 'x', netToPar: null, thru: 0 },
      { name: 'y', netToPar: -1, thru: 3 },
      { name: 'z', netToPar: -1, thru: 5 },
    ])
    expect(sorted.map(r => r.name)).toEqual(['z', 'y', 'x'])
  })
})

describe('holesFromLive / resumeHoleIndex', () => {
  it('pads, trims and drops junk', () => {
    expect(holesFromLive({ hole_scores: [4, null, 25, 3] }, 3)).toEqual([4, null, null])
    expect(holesFromLive(null, 2)).toEqual([null, null])
  })
  it('resumes at the first hole either player is missing', () => {
    expect(resumeHoleIndex([4, 4, null], [4, 4, 4], 3)).toBe(2)
    expect(resumeHoleIndex([4, null, 4], [4, 4, null], 3)).toBe(1)
    expect(resumeHoleIndex([4, 4, 4], [4, 4, 4], 3)).toBe(2)
  })
})

describe('createLiveSync', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('debounces and coalesces per hole', async () => {
    const send = vi.fn().mockResolvedValue({ data: {} })
    const statuses = []
    const q = createLiveSync({ send, onStatus: s => statuses.push(s), debounceMs: 500 })
    q.push('p1', 1, 4)
    q.push('p1', 1, 5)
    q.push('p2', 1, 6)
    expect(send).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(send.mock.calls).toEqual([['p1', 1, 5], ['p2', 1, 6]])
    expect(statuses).toEqual(['syncing', 'idle'])
    expect(q.pendingCount()).toBe(0)
  })

  it('retries transient failures with backoff and shows paused', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ error: { code: '08006', message: 'net' } })
      .mockResolvedValue({ data: {} })
    const statuses = []
    const q = createLiveSync({ send, onStatus: s => statuses.push(s), debounceMs: 100, retryDelays: [1000, 3000] })
    q.push('p1', 2, 4)
    await vi.advanceTimersByTimeAsync(100)
    expect(send).toHaveBeenCalledTimes(1)
    expect(q.status()).toBe('paused')
    await vi.advanceTimersByTimeAsync(1000)
    expect(send).toHaveBeenCalledTimes(2)
    // a new push during backoff doesn't reset the retry clock
    q.push('p1', 3, 5)
    await vi.advanceTimersByTimeAsync(3000)
    expect(send).toHaveBeenCalledTimes(4)
    expect(q.status()).toBe('idle')
    expect(statuses).toEqual(['syncing', 'paused', 'idle'])
  })

  it('drops permanently rejected holes and keeps going', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ error: { code: '22023', message: 'not open' } })
      .mockResolvedValue({ data: {} })
    const q = createLiveSync({ send, debounceMs: 10 })
    q.push('p1', 1, 4)
    q.push('p1', 2, 4)
    await vi.advanceTimersByTimeAsync(10)
    expect(send).toHaveBeenCalledTimes(2)
    expect(q.pendingCount()).toBe(0)
    expect(q.status()).toBe('idle')
  })

  it('stays paused when the last send failed permanently', async () => {
    const send = vi.fn().mockResolvedValue({ error: { code: '42501', message: 'nope' } })
    const q = createLiveSync({ send, debounceMs: 10 })
    q.push('p1', 1, 4)
    await vi.advanceTimersByTimeAsync(10)
    expect(q.status()).toBe('paused')
    expect(q.pendingCount()).toBe(0)
  })

  it('flush sends immediately; dispose sends once and stops retrying', async () => {
    const send = vi.fn().mockRejectedValue(new Error('offline'))
    const q = createLiveSync({ send, debounceMs: 10000, retryDelays: [50] })
    q.push('p1', 1, 4)
    q.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(send).toHaveBeenCalledTimes(1)
    q.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(send).toHaveBeenCalledTimes(2)
    q.push('p1', 2, 4)
    await vi.advanceTimersByTimeAsync(20000)
    expect(send).toHaveBeenCalledTimes(2)
  })
})

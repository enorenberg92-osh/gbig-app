// ── Tests for handicapCalc ────────────────────────────────────────────────────
// Run with:  npm test
//
// Covers the pure math functions calcHandicap and calcBreakdown. Does NOT test
// recalcPlayerHandicap — that function hits Supabase, which is integration-level
// work that belongs in a separate file with DB fixtures.

import { describe, it, expect } from 'vitest'
import { calcHandicap, calcBreakdown, DEFAULT_SETTINGS, DISCARD_TABLE } from './handicapCalc.js'

describe('calcHandicap — input validation', () => {
  it('returns null for null input', () => {
    expect(calcHandicap(null)).toBe(null)
  })

  it('returns null for undefined input', () => {
    expect(calcHandicap(undefined)).toBe(null)
  })

  it('returns null for empty array', () => {
    expect(calcHandicap([])).toBe(null)
  })

  it('returns null when fewer scores than minScores', () => {
    expect(calcHandicap([10], { ...DEFAULT_SETTINGS, minScores: 3 })).toBe(null)
    expect(calcHandicap([10, 20], { ...DEFAULT_SETTINGS, minScores: 3 })).toBe(null)
  })
})

describe('calcHandicap — discard rules', () => {
  it('applies no discards for 1 score (DISCARD_TABLE[1] = 0/0)', () => {
    // single score: 20 * 0.90 = 18 → floor 18
    expect(calcHandicap([20])).toBe(18)
  })

  it('applies no discards for 2 scores', () => {
    // avg(10, 20) = 15 * 0.90 = 13.5 → floor 13
    expect(calcHandicap([10, 20])).toBe(13)
  })

  it('applies no discards for 3 scores', () => {
    // avg(10, 20, 30) = 20 * 0.90 = 18
    expect(calcHandicap([10, 20, 30])).toBe(18)
  })

  it('discards 1 high for 4 scores', () => {
    // sorted: [10, 20, 30, 40]
    // high=1, low=0 → use [10, 20, 30]; avg = 20 * 0.90 = 18
    expect(calcHandicap([10, 20, 30, 40])).toBe(18)
  })

  it('discards 1 high AND 1 low for 5 scores', () => {
    // sorted: [10, 20, 30, 40, 50]
    // high=1, low=1 → use [20, 30, 40]; avg = 30 * 0.90 = 27 (capped at 27)
    expect(calcHandicap([10, 20, 30, 40, 50])).toBe(27)
  })

  it('discards 1 high AND 1 low for 6 scores', () => {
    // sorted: [5, 10, 20, 30, 40, 50]
    // use [10, 20, 30, 40]; avg = 25 * 0.90 = 22.5 → floor 22
    expect(calcHandicap([5, 10, 20, 30, 40, 50])).toBe(22)
  })

  it('discards 1 high AND 1 low for 12 scores', () => {
    // sorted: [0..11]
    // use indices 1..10 → [1,2,3,4,5,6,7,8,9,10]; avg = 5.5 * 0.90 = 4.95 → floor 4
    const twelve = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    expect(calcHandicap(twelve)).toBe(4)
  })
})

describe('calcHandicap — recency window', () => {
  it('uses only the last 12 scores when more are provided', () => {
    // First two scores should be ignored.
    // Last 12: [0..11] → handicap 4 (as above).
    // If the first two (999, 998) were included, result would differ wildly.
    const fourteen = [999, 998, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    expect(calcHandicap(fourteen)).toBe(4)
  })

  it('honors custom scoresUsed setting', () => {
    // Only last 5 used → [6, 7, 8, 9, 10]
    // sorted [6, 7, 8, 9, 10], discard 1 low + 1 high → [7, 8, 9], avg = 8 * 0.90 = 7.2 → floor 7
    const ten = [0, 1, 2, 3, 4, 6, 7, 8, 9, 10]
    expect(calcHandicap(ten, { ...DEFAULT_SETTINGS, scoresUsed: 5 })).toBe(7)
  })
})

describe('calcHandicap — math and rounding', () => {
  it('applies the handicap percent (0.90 by default)', () => {
    // avg 20 * 0.90 = 18 (not 20)
    expect(calcHandicap([20])).toBe(18)
  })

  it('truncates (never rounds up)', () => {
    // Single score 9.99 would be truncated, but diffs are integers in practice.
    // Use two scores to get a fractional result.
    // avg(10, 11) = 10.5 * 0.90 = 9.45 → floor 9 (not 10)
    expect(calcHandicap([10, 11])).toBe(9)
  })

  it('caps at maxHandicap (27 default)', () => {
    // Single very-high score: 50 * 0.90 = 45 → capped at 27
    expect(calcHandicap([50])).toBe(27)
  })

  it('honors custom maxHandicap', () => {
    // Single high score: 50 * 0.90 = 45 → cap at 36
    expect(calcHandicap([50], { ...DEFAULT_SETTINGS, maxHandicap: 36 })).toBe(36)
  })

  it('caps at minHandicap (-2 default) for plus-handicap golfers', () => {
    // Hypothetical plus-handicap golfer: single diff of -5.
    // -5 * 0.90 = -4.5 → floor -5 → clamped at -2 (the default minHandicap).
    // Previously this test asserted 0; the spec is -2 to 27, so 0 was wrong.
    expect(calcHandicap([-5])).toBe(-2)
  })

  it('honors custom minHandicap', () => {
    // Future league with a more permissive low end: let plus golfers play off -5.
    // -5 * 0.90 = -4.5 → floor -5 → clamped at -5 (custom floor).
    expect(calcHandicap([-5], { ...DEFAULT_SETTINGS, minHandicap: -5 })).toBe(-5)
  })

  it('returns 0 for a perfectly-par score', () => {
    // 0 * 0.90 = 0 → floor 0 → inside [-2, 27] so no clamp.
    expect(calcHandicap([0])).toBe(0)
  })

  it('returns 0 for a just-above-par golfer', () => {
    // Bordering case: diff of 1, * 0.9 = 0.9 → floor 0. Not clamped.
    expect(calcHandicap([1])).toBe(0)
  })

  it('honors custom handicapPct', () => {
    // avg 20 * 1.0 = 20
    expect(calcHandicap([20], { ...DEFAULT_SETTINGS, handicapPct: 1.0 })).toBe(20)
  })
})

describe('calcBreakdown', () => {
  it('returns null for null input', () => {
    expect(calcBreakdown(null)).toBe(null)
  })

  it('returns null when below minScores', () => {
    expect(calcBreakdown([10], { ...DEFAULT_SETTINGS, minScores: 2 })).toBe(null)
  })

  it('returns all intermediate steps for a 6-score calc', () => {
    const result = calcBreakdown([5, 10, 20, 30, 40, 50])
    expect(result).toEqual({
      n: 6,
      rule: { high: 1, low: 1 },
      sorted: [5, 10, 20, 30, 40, 50],
      used: [10, 20, 30, 40],
      avg: 25,
      raw: 22.5,
      capped: 22,
    })
  })

  it('final capped value matches calcHandicap exactly', () => {
    // Cross-check: both functions must return the same final integer.
    const cases = [
      [20],
      [10, 20],
      [10, 20, 30, 40],
      [5, 10, 20, 30, 40, 50],
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      [50],            // cap at 27 (maxHandicap)
      [-5],            // cap at -2 (minHandicap default)
      [999, 998, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],  // recency window
    ]
    for (const diffs of cases) {
      expect(calcBreakdown(diffs).capped).toBe(calcHandicap(diffs))
    }
  })
})

describe('DISCARD_TABLE — sanity check', () => {
  it('never discards more scores than exist', () => {
    // For every entry in the table, low + high must leave at least 1 score.
    for (const [n, rule] of Object.entries(DISCARD_TABLE)) {
      const count = Number(n)
      const remaining = count - rule.high - rule.low
      expect(remaining).toBeGreaterThan(0)
    }
  })
})

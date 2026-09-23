import { describe, expect, it } from 'vitest'
import { calcSkins, isSkinsEligibleScore } from './skinsUtils'

describe('calcSkins', () => {
  it('awards a hole only to a unique low score', () => {
    const skins = calcSkins({ a: [3, 4], b: [3, 5] }, 2)
    expect(skins).toEqual({ 1: null, 2: 'a' })
  })
})

describe('isSkinsEligibleScore', () => {
  const base = { entry_type: 'played', status: 'verified', hole_scores: [4, 4] }

  it('accepts verified played rows, treating NULL sub_played as false', () => {
    expect(isSkinsEligibleScore(base)).toBe(true)
    expect(isSkinsEligibleScore({ ...base, sub_played: null })).toBe(true)
    expect(isSkinsEligibleScore({ ...base, sub_played: false })).toBe(true)
  })

  it('rejects sub-played, penalty, pending and hole-less rows', () => {
    expect(isSkinsEligibleScore({ ...base, sub_played: true })).toBe(false)
    expect(isSkinsEligibleScore({ ...base, entry_type: 'missed_penalty' })).toBe(false)
    expect(isSkinsEligibleScore({ ...base, status: 'pending' })).toBe(false)
    expect(isSkinsEligibleScore({ ...base, hole_scores: null })).toBe(false)
  })
})

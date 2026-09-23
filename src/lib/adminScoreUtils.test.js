import { describe, expect, it } from 'vitest'
import { classifyHoleGrid, resolveHandicapUsed } from './adminScoreUtils'

describe('classifyHoleGrid', () => {
  it('treats an untouched grid as blank', () => {
    expect(classifyHoleGrid(['', '', ''], 3).status).toBe('blank')
    expect(classifyHoleGrid(undefined, 3).status).toBe('blank')
    expect(classifyHoleGrid([null, ' ', ''], 3).status).toBe('blank')
  })

  it('returns integer holes for a complete grid', () => {
    expect(classifyHoleGrid(['4', '5', '3'], 3)).toEqual({ status: 'complete', holes: [4, 5, 3] })
  })

  it('rejects partial and out-of-range grids', () => {
    expect(classifyHoleGrid(['4', '', '3'], 3).status).toBe('invalid')
    expect(classifyHoleGrid(['4', '0', '3'], 3).status).toBe('invalid')
    expect(classifyHoleGrid(['4', '21', '3'], 3).status).toBe('invalid')
    expect(classifyHoleGrid(['4', '4.5', '3'], 3).status).toBe('invalid')
    expect(classifyHoleGrid(['4', '5'], 3).status).toBe('invalid')
  })
})

describe('resolveHandicapUsed', () => {
  const player = { handicap: 12 }
  const sub = { sub_handicap: 18 }

  it('uses the current handicap (or the sub’s) for new rows', () => {
    expect(resolveHandicapUsed(null, player, null)).toBe(12)
    expect(resolveHandicapUsed(null, player, sub)).toBe(18)
  })

  it('keeps the historic handicap when editing an existing round', () => {
    expect(resolveHandicapUsed({ entry_type: 'played', handicap_used: 9 }, player, null)).toBe(9)
    expect(resolveHandicapUsed({ entry_type: 'played', handicap_used: 15 }, player, sub)).toBe(15)
    expect(resolveHandicapUsed({ entry_type: 'played', handicap_used: 0 }, player, null)).toBe(0)
  })

  it('falls back to current when the existing row has no handicap_used', () => {
    expect(resolveHandicapUsed({ entry_type: 'played', handicap_used: null }, player, null)).toBe(12)
  })

  it('replacing a penalty keeps its handicap unless a sub played', () => {
    expect(resolveHandicapUsed({ entry_type: 'missed_penalty', handicap_used: 10 }, player, null)).toBe(10)
    expect(resolveHandicapUsed({ entry_type: 'missed_penalty', handicap_used: 10 }, player, sub)).toBe(18)
  })
})

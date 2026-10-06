import { describe, expect, it } from 'vitest'
import { hasCompleteCoursePars, zipHoleScoresWithPars, displayHole } from './holeUtils'

describe('holeUtils', () => {
  it('keeps front, back, and eighteen-hole display numbers separate from array positions', () => {
    expect(displayHole(0, {start_hole:10})).toBe(10)
    expect(displayHole(8, {start_hole:10})).toBe(18)
    expect(displayHole(17, {start_hole:1})).toBe(18)
    expect(zipHoleScoresWithPars([4,5],[4,4],10).map(h=>h.hole)).toEqual([10,11])
  })
  it('requires the configured number of valid pars', () => {
    expect(hasCompleteCoursePars({ num_holes: 9, hole_pars: Array(9).fill(4) })).toBe(true)
    expect(hasCompleteCoursePars({ num_holes: 18, hole_pars: Array(9).fill(4) })).toBe(false)
    expect(hasCompleteCoursePars({ num_holes: 9, hole_pars: [2, ...Array(8).fill(4)] })).toBe(false)
  })

  it('length-guards score/par zips', () => {
    expect(zipHoleScoresWithPars([4, 5, 3], [4, 4])).toEqual([
      { index: 0, hole: 1, score: 4, par: 4 },
      { index: 1, hole: 2, score: 5, par: 4 },
    ])
    expect(zipHoleScoresWithPars(null, [4])).toEqual([])
  })
})


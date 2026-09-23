import { describe, expect, it } from 'vitest'
import { planRoundRobin, roundRobinRounds, seedPlayoff } from './scheduleUtils'

const pairKey = ([a, b]) => [a, b].sort().join('-')

describe('roundRobinRounds', () => {
  it('pairs every team with every other exactly once', () => {
    const rounds = roundRobinRounds(['a', 'b', 'c', 'd'])
    expect(rounds).toHaveLength(3)
    const keys = rounds.flat().map(pairKey)
    expect(new Set(keys).size).toBe(6)
  })

  it('gives one team a bye each round with an odd count', () => {
    const rounds = roundRobinRounds(['a', 'b', 'c'])
    expect(rounds).toHaveLength(3)
    rounds.forEach(r => expect(r).toHaveLength(1))
  })
})

describe('planRoundRobin', () => {
  const teams = ['a', 'b', 'c', 'd']
  const rounds = roundRobinRounds(teams)
  const wk = (n, extra = {}) => ({ id: `e${n}`, week_number: n, format: 'match_team', status: 'draft', ...extra })

  it('skips playoff, bye, cancelled and non-match weeks', () => {
    const events = [
      wk(1), wk(2, { is_bye: true }), wk(3, { is_playoff: true }),
      wk(4, { status: 'cancelled' }), wk(5, { format: 'stroke' }), wk(6),
    ]
    const plan = planRoundRobin(events, {}, teams)
    expect(plan.map(p => p.event.id)).toEqual(['e1', 'e6'])
    expect(plan[0].pairs).toEqual(rounds[0])
    expect(plan[1].pairs).toEqual(rounds[1])
  })

  it('keeps played weeks and continues the rotation after them', () => {
    const events = [wk(1, { status: 'closed' }), wk(2, { status: 'open' }), wk(3), wk(4)]
    const matchups = { e2: [{ status: 'scored' }] }
    const plan = planRoundRobin(events, matchups, teams)
    expect(plan.map(p => p.event.id)).toEqual(['e3', 'e4'])
    expect(plan[0].pairs).toEqual(rounds[2])
    expect(plan[1].pairs).toEqual(rounds[0]) // wraps after a full cycle
  })

  it('returns nothing with fewer than two teams', () => {
    expect(planRoundRobin([wk(1)], {}, ['a'])).toEqual([])
  })
})

describe('seedPlayoff', () => {
  const teams = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }))

  it('gives the top seed the bye with an odd team count', () => {
    const { pairs, byeTeamId } = seedPlayoff(teams, { a: 1, b: 5, c: 4, d: 3, e: 2 })
    expect(byeTeamId).toBe('b')
    expect(pairs).toEqual([['c', 'a'], ['d', 'e']])
  })

  it('pairs 1 v N with an even count', () => {
    const { pairs, byeTeamId } = seedPlayoff(teams.slice(0, 4), { a: 4, b: 3, c: 2, d: 1 })
    expect(byeTeamId).toBeNull()
    expect(pairs).toEqual([['a', 'd'], ['b', 'c']])
  })

  it('breaks points ties by lower net total', () => {
    const { seeded } = seedPlayoff(teams.slice(0, 3), { a: 2, b: 2, c: 2 }, { a: 300, b: 280 })
    expect(seeded.map(t => t.id)).toEqual(['b', 'a', 'c'])
  })
})

import { describe, expect, it } from 'vitest'
import {
  typeSign, roundCents, signedAmount, isSettled, ledgerBalances, markDuplicateSuggestions,
} from './moneyUtils'

describe('ledger signs', () => {
  it('knows which types are charges, credits, or free', () => {
    expect(typeSign('entry_fee')).toBe(-1)
    expect(typeSign('payout')).toBe(-1)
    expect(typeSign('skins')).toBe(1)
    expect(typeSign('match_points')).toBe(1)
    expect(typeSign('event_prize')).toBe(1)
    expect(typeSign('adjustment')).toBe(0)
  })

  it('applies the type sign to whatever the admin typed', () => {
    expect(signedAmount('entry_fee', '20')).toBe(-20)
    expect(signedAmount('payout', '-15.5')).toBe(-15.5)
    expect(signedAmount('skins', '-5')).toBe(5)
    expect(signedAmount('adjustment', '-3.25')).toBe(-3.25)
    expect(signedAmount('adjustment', '3.25')).toBe(3.25)
    expect(signedAmount('skins', 'abc')).toBeNaN()
  })
})

describe('cents', () => {
  it('rounds to cents and treats float residue as settled', () => {
    expect(roundCents(3 * 0.1)).toBe(0.3)
    expect(roundCents(1.005)).toBe(1.01)
    expect(isSettled(0.1 + 0.2 - 0.3)).toBe(true)
    expect(isSettled(0.01)).toBe(false)
  })
})

describe('ledgerBalances', () => {
  it('keys by id, not name, and drops settled balances', () => {
    const rows = ledgerBalances([
      { player_id: 'a', amount: 0.1 },
      { player_id: 'a', amount: 0.2 },
      { player_id: 'b', amount: 5 },
      { player_id: 'b', amount: -5 },
      { team_id: 't', amount: -20 },
      { player_id: 'c', amount: '12.5' },
    ])
    expect(rows).toEqual([
      { key: 'p:c', playerId: 'c', teamId: null, amt: 12.5 },
      { key: 'p:a', playerId: 'a', teamId: null, amt: 0.3 },
      { key: 't:t', playerId: null, teamId: 't', amt: -20 },
    ])
  })
})

describe('markDuplicateSuggestions', () => {
  it('unticks suggestions already in the ledger for that week', () => {
    const ledger = [
      { event_id: 'e1', type: 'skins', player_id: 'a', amount: 10 },
      { event_id: 'e2', type: 'skins', player_id: 'b', amount: 5 },
    ]
    const out = markDuplicateSuggestions([
      { include: true, event_id: 'e1', type: 'skins', player_id: 'a', team_id: null },
      { include: true, event_id: 'e1', type: 'skins', player_id: 'b', team_id: null },
      { include: true, event_id: 'e1', type: 'match_points', player_id: null, team_id: 't' },
    ], ledger)
    expect(out.map(s => [s.include, !!s.duplicate])).toEqual([[false, true], [true, false], [true, false]])
  })
})

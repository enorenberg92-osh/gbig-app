import { describe, it, expect } from 'vitest'
import {
  bayName, normalizeBayLabel, findBayByLabel, checkinUrl, occupantNames,
  findTeamBay, thruLabel, playerDisplayName, boardSummary, checkinErrorMessage,
} from './bayUtils'

const board = {
  bays: [
    { id: 'b1', label: '1', teams: [{ team_id: 't1', team_name: 'Team 1' }, { team_id: 't4', team_name: 'Team 4' }] },
    { id: 'b2', label: '2', teams: [] },
    { id: 'b3', label: 'VIP', teams: [{ team_id: 't2', team_name: 'Team 2' }] },
  ],
  teams: [
    { team_id: 't1', bay_id: 'b1', finished: false },
    { team_id: 't2', bay_id: 'b3', finished: false },
    { team_id: 't3', bay_id: null, finished: false },
    { team_id: 't4', bay_id: 'b1', finished: false },
    { team_id: 't5', bay_id: null, finished: true },
  ],
}

describe('bayName', () => {
  it('prefixes numeric labels', () => {
    expect(bayName('3')).toBe('Bay 3')
    expect(bayName('12b')).toBe('Bay 12b')
  })
  it('keeps custom names', () => {
    expect(bayName('VIP')).toBe('VIP')
    expect(bayName('Bay 7 Lefty')).toBe('Bay 7 Lefty')
  })
  it('handles empty', () => expect(bayName('')).toBe('Bay'))
})

describe('findBayByLabel', () => {
  it('matches case-insensitively and trims', () => {
    expect(findBayByLabel(board.bays, ' vip ').id).toBe('b3')
    expect(findBayByLabel(board.bays, '2').id).toBe('b2')
  })
  it('tolerates a "Bay " prefix', () => {
    expect(normalizeBayLabel(' Bay 3 ')).toBe('3')
    expect(findBayByLabel(board.bays, 'bay 1').id).toBe('b1')
  })
  it('returns null when missing', () => {
    expect(findBayByLabel(board.bays, '9')).toBeNull()
    expect(findBayByLabel(board.bays, '')).toBeNull()
    expect(findBayByLabel(null, '1')).toBeNull()
  })
})

describe('checkinUrl', () => {
  it('builds the QR target and encodes the label', () => {
    expect(checkinUrl('https://gbig-app.vercel.app/', '3')).toBe('https://gbig-app.vercel.app/league/checkin?bay=3')
    expect(checkinUrl('https://x.test', 'Bay 7 Lefty')).toBe('https://x.test/league/checkin?bay=Bay%207%20Lefty')
  })
})

describe('board helpers', () => {
  it('lists occupant names', () => {
    expect(occupantNames(board.bays[0])).toBe('Team 1 · Team 4')
    expect(occupantNames(board.bays[1])).toBe('')
  })
  it('finds a team\'s bay', () => {
    expect(findTeamBay(board, 't4').id).toBe('b1')
    expect(findTeamBay(board, 't3')).toBeNull()
    expect(findTeamBay(board, null)).toBeNull()
  })
  it('summarizes the board', () => {
    expect(boardSummary(board)).toEqual({ bays: 3, busyBays: 2, teamsOnBays: 3, waiting: 1 })
    expect(boardSummary(null)).toEqual({ bays: 0, busyBays: 0, teamsOnBays: 0, waiting: 0 })
  })
})

describe('player labels', () => {
  it('shows progress', () => {
    expect(thruLabel({ holes_played: 0 })).toBe('Not started')
    expect(thruLabel({ holes_played: 4 })).toBe('Thru 4')
    expect(thruLabel({ holes_played: 9, submitted: true })).toBe('Done')
  })
  it('names the sub', () => {
    expect(playerDisplayName({ name: 'Pat One' })).toBe('Pat One')
    expect(playerDisplayName({ name: 'Pat One', sub_name: 'Chris' })).toBe('Chris (for Pat One)')
  })
})

describe('checkinErrorMessage', () => {
  it('explains a missing migration', () => {
    expect(checkinErrorMessage({ code: 'PGRST202', message: 'x' })).toMatch(/isn't set up/)
  })
  it('passes server messages through', () => {
    expect(checkinErrorMessage({ message: 'That bay is not in use' })).toBe('That bay is not in use')
    expect(checkinErrorMessage(null)).toMatch(/Could not check in/)
  })
})

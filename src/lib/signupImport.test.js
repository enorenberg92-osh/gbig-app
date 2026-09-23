import { describe, expect, it } from 'vitest'
import {
  flattenPayload, mapSignupPayload, normalizeEmail, normalizeKey, parseHandicap, parseSignupCSV, splitName,
} from './signupImport'

const HEADER = 'Name,Phone,Email,HCP,Day,Time,,,,Name,Phone,Email,HCP,Message,x,Entry ID,Date'

describe('signupImport', () => {
  it('rounds decimal handicaps and rejects non-numbers', () => {
    expect(parseHandicap('12.4')).toBe(12)
    expect(parseHandicap('12.5')).toBe(13)
    expect(parseHandicap('-1.6')).toBe(-2)
    expect(parseHandicap('')).toBeNull()
    expect(parseHandicap('n/a')).toBeNull()
  })

  it('splits names and normalizes emails', () => {
    expect(splitName('  Mary  Ann Smith ')).toEqual({ firstName: 'Mary', lastName: 'Ann Smith' })
    expect(splitName('Cher')).toEqual({ firstName: 'Cher', lastName: '' })
    expect(normalizeEmail(' Bob@Example.COM ')).toBe('bob@example.com')
  })

  it('maps WPForms rows, including quoted multi-line messages', () => {
    const csv = [
      '﻿' + HEADER,
      'John Smith,555,john@x.com,10.6,Tue,6pm,,,,Bob Jones,556,bob@x.com,8,"Hi, we\'re ""in""\nsee you",,42,2026-01-01',
      ',,,,,,,,,,,,,,,,',
      '',
    ].join('\r\n')
    const { rows, error } = parseSignupCSV(csv)
    expect(error).toBeNull()
    expect(rows).toHaveLength(1)
    expect(rows[0].teamName).toBe('Smith/Jones')
    expect(rows[0].p1).toMatchObject({ fullName: 'John Smith', email: 'john@x.com', handicap: 11 })
    expect(rows[0].p2).toMatchObject({ firstName: 'Bob', lastName: 'Jones', handicap: 8 })
    expect(rows[0].slot).toBe('Tue 6pm')
    expect(rows[0].submissionId).toBe('42')
  })

  it('reports an empty file', () => {
    expect(parseSignupCSV(HEADER).error).toBe('CSV appears empty.')
  })

  it('maps a WPForms Webhooks JSON body with the documented keys', () => {
    const { row, error } = mapSignupPayload({
      p1_name: ' John  Smith ', p1_email: 'John@X.com', p1_phone: '555', p1_handicap: '10.6',
      p2_name: 'Bob Jones', p2_email: 'bob@x.com', p2_handicap: 8,
      day: 'Tue', time: '6pm', message: 'See you', entry_id: 42,
    })
    expect(error).toBeNull()
    expect(row.teamName).toBe('Smith/Jones')
    expect(row.p1).toMatchObject({ fullName: 'John Smith', firstName: 'John', email: 'John@X.com', handicap: 11 })
    expect(row.p2).toMatchObject({ lastName: 'Jones', handicap: 8 })
    expect(row).toMatchObject({ slot: 'Tue 6pm', message: 'See you', submissionId: '42' })
  })

  it('accepts aliases, split names, nested objects and an explicit team name', () => {
    const { row } = mapSignupPayload({
      'First Name': 'Pat', 'Last Name': 'One', Email: 'p1@a.test', HCP: '4.5',
      partner: { name: 'Sam Two', email: 'p2@a.test', handicap: '12' },
      'Team Name': 'Birdie Hunters',
    })
    expect(row.p1).toMatchObject({ fullName: 'Pat One', handicap: 5 })
    expect(row.p2).toMatchObject({ fullName: 'Sam Two', email: 'p2@a.test', handicap: 12 })
    expect(row.teamName).toBe('Birdie Hunters')
  })

  it('flags a body with no player name and truncates long values', () => {
    expect(mapSignupPayload({ foo: 'bar' }).error).toMatch(/field mapping/)
    const { row } = mapSignupPayload({ p1_name: 'x'.repeat(500), message: 'm'.repeat(5000) })
    expect(row.p1.fullName).toHaveLength(200)
    expect(row.message).toHaveLength(2000)
  })

  it('normalizes keys and caps flattening depth', () => {
    expect(normalizeKey(' Player 1 — E-mail ')).toBe('player_1_e_mail')
    const deep = { a: { b: { c: { d: { e: { f: 'too deep' } } } } }, list: ['x', 'y', { z: 1 }] }
    const flat = flattenPayload(deep)
    expect(flat.a_b_c_d_e_f).toBeUndefined()
    expect(flat.list).toBe('x, y')
  })
})

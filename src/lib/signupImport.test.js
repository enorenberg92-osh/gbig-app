import { describe, expect, it } from 'vitest'
import { normalizeEmail, parseHandicap, parseSignupCSV, splitName } from './signupImport'

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
})

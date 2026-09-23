import { describe, expect, it } from 'vitest'
import { parseCSV } from './csv'

describe('parseCSV', () => {
  it('splits simple rows and ignores a trailing newline', () => {
    expect(parseCSV('a,b,c\n1,2,3\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
  })

  it('handles CRLF and bare CR line endings', () => {
    expect(parseCSV('a,b\r\n1,2\r3,4')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']])
  })

  it('keeps commas inside quoted fields', () => {
    expect(parseCSV('name,city\n"Smith, John","Austin, TX"')).toEqual([
      ['name', 'city'],
      ['Smith, John', 'Austin, TX'],
    ])
  })

  it('unescapes doubled quotes', () => {
    expect(parseCSV('"He said ""hi""",x')).toEqual([['He said "hi"', 'x']])
  })

  it('keeps line breaks inside quoted fields', () => {
    expect(parseCSV('a,msg,b\n1,"line one\r\nline two",2\n')).toEqual([
      ['a', 'msg', 'b'],
      ['1', 'line one\r\nline two', '2'],
    ])
  })

  it('strips a UTF-8 BOM', () => {
    expect(parseCSV('﻿Name,Email\nA,a@x.com')).toEqual([['Name', 'Email'], ['A', 'a@x.com']])
  })

  it('preserves empty fields, including a trailing one', () => {
    expect(parseCSV('a,,c,\n')).toEqual([['a', '', 'c', '']])
    expect(parseCSV('"",x')).toEqual([['', 'x']])
  })

  it('returns no rows for empty input', () => {
    expect(parseCSV('')).toEqual([])
    expect(parseCSV(null)).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { csvCell, toCsv } from './csvUtils'

describe('csvCell', () => {
  it('neutralises formula-looking strings', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+1+2')).toBe("'+1+2")
    expect(csvCell('-cmd')).toBe("'-cmd")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('\t=1')).toBe("'\t=1")
    expect(csvCell('\r=1')).toBe(`"'\r=1"`)
  })

  it('leaves numbers and plain numeric strings alone', () => {
    expect(csvCell(-5)).toBe('-5')
    expect(csvCell('-12.50')).toBe('-12.50')
    expect(csvCell(null)).toBe('')
    expect(csvCell('Bob')).toBe('Bob')
  })

  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
    expect(csvCell('line1\rline2')).toBe('"line1\rline2"')
  })
})

describe('toCsv', () => {
  it('joins rows with CRLF', () => {
    expect(toCsv([['a', 'b'], [1, '=x']])).toBe("a,b\r\n1,'=x")
  })
})

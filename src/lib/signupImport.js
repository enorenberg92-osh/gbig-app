import { parseCSV } from './csv'

// WPForms "League Sign Up" export → team rows for AdminImport.
//
// Column layout (0-indexed):
//  0  Name*          (P1)
//  1  Phone Number*  (P1)
//  2  Email*         (P1)
//  3  9 Hole Handicap* (P1)
//  4  Day*
//  5  Time*
//  6,7,8  blank
//  9  Name*          (P2)
// 10  Phone Number*  (P2)
// 11  Email*         (P2)
// 12  9 Hole Handicap* (P2)
// 13  Message
// 14+ metadata (15 = entry id, 16 = submitted at)

export function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean)
  return {
    firstName: parts[0] || '',
    lastName:  parts.slice(1).join(' ') || '',
  }
}

// League handicaps are whole numbers; sign-up forms often collect decimals
// (e.g. "12.4"), so round here rather than letting the server truncate.
export function parseHandicap(val) {
  const n = parseFloat(val)
  return Number.isFinite(n) ? Math.round(n) : null
}

export function normalizeEmail(email) {
  return (email || '').trim().toLowerCase()
}

export function parseSignupCSV(text) {
  const table = parseCSV(text)
  if (table.length < 2) return { rows: [], error: 'CSV appears empty.' }

  const parsed = []
  for (let i = 1; i < table.length; i++) {
    const cols = table[i].map(c => (c ?? '').trim())
    const p1Name = cols[0] || ''
    if (!p1Name) continue  // skip empty rows

    const { firstName: p1First, lastName: p1Last } = splitName(p1Name)
    const { firstName: p2First, lastName: p2Last } = splitName(cols[9] || '')

    const lastName1 = p1Last || p1First
    const lastName2 = p2Last || p2First
    const teamName  = lastName1 && lastName2
      ? `${lastName1}/${lastName2}`
      : p1Name

    parsed.push({
      p1: {
        firstName: p1First,
        lastName:  p1Last,
        fullName:  p1Name,
        phone:     cols[1] || '',
        email:     cols[2] || '',
        handicap:  parseHandicap(cols[3]),
      },
      p2: {
        firstName: p2First,
        lastName:  p2Last,
        fullName:  cols[9] || '',
        phone:     cols[10] || '',
        email:     cols[11] || '',
        handicap:  parseHandicap(cols[12]),
      },
      day:      cols[4] || '',
      time:     cols[5] || '',
      teamName,
      slot:     [cols[4], cols[5]].filter(Boolean).join(' '),
      submissionId: cols[15] || '',
      submittedAt:  cols[16] || '',
    })
  }

  return { rows: parsed, error: null }
}

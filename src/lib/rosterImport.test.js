import { describe,it,expect } from 'vitest'
import { parseRosterCSV,readCSV } from './rosterImport'

const header='Player 1 Name,Player 1 Email,Player 1 Handicap,Player 2 Name,Player 2 Email,Player 2 Handicap,Day,Time'
const entry='Alex Smith,alex@example.invalid,5,Jamie Jones,jamie@example.invalid,7,Monday,6:00 PM'
describe('verified roster preparation',()=>{
  it('maps named columns regardless of their order',()=>{
    const parsed=parseRosterCSV('Player 2 Email,Player 1 Handicap,Player 1 Name,Player 2 Name,Player 2 Handicap,Player 1 Email\njamie@example.invalid,5,Alex Smith,Jamie Jones,7,alex@example.invalid')
    expect(parsed.error).toBeNull();expect(parsed.rows[0].p1.fullName).toBe('Alex Smith');expect(parsed.rows[0].p2.email).toBe('jamie@example.invalid');expect(parsed.rows[0].issues).toEqual([])
  })
  it('preserves quoted names and ignores multiline notes as extra records',()=>{
    const parsed=parseRosterCSV(header+',Message\n"Alex ""Ace"" Smith",alex@example.invalid,5,Jamie Jones,jamie@example.invalid,7,Monday,6:00 PM,"hello\nthere"')
    expect(parsed.rows).toHaveLength(1);expect(parsed.rows[0].p1.fullName).toBe('Alex "Ace" Smith')
  })
  it('handles historical IDs appearing only on the first partner',()=>{
    const p=parseRosterCSV('firstname,lastname,email,ID,Index\nAlex,Smith,alex@example.invalid,1,5\nJamie,Jones,jamie@example.invalid,,7\nSam,Green,sam@example.invalid,2,0\nPat,Brown,pat@example.invalid,,4')
    expect(p.rows).toHaveLength(2);expect(p.rows[0].teamName).toBe('Smith/Jones');expect(p.rows[1].p1.handicap).toBe(0)
  })
  it('groups explicit IDs correctly even after sorting',()=>{
    const p=parseRosterCSV('First Name,Last Name,Email,Team ID,Index\nAlex,Smith,alex@example.invalid,1,5\nSam,Green,sam@example.invalid,2,0\nJamie,Jones,jamie@example.invalid,1,7\nPat,Brown,pat@example.invalid,2,4')
    expect(p.rows[0].p2.fullName).toBe('Jamie Jones');expect(p.rows[1].p2.fullName).toBe('Pat Brown')
  })
  it('shows an unpaired golfer without silently assigning them to the previous pair',()=>{
    const p=parseRosterCSV('firstname,lastname,email,ID,Index\nAlex,Smith,alex@example.invalid,1,5\nJamie,Jones,jamie@example.invalid,,7\nBen,Chan,ben@example.invalid,,')
    expect(p.rows).toHaveLength(2);expect(p.rows[1].p2.fullName).toBe('');expect(p.rows[1].issues.length).toBeGreaterThan(0)
  })
  it('flags email-only notes instead of creating fake players',()=>{
    const p=parseRosterCSV('firstname,lastname,email,ID,Index\nAlex,Smith,alex@example.invalid,1,5\nJamie,Jones,jamie@example.invalid,,7\n,,unknown@example.invalid,,')
    expect(p.rows).toHaveLength(1);expect(p.warnings[0]).toContain('1 note or email-only row')
  })
  it.each(['','5.5','5abc','28','-3'])('rejects an invalid handicap %s',value=>{
    const p=parseRosterCSV(header+'\n'+entry.replace('invalid,5,','invalid,'+value+','))
    expect(p.rows[0].issues.join(' ')).toContain('whole-number')
  })
  it('requires separate email addresses for different people',()=>{
    const p=parseRosterCSV(header+'\n'+entry.replace('jamie@example.invalid','alex@example.invalid'))
    expect(p.rows[0].issues.join(' ')).toContain('share an email')
  })
  it('allows a missing email with an explicit roster-only warning',()=>{
    const p=parseRosterCSV(header+'\n'+entry.replace('alex@example.invalid',''))
    expect(p.rows[0].issues).toEqual([]);expect(p.rows[0].warnings[0]).toContain('roster only')
  })
  it('flags repeated partnerships and duplicate golfer names',()=>{
    const p=parseRosterCSV(header+'\n'+entry+'\n'+entry)
    expect(p.rows.every(row=>row.issues.length>0)).toBe(true)
  })
  it('supports the website export without relying on arbitrary column positions',()=>{
    const p=parseRosterCSV('Name*,Phone Number*,Email*,9 Hole Handicap*,Day*,Time*,,,,Name*,Phone Number*,Email*,9 Hole Handicap*\nAlex Smith,9205550100,alex@example.invalid,5,Monday,6:00 PM,,,,Jamie Jones,9205550101,jamie@example.invalid,7')
    expect(p.error).toBeNull();expect(p.rows[0].issues).toEqual([]);expect(p.rows[0].p2.phone).toBe('9205550101')
  })
  it('rejects unknown headers and malformed quotes before importing',()=>{
    expect(parseRosterCSV('Name,Other\nAlex,5').error).toContain('not recognized')
    expect(()=>readCSV('Name\n"Unfinished')).toThrow('unfinished')
  })
})

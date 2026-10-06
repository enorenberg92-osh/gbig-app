const text = value => String(value ?? '').trim()
const headerKey = value => text(value).toLowerCase().replace(/[^a-z0-9]/g, '')
const normalizedName = value => text(value).toLowerCase().replace(/\s+/g, ' ')
export const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(value))

export function readCSV(input) {
  const rows = []
  let row = [], cell = '', quoted = false
  const source = String(input).replace(/^\uFEFF/, '')
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (char === '"') {
      if (quoted && source[i + 1] === '"') { cell += '"'; i++ }
      else if (quoted || cell === '') quoted = !quoted
      else throw new Error('A quotation mark is misplaced in the CSV. Export the sheet as CSV again.')
    } else if (char === ',' && !quoted) { row.push(cell); cell = '' }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += char
  }
  if (quoted) throw new Error('The CSV contains an unfinished quoted field. Export the sheet as CSV again.')
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

function player(name, email, handicap, phone = '') {
  const fullName = text(name).replace(/\s+/g, ' ')
  const [firstName = '', ...last] = fullName.split(' ')
  return { fullName, firstName, lastName:last.join(' '), email:text(email).toLowerCase(), phone:text(phone), handicap:text(handicap) === '' ? null : Number(handicap) }
}
function team(p1, p2, day = '', time = '', rowNumber) {
  return { p1, p2, day:text(day), time:text(time), slot:[text(day), text(time)].filter(Boolean).join(' '), teamName:[p1.lastName || p1.firstName, p2.lastName || p2.firstName].filter(Boolean).join('/'), rowNumber, issues:[], warnings:[] }
}
export function validateImportRows(rows) {
  const names = new Map(), emails = new Map(), teamKeys = new Map()
  for (const row of rows) {
    row.issues = []; row.warnings = []
    for (const p of [row.p1, row.p2]) {
      if (!p.fullName) { row.issues.push('Both partners must have a name.'); continue }
      if (!Number.isInteger(p.handicap) || p.handicap < -2 || p.handicap > 27) row.issues.push(`${p.fullName}: enter a whole-number 9-hole handicap from -2 to 27.`)
      if (!p.email) row.warnings.push(`${p.fullName}: roster only until an email is added.`)
      else if (!validEmail(p.email)) row.issues.push(`${p.fullName}: check the email address.`)
      const name = normalizedName(p.fullName)
      if (!names.has(name)) names.set(name, [])
      names.get(name).push(row)
      if (p.email) {
        if (!emails.has(p.email)) emails.set(p.email, [])
        emails.get(p.email).push({ name, row })
      }
    }
    const key = [normalizedName(row.p1.fullName), normalizedName(row.p2.fullName)].sort().join('|')
    if (!teamKeys.has(key)) teamKeys.set(key, [])
    teamKeys.get(key).push(row)
  }
  for (const group of teamKeys.values()) if (group.length > 1) for (const row of group) row.issues.push('This partnership appears more than once in the file. Keep one entry.')
  for (const group of names.values()) if (group.length > 1) for (const row of group) row.issues.push('A player name appears more than once. Confirm these are different people before importing.')
  for (const group of emails.values()) if (new Set(group.map(p => p.name)).size > 1) for (const { row } of group) row.issues.push('Different golfers share an email. Use a separate email for each app login.')
  for (const row of rows) { row.issues = [...new Set(row.issues)]; row.warnings = [...new Set(row.warnings)] }
  return rows
}

export function parseRosterCSV(input) {
  try {
    const csv = readCSV(input)
    if (csv.length < 2) throw new Error('Include a header row and at least one partnership.')
    const headers = csv[0].map(headerKey)
    const find = (...aliases) => headers.findIndex(h => aliases.includes(h))
    const rows = [], warnings = []
    const first = find('firstname', 'playerfirstname'), last = find('lastname', 'playerlastname')
    if (first >= 0 && last >= 0 && find('player2name', 'partnername') < 0) {
      const email = find('email', 'emailaddress'), handicap = find('index', 'handicap', '9holehandicap'), id = find('teamid', 'id', 'team'), phone = find('phone', 'phonenumber')
      if (email < 0 || handicap < 0 || id < 0) throw new Error('The player-per-row format needs First Name, Last Name, Email, Index (9-hole handicap), and Team ID columns.')
      const groups = new Map()
      let pendingKey = null, ignored = 0
      csv.slice(1).forEach((cells, index) => {
        const name = [text(cells[first]), text(cells[last])].filter(Boolean).join(' ')
        if (!name || (!text(cells[last]) && !text(cells[email]) && !text(cells[handicap]) && !text(cells[id]))) { if (cells.some(c => text(c))) ignored++; return }
        let key = text(cells[id])
        if (!key && pendingKey && groups.get(pendingKey).players.length === 1) key = pendingKey
        if (!key) key = `unpaired-row-${index + 2}`
        if (!groups.has(key)) groups.set(key, { players:[], rowNumber:index + 2 })
        groups.get(key).players.push(player(name, cells[email], cells[handicap], cells[phone]))
        pendingKey = key
      })
      for (const group of groups.values()) {
        const row = team(group.players[0], group.players[1] || player('', '', ''), '', '', group.rowNumber)
        row.tooManyPartners = group.players.length > 2
        rows.push(row)
      }
      if (ignored) warnings.push(`${ignored} note or email-only row${ignored === 1 ? '' : 's'} skipped. Check the original sheet for any missing player details.`)
    } else {
      const legacy = headers[0] === 'name' && headers[1] === 'phonenumber' && headers[2] === 'email' && headers[3] === '9holehandicap' && headers[9] === 'name' && headers[11] === 'email'
      const p1name = legacy ? 0 : find('player1name', 'p1name', 'name1'), p2name = legacy ? 9 : find('player2name', 'p2name', 'partnername', 'name2')
      const p1email = legacy ? 2 : find('player1email', 'p1email', 'email1'), p2email = legacy ? 11 : find('player2email', 'p2email', 'partneremail', 'email2')
      const p1hcp = legacy ? 3 : find('player1handicap', 'player19holehandicap', 'p1handicap', 'handicap1', '9holehandicap1'), p2hcp = legacy ? 12 : find('player2handicap', 'player29holehandicap', 'p2handicap', 'partnerhandicap', 'handicap2', '9holehandicap2')
      if ([p1name, p2name, p1email, p2email, p1hcp, p2hcp].some(i => i < 0)) throw new Error('Columns were not recognized. Use Player 1 Name, Player 1 Email, Player 1 Handicap, Player 2 Name, Player 2 Email, Player 2 Handicap, or the player-per-row roster format.')
      const day = legacy ? 4 : find('day', 'leagueday'), time = legacy ? 5 : find('time', 'leaguetime'), p1phone = legacy ? 1 : find('player1phone', 'phone1'), p2phone = legacy ? 10 : find('player2phone', 'phone2')
      csv.slice(1).forEach((cells, index) => {
        if (!cells.some(c => text(c))) return
        rows.push(team(player(cells[p1name], cells[p1email], cells[p1hcp], cells[p1phone]), player(cells[p2name], cells[p2email], cells[p2hcp], cells[p2phone]), cells[day], cells[time], index + 2))
      })
    }
    validateImportRows(rows)
    for (const row of rows) if (row.tooManyPartners) row.issues.push('This team ID has more than two golfers. Assign exactly two partners.')
    if (!rows.length) throw new Error('No player partnerships were found in this file.')
    return { rows, warnings, error:null }
  } catch (error) { return { rows:[], warnings:[], error:error.message } }
}

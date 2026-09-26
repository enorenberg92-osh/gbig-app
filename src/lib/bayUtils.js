// Pure helpers for bay check-in (BayCheckIn, AdminBays, LeagueDashboard).
// Board shape comes from the bay_board RPC:
//   { bays: [{ id, label, sort, teams: [{ checkin_id, team_id, team_name,
//              checked_in_at, finished, players: [{ player_id, name,
//              holes_played, submitted, sub_name }] }] }],
//     teams: [{ team_id, team_name, event_id, bay_id, finished }] }

/** "3" → "Bay 3"; a custom name ("VIP", "Bay 7 Lefty") is shown as-is. */
export function bayName(label) {
  const text = String(label ?? '').trim()
  if (!text) return 'Bay'
  return /^\d+[a-z]?$/i.test(text) ? `Bay ${text}` : text
}

/** Normalize what a QR / URL / sim sends: " bay 3 " → "3". */
export function normalizeBayLabel(label) {
  return String(label ?? '').trim().replace(/^bay\s+/i, '').toLowerCase()
}

/** Find a bay by label (case-insensitive, tolerates a "Bay " prefix). */
export function findBayByLabel(bays, label) {
  const wanted = normalizeBayLabel(label)
  if (!wanted) return null
  const list = bays || []
  return list.find(b => String(b.label).trim().toLowerCase() === wanted)
    || list.find(b => normalizeBayLabel(b.label) === wanted)
    || null
}

/** URL a bay's QR code encodes. */
export function checkinUrl(origin, label) {
  const base = String(origin || '').replace(/\/+$/, '')
  return `${base}/league/checkin?bay=${encodeURIComponent(String(label ?? '').trim())}`
}

/** "Team 1 · Team 4" for a bay tile; '' when empty. */
export function occupantNames(bay) {
  return (bay?.teams || []).map(t => t.team_name).filter(Boolean).join(' · ')
}

/** The bay a team is live on, or null. */
export function findTeamBay(board, teamId) {
  if (!teamId) return null
  return (board?.bays || []).find(b => (b.teams || []).some(t => t.team_id === teamId)) || null
}

/** Short progress for a player on the board. */
export function thruLabel(player) {
  if (!player) return ''
  if (player.submitted) return 'Done'
  const n = Number(player.holes_played) || 0
  return n > 0 ? `Thru ${n}` : 'Not started'
}

/** Player name with the sub who is actually swinging, when there is one. */
export function playerDisplayName(player) {
  if (!player) return ''
  return player.sub_name ? `${player.sub_name} (for ${player.name})` : player.name
}

/** Counts for the admin header: teams on bays, busy bays, teams not here yet. */
export function boardSummary(board) {
  const bays = board?.bays || []
  const teams = board?.teams || []
  const onBays = bays.reduce((n, b) => n + (b.teams || []).length, 0)
  return {
    bays: bays.length,
    busyBays: bays.filter(b => (b.teams || []).length > 0).length,
    teamsOnBays: onBays,
    waiting: teams.filter(t => !t.bay_id && !t.finished).length,
  }
}

/** Friendly text for check-in RPC errors. */
export function checkinErrorMessage(error) {
  const message = error?.message || ''
  if (error?.code === 'PGRST202' || /function .* does not exist|schema cache/i.test(message)) {
    return 'Bay check-in isn\'t set up yet. Ask the front desk.'
  }
  if (/fetch|network|Failed to/i.test(message)) return 'No connection. Try again.'
  return message || 'Could not check in. Try again.'
}

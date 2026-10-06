import { compareEffectiveScores } from './roundUtils'
import { displayHole } from './holeUtils'

export function penaltyNet(course, handicap) {
  // PostgreSQL round(numeric) rounds halves away from zero, including plus handicaps.
  const h = Number(handicap ?? 0)
  const rounded = Math.sign(h) * Math.round(Math.abs(h))
  return Number(course?.total_par ?? 36) + rounded + 7
}

export function closeoutStatus(roster, scores) {
  const ids = [...new Set(roster.map(row => row.player_id))]
  const pending = scores.filter(row => row.status === 'pending')
  const effective = new Map()
  for (const row of [...scores].filter(row => row.status === 'verified').sort(compareEffectiveScores)) {
    if (!effective.has(row.player_id)) effective.set(row.player_id, row)
  }
  const pendingIds = new Set(pending.map(row => row.player_id))
  const missing = ids.filter(id => !effective.has(id) && !pendingIds.has(id))
  const penalties = ids.filter(id => effective.get(id)?.entry_type === 'missed_penalty')
  const verified = ids.filter(id => effective.get(id)?.entry_type === 'played')
  const teamIds = [...new Set(roster.map(row => row.team_id))]
  const completeTeams = teamIds.filter(teamId => {
    const members = roster.filter(row => row.team_id === teamId)
    return members.length === 2 && members.every(row => effective.has(row.player_id) && !pendingIds.has(row.player_id))
  })
  const rosterValid = ids.length > 0 && ids.length === roster.length &&
    teamIds.every(id => roster.filter(row => row.team_id === id).length === 2)
  return { expected: ids.length, pending, missing, penalties, verified, effective, completeTeams, teamIds, rosterValid }
}

export function closeoutSkins(scores, players, course) {
  const eligible = new Map(players.filter(p => p.in_skins).map(p => [p.id, p]))
  const played = [...closeoutStatus([], scores).effective.values()].filter(s => s.entry_type === 'played' && eligible.has(s.player_id))
  const winners = []
  for (let i = 0; i < (course?.num_holes || 0); i++) {
    const entries = played.filter(s => Number.isInteger(s.hole_scores?.[i]) && s.hole_scores[i] > 0)
    if (!entries.length) continue
    const low = Math.min(...entries.map(s => s.hole_scores[i]))
    const tied = entries.filter(s => s.hole_scores[i] === low)
    if (tied.length === 1) winners.push({ hole: displayHole(i, course), player: eligible.get(tied[0].player_id), score: low })
  }
  return winners
}

export function closeoutResults(event, scores, roster, teams, players, matchups = []) {
  const format = event.format || 'stroke'
  const playerName = id => players.find(p => p.id === id)?.name || 'Player'
  const teamName = id => teams.find(t => t.id === id)?.name || 'Team'
  // Match results and points are read from the server's finalized computation.
  if (format.startsWith('match_')) return matchups.map(m => ({
    id: m.id,
    name: `${m.home_team_id ? teamName(m.home_team_id) : playerName(m.home_player_id)} vs ${m.away_team_id ? teamName(m.away_team_id) : playerName(m.away_player_id)}`,
    result: m.status === 'final' || m.status === 'completed' || m.status === 'scored'
      ? `${m.points_home ?? 0} – ${m.points_away ?? 0} points`
      : 'Results available after publishing',
  }))
  const status = closeoutStatus(roster, scores)
  if (format === 'stableford') return [...status.effective.values()].filter(s => s.entry_type === 'played').sort((a,b) => (b.format_points ?? -Infinity) - (a.format_points ?? -Infinity)).map(s => ({ id: s.id, name: playerName(s.player_id), result: s.format_points == null ? 'Points available after publishing' : `${s.format_points} points` }))
  const rows = status.teamIds.map(id => {
    const members = roster.filter(r => r.team_id === id)
    const effective = members.map(r => status.effective.get(r.player_id)).filter(Boolean)
    const complete = effective.length === members.length && members.length === 2
    const net = format === 'stroke' ? effective.reduce((n,s) => n + Number(s.net_total ?? 0),0) : effective.find(s => s.format_points != null)?.format_points
    return { id, name: teamName(id), net, complete, result: !complete ? 'Incomplete — review missing scores' : net == null ? 'Results available after publishing' : `Net ${net}` }
  })
  return rows.sort((a,b) => Number(b.complete) - Number(a.complete) || (a.net ?? Infinity) - (b.net ?? Infinity) || a.name.localeCompare(b.name))
}

export function recapText(snapshot, appName) {
  if (snapshot.event.status !== 'closed') return ''
  const { event, scores, roster, teams, players, course, matchups } = snapshot
  const results = closeoutResults(event, scores, roster, teams, players, matchups)
  const skins = closeoutSkins(scores, players, course)
  return `Hi everyone,\n\nHere are the finalized results for ${event.name || `Week ${event.week_number}`} at ${appName}.\n\nRESULTS\n${results.map(r => `${r.name}: ${r.result}`).join('\n') || 'See the standings for results.'}\n\n${snapshot.skinsEnabled ? `SKINS\n${skins.map(s => `Hole ${s.hole}: ${s.player.name}`).join('\n') || 'No skins won this week.'}\n\n` : ''}See the full standings in the app.\n\nSee you next week!\n— ${appName}`
}

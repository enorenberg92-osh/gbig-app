import { compareEffectiveScores } from './roundUtils.js'

// Attribute each result to its event roster, not today's team membership.
export function aggregateSeason(scores, teams, roster) {
  const rosterTeam = new Map(roster.map(r => [`${r.event_id}:${r.player_id}`, r.team_id]))
  const effective = new Map()
  for (const s of [...scores].filter(s => s.status === 'verified').sort(compareEffectiveScores)) {
    const key = `${s.event_id}:${s.player_id}`
    if (!effective.has(key)) effective.set(key, s)
  }
  const totals = new Map()
  for (const s of effective.values()) {
    const teamId = rosterTeam.get(`${s.event_id}:${s.player_id}`)
    if (!teamId) continue // A substitute's mirror is individual history only.
    if (!totals.has(teamId)) totals.set(teamId, { teamId, teamName:teams.find(t=>t.id===teamId)?.name || 'Team', teamGross:0, teamNet:0, events:new Set(), players:new Map() })
    const row = totals.get(teamId)
    row.teamGross += s.gross_total ?? 0
    row.teamNet += s.net_total ?? 0
    row.events.add(s.event_id)
    if (!row.players.has(s.player_id)) row.players.set(s.player_id,{gross:0,net:0})
    const p = row.players.get(s.player_id); p.gross += s.gross_total ?? 0; p.net += s.net_total ?? 0
  }
  return [...totals.values()].map(({events,players,...row})=>({ ...row, players, rounds:events.size, avgGross:(row.teamGross/events.size).toFixed(1), avgNet:(row.teamNet/events.size).toFixed(1), hasScore:true }))
}

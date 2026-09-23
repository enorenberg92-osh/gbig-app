// ── Standings aggregation + ranking ────────────────────────────────────────
import { compareEffectiveScores } from './roundUtils'

/**
 * Season totals per team. Each verified score is attributed to the team the
 * player was rostered on FOR THAT EVENT (roster_at), falling back to the
 * row's own team_id — so a mid-season roster swap moves a player's later
 * rounds to the new team without losing or double-counting earlier ones.
 * Rows with no team (e.g. a sub's personal mirror row) are ignored.
 *
 * One effective row per (event, player): a played round beats a penalty.
 *
 * Returns { [teamId]: { gross, net, rounds, playerRounds, grossMissing, playerIds } }
 *   rounds       — distinct events the team has a result in
 *   grossMissing — player-rounds with no gross (missed-week penalties)
 *   playerIds    — the team's roster at its latest event (for display)
 */
export function aggregateSeasonByTeam(scores, rosterRows, eventOrder = {}) {
  const teamOf = {}
  ;(rosterRows || []).forEach(r => { teamOf[`${r.event_id}:${r.player_id}`] = r.team_id })

  const seen = new Set()
  const byTeam = {}
  ;[...(scores || [])].sort(compareEffectiveScores).forEach(s => {
    const key = `${s.event_id}:${s.player_id}`
    if (seen.has(key)) return
    seen.add(key)
    const teamId = teamOf[key] || s.team_id
    if (!teamId) return
    if (!byTeam[teamId]) byTeam[teamId] = { gross: 0, net: 0, events: new Set(), playerRounds: 0, grossMissing: 0 }
    const t = byTeam[teamId]
    t.events.add(s.event_id)
    t.playerRounds++
    t.net += Number(s.net_total) || 0
    if (s.gross_total == null) t.grossMissing++
    else t.gross += Number(s.gross_total)
  })

  // Latest roster per team (highest event order), for the player chips.
  const latest = {}
  ;(rosterRows || []).forEach(r => {
    const order = eventOrder[r.event_id] ?? -Infinity
    const cur = latest[r.team_id]
    if (!cur || order > cur.order) latest[r.team_id] = { order, playerIds: [r.player_id] }
    else if (order === cur.order && !cur.playerIds.includes(r.player_id)) cur.playerIds.push(r.player_id)
  })

  const out = {}
  Object.entries(byTeam).forEach(([teamId, t]) => {
    out[teamId] = {
      gross: t.gross,
      net: t.net,
      rounds: t.events.size,
      playerRounds: t.playerRounds,
      grossMissing: t.grossMissing,
      playerIds: latest[teamId]?.playerIds || [],
    }
  })
  return out
}

/**
 * Ranks standings rows. Lower is better for net/gross; higher for match
 * points. Scoreless teams sink.
 *
 * Gross: penalty rows have no gross, so a team's gross total is only
 * comparable when its cards are complete. Teams are ranked first by how many
 * player-rounds lack a gross (`grossMissing`, fewer first), then by total
 * gross — a missed week can never improve a gross rank.
 *
 * Format ('format'): the night's format result — `formatDir` 'asc' for
 * scramble / best-ball team results, 'desc' for Stableford points. Teams
 * without a result go after teams with one; net breaks ties.
 */
export function sortStandingRows(rows, by) {
  return [...rows].sort((a, b) => {
    if (!a.hasScore && b.hasScore)  return 1
    if (a.hasScore  && !b.hasScore) return -1
    const byName = () => String(a.teamName ?? '').localeCompare(String(b.teamName ?? ''))
    if (by === 'points') {
      return ((b.points || 0) - (a.points || 0))
        || (a.teamNet - b.teamNet)
        || byName()
    }
    if (by === 'format') {
      const af = a.formatResult, bf = b.formatResult
      if (af == null && bf != null) return 1
      if (af != null && bf == null) return -1
      const dir = (a.formatDir || b.formatDir) === 'desc' ? -1 : 1
      return (af != null && bf != null ? dir * (Number(af) - Number(bf)) : 0)
        || (a.teamNet - b.teamNet)
        || byName()
    }
    if (by === 'gross') {
      return ((a.grossMissing || 0) - (b.grossMissing || 0))
        || (a.teamGross - b.teamGross)
        || byName()
    }
    return (a.teamNet - b.teamNet) || byName()
  })
}

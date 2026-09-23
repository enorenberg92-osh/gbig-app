// ── Seasons (league_config rows) ────────────────────────────────────────────
// Each season is one league_config row. A location runs several over time:
// one is the admin's working league, finished ones get archived_at set.
import { compareRoundsChronologically, roundDate } from './roundUtils'

/** Newest season first: start date (undated last), then name. */
export function compareSeasonsNewestFirst(a, b) {
  const ad = a?.start_date || ''
  const bd = b?.start_date || ''
  if (ad !== bd) {
    if (!ad) return 1
    if (!bd) return -1
    return bd.localeCompare(ad)
  }
  return String(a?.name || '').localeCompare(String(b?.name || ''))
}

/**
 * Seasons for the standings picker, newest first. Admins see every league;
 * players see the working league, anything shown to players (is_active) and
 * archived seasons — not unpublished drafts of next season.
 * `currentId` (the league the page defaults to) is always kept.
 */
export function pickerSeasons(leagues, { adminMode = false, currentId = null } = {}) {
  return (leagues || [])
    .filter(l => adminMode || l.id === currentId || l.is_working || l.is_active || l.archived_at)
    .sort(compareSeasonsNewestFirst)
}

/** Picker label: "Fall 2026 (current)", "Spring 2026 (archived)". */
export function seasonLabel(league, currentId = null) {
  if (!league) return ''
  const tags = []
  if (league.id === currentId) tags.push('current')
  if (league.archived_at) tags.push('archived')
  return `${league.name || 'Untitled season'}${tags.length ? ` (${tags.join(', ')})` : ''}`
}

function round1(n) {
  return Math.round(n * 10) / 10
}

function avg(values) {
  return values.length ? round1(values.reduce((a, v) => a + v, 0) / values.length) : null
}

function num(v) {
  return v == null || v === '' ? null : Number(v)
}

/**
 * Per-season career lines for one player.
 *
 * `scores`: that player's verified PLAYED rows (no penalties, no sub_played
 * marker rows), each with `events: { league_id, start_date, week_number }`.
 * Only one row per event counts — the latest entry, like standings do.
 * `leagues`: league_config rows ({ id, name, start_date, archived_at, is_working }).
 *
 * Returns { seasons: [...newest first], career } where every season has
 * rounds, avgGross, avgNet, bestNet and endHandicap (handicap used in the
 * player's last round of that season).
 */
export function aggregatePlayerSeasons(scores, leagues = []) {
  const leagueById = new Map((leagues || []).map(l => [l.id, l]))

  // One round per event: the newest verified played entry.
  const byEvent = new Map()
  ;(scores || []).forEach(s => {
    if (!s || s.entry_type === 'missed_penalty' || s.sub_played) return
    const key = s.event_id ?? s.events?.id ?? s.id
    const prev = byEvent.get(key)
    if (!prev || String(s.created_at ?? '') > String(prev.created_at ?? '')) byEvent.set(key, s)
  })

  const bySeason = new Map()
  byEvent.forEach(s => {
    const leagueId = s.events?.league_id ?? s.league_id ?? null
    if (!bySeason.has(leagueId)) bySeason.set(leagueId, [])
    bySeason.get(leagueId).push(s)
  })

  const summarize = rows => {
    const gross = rows.map(r => num(r.gross_total)).filter(v => v != null)
    const net   = rows.map(r => num(r.net_total)).filter(v => v != null)
    return {
      rounds:   rows.length,
      avgGross: avg(gross),
      avgNet:   avg(net),
      bestNet:  net.length ? Math.min(...net) : null,
      bestGross: gross.length ? Math.min(...gross) : null,
    }
  }

  const seasons = [...bySeason.entries()].map(([leagueId, rows]) => {
    const league = leagueById.get(leagueId) || null
    const ordered = [...rows].sort(compareRoundsChronologically)
    const last = ordered[ordered.length - 1]
    const firstDate = roundDate(ordered[0])
    const lastDate  = roundDate(last)
    return {
      leagueId,
      name: league?.name || 'Other rounds',
      startDate: league?.start_date || firstDate || null,
      lastPlayed: lastDate,
      archived: !!league?.archived_at,
      isWorking: !!league?.is_working,
      ...summarize(rows),
      endHandicap: num(last?.handicap_used),
    }
  }).sort((a, b) =>
    compareSeasonsNewestFirst({ start_date: a.startDate, name: a.name }, { start_date: b.startDate, name: b.name }))

  const all = [...byEvent.values()]
  const career = { seasons: seasons.length, ...summarize(all) }
  return { seasons, career }
}

import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useLocation } from '../context/LocationContext'
import { loadWorkingLeague } from '../lib/leagueUtils'
import { compareEffectiveScores } from '../lib/roundUtils'

// adminMode: Season shows ALL events (open + closed) so admins have full
// visibility. Players only see closed weeks so rankings stay clean.
export default function Standings({ session, onBack, adminMode = false }) {
  const { locationId } = useLocation()
  const [view, setView]                   = useState('week')
  const [sortBy, setSortBy]               = useState('net')
  const [loading, setLoading]             = useState(true)
  const [events, setEvents]               = useState([])
  const [selectedEvent, setSelectedEvent] = useState(null)
  const [rows, setRows]                   = useState([])
  const [error, setError]                 = useState(null)
  const [leagueId, setLeagueId]           = useState(null)
  const [segments, setSegments]           = useState([])
  const [segmentIdx, setSegmentIdx]       = useState(-1)   // -1 = full season
  const [hasPoints, setHasPoints]         = useState(false)
  const [weekMatchups, setWeekMatchups]   = useState([])
  const [flights, setFlights]             = useState([])
  const [flightFilter, setFlightFilter]   = useState('')
  const [teamFlightMap, setTeamFlightMap] = useState({})

  // ── 1. On mount, fetch the event list ────────────────────────────
  useEffect(() => { if (locationId) loadEvents() }, [locationId])

  // ── 2. Whenever the selected event or view changes, reload data ──
  useEffect(() => {
    if (view === 'week') {
      if (selectedEvent) loadWeekly(selectedEvent.id)
    } else {
      loadSeason()
    }
  }, [view, selectedEvent, segmentIdx])   // eslint-disable-line react-hooks/exhaustive-deps

  // ── 3. Re-sort in place when sort toggle changes ─────────────────
  useEffect(() => {
    setRows(prev => sortRows(prev, sortBy))
  }, [sortBy])                // eslint-disable-line react-hooks/exhaustive-deps

  // ─────────────────────────────────────────────────────────────────
  async function loadEvents() {
    setLoading(true)
    setError(null)

    // Filter by status rather than start_date so the open week always appears
    // in the picker even if its calendar start_date hasn't passed yet.
    let league
    try {
      league = await loadWorkingLeague(supabase, locationId)
    } catch (leagueError) {
      // Players can't act on "choose a working league" — show a friendlier line.
      setError(adminMode ? leagueError.message : 'No active league season yet — check back soon!')
      setLoading(false); return
    }
    setLeagueId(league.id)
    setSegments(Array.isArray(league.segments) ? league.segments : [])
    // Flights (empty unless the league uses them)
    supabase.from('flights').select('id, name, sort_order').eq('league_id', league.id).eq('location_id', locationId).order('sort_order')
      .then(({ data: fl }) => setFlights(fl || []))
    supabase.from('teams').select('id, flight_id').eq('league_id', league.id).eq('location_id', locationId)
      .then(({ data: tf }) => {
        const map = {}
        ;(tf || []).forEach(t => { map[t.id] = t.flight_id })
        setTeamFlightMap(map)
      })
    const { data, error } = await supabase
      .from('events')
      .select('id, name, week_number, start_date, status, format')
      .eq('location_id', locationId)
      .eq('league_id', league.id)
      .neq('is_bye', true)
      .in('status', ['open', 'closed'])
      .order('week_number', { ascending: false })

    if (error) { setError(error.message); setLoading(false); return }

    const evts = data || []
    setEvents(evts)

    if (evts.length === 0) { setLoading(false); return }

    // Always default to the open event so "This Week" shows current-week scores
    const defaultEvt = evts.find(e => e.status === 'open') || evts[0]
    setSelectedEvent(defaultEvt)
    // ↑ Setting selectedEvent triggers useEffect #2, which calls loadWeekly
  }

  // ─────────────────────────────────────────────────────────────────
  async function loadWeekly(eventId) {
    if (!eventId) return
    setLoading(true)
    setError(null)

    const [scoresRes, playersRes, teamsRes, rosterRes, matchupsRes] = await Promise.all([
      supabase.from('scores')
        .select('id, player_id, team_id, event_id, gross_total, net_total, handicap_used, entry_type, status, created_at, format_points')
        .eq('event_id', eventId)
        .eq('location_id', locationId)
        .eq('status', 'verified'),
      supabase.from('players').select('id, name, first_name, last_name, handicap').eq('location_id', locationId),
      supabase.from('teams').select('id, name').eq('location_id', locationId).eq('league_id', leagueId),
      supabase.from('roster_at').select('team_id, team_name, player_id').eq('event_id', eventId),
      supabase.from('matchups').select('*').eq('event_id', eventId),
    ])

    if (scoresRes.error) { setError(scoresRes.error.message); setLoading(false); return }

    // Resolve matchup side names for the week's matchup card.
    const teamNameById = {}
    ;(teamsRes.data || []).forEach(t => { teamNameById[t.id] = t.name })
    const playerNameById = {}
    ;(playersRes.data || []).forEach(p => { playerNameById[p.id] = `${p.first_name || ''} ${p.last_name || ''}`.trim() || p.name })
    setWeekMatchups((matchupsRes.data || []).map(m => ({
      ...m,
      homeName: teamNameById[m.home_team_id] || playerNameById[m.home_player_id] || '?',
      awayName: teamNameById[m.away_team_id] || playerNameById[m.away_player_id] || '?',
    })))

    const teamRows = buildTeamRows(
      scoresRes.data || [], playersRes.data || [], hydrateRosterTeams(teamsRes.data || [], rosterRes.data || []), false
    )
    setRows(sortRows(teamRows, sortBy))
    setLoading(false)
  }

  // ─────────────────────────────────────────────────────────────────
  async function loadSeason() {
    setLoading(true)
    setError(null)

    // Admins see all events; players only see closed weeks
    if (!leagueId) { setLoading(false); return }
    const { data: eligibleEvents } = adminMode
      ? await supabase.from('events').select('id, week_number').eq('location_id', locationId).eq('league_id', leagueId).in('status', ['open', 'closed'])
      : await supabase.from('events').select('id, week_number').eq('location_id', locationId).eq('league_id', leagueId).eq('status', 'closed')

    // Segment filter: restrict to the chosen week range.
    const seg = segmentIdx >= 0 ? segments[segmentIdx] : null
    const inSegment = e => !seg || (e.week_number != null && e.week_number >= seg.start_week && e.week_number <= seg.end_week)
    const ids = (eligibleEvents || []).filter(inSegment).map(e => e.id)
    if (ids.length === 0) { setRows([]); setLoading(false); return }

    const [scoresRes, playersRes, teamsRes, rosterRes, matchupsRes] = await Promise.all([
      supabase.from('scores')
        .select('id, player_id, team_id, event_id, gross_total, net_total, entry_type, status, created_at')
        .in('event_id', ids)
        .eq('location_id', locationId)
        .eq('status', 'verified'),
      supabase.from('players').select('id, name, first_name, last_name, handicap').eq('location_id', locationId),
      supabase.from('teams').select('id, name').eq('location_id', locationId).eq('league_id', leagueId),
      supabase.from('roster_at').select('event_id, team_id, team_name, player_id').in('event_id', ids),
      supabase.from('matchups')
        .select('event_id, home_team_id, away_team_id, points_home, points_away, status')
        .in('event_id', ids)
        .eq('status', 'scored'),
    ])

    if (scoresRes.error) { setError(scoresRes.error.message); setLoading(false); return }

    // Match-play points per team: total points + W-T-L record.
    const pointsByTeam = {}
    ;(matchupsRes.data || []).forEach(m => {
      if (!m.home_team_id) return // player-vs-player matchups feed brackets, not team standings
      const add = (teamId, pts, oppPts) => {
        if (!pointsByTeam[teamId]) pointsByTeam[teamId] = { points: 0, w: 0, t: 0, l: 0 }
        const rec = pointsByTeam[teamId]
        const a = Number(pts) || 0
        const b = Number(oppPts) || 0
        rec.points += a
        if (a > b) rec.w++
        else if (a < b) rec.l++
        else rec.t++
      }
      add(m.home_team_id, m.points_home, m.points_away)
      add(m.away_team_id, m.points_away, m.points_home)
    })
    setHasPoints(Object.keys(pointsByTeam).length > 0)

    const teamRows = buildTeamRows(
      scoresRes.data || [], playersRes.data || [], hydrateRosterTeams(teamsRes.data || [], rosterRes.data || []), true
    )
    // Merge points; include point-earning teams that have no score rows (all-forfeit edge).
    const seen = new Set(teamRows.map(r => r.teamId))
    teamRows.forEach(r => { Object.assign(r, pointsByTeam[r.teamId] || { points: 0, w: 0, t: 0, l: 0 }) })
    Object.entries(pointsByTeam).forEach(([teamId, rec]) => {
      if (!seen.has(teamId)) {
        const team = (teamsRes.data || []).find(t => t.id === teamId)
        if (team) teamRows.push({ teamId, teamName: team.name, p1Name: '', p2Name: '', teamGross: 0, teamNet: 0, rounds: 0, hasScore: true, ...rec })
      }
    })
    setRows(sortRows(teamRows, sortBy))
    setLoading(false)
  }

  function hydrateRosterTeams(teams, rosterRows) {
    const playerIdsByTeam = {}
    rosterRows.forEach(row => {
      if (!playerIdsByTeam[row.team_id]) playerIdsByTeam[row.team_id] = []
      if (!playerIdsByTeam[row.team_id].includes(row.player_id)) playerIdsByTeam[row.team_id].push(row.player_id)
    })
    return teams.map(team => ({
      ...team,
      player1_id: playerIdsByTeam[team.id]?.[0] || null,
      player2_id: playerIdsByTeam[team.id]?.[1] || null,
    }))
  }

  // ─────────────────────────────────────────────────────────────────
  function buildTeamRows(scores, players, teams, aggregate) {
    if (!teams.length) return []

    const playerMap = {}
    players.forEach(p => { playerMap[p.id] = p })

    const byPlayer = {}
    scores.forEach(s => {
      if (!byPlayer[s.player_id]) byPlayer[s.player_id] = []
      byPlayer[s.player_id].push(s)
    })

    const teamRows = []

    for (const team of teams) {
      const p1scores = [...(byPlayer[team.player1_id] || [])].sort(compareEffectiveScores)
      const p2scores = [...(byPlayer[team.player2_id] || [])].sort(compareEffectiveScores)
      if (!p1scores.length && !p2scores.length) continue

      const p1 = playerMap[team.player1_id]
      const p2 = playerMap[team.player2_id]
      const p1Name = p1
        ? (`${p1.first_name || ''} ${p1.last_name || ''}`.trim() || p1.name || 'Player 1')
        : 'Player 1'
      const p2Name = p2
        ? (`${p2.first_name || ''} ${p2.last_name || ''}`.trim() || p2.name || 'Player 2')
        : 'Player 2'

      if (aggregate) {
        const p1Gross = p1scores.reduce((a, s) => a + (s.gross_total || 0), 0)
        const p2Gross = p2scores.reduce((a, s) => a + (s.gross_total || 0), 0)
        const p1Net   = p1scores.reduce((a, s) => a + (s.net_total   || 0), 0)
        const p2Net   = p2scores.reduce((a, s) => a + (s.net_total   || 0), 0)
        const rounds  = Math.max(p1scores.length, p2scores.length)

        teamRows.push({
          teamId: team.id,
          teamName: team.name || `${p1Name.split(' ')[0]}/${p2Name.split(' ')[0]}`,
          p1Name, p2Name, p1Gross, p2Gross,
          teamGross: p1Gross + p2Gross,
          teamNet:   p1Net   + p2Net,
          rounds,
          avgGross: rounds > 0 ? ((p1Gross + p2Gross) / rounds).toFixed(1) : '—',
          avgNet:   rounds > 0 ? ((p1Net   + p2Net)   / rounds).toFixed(1) : '—',
          hasScore: true,
        })
      } else {
        const s1 = p1scores[0]
        const s2 = p2scores[0]
        const p1Gross = s1?.gross_total ?? null
        const p2Gross = s2?.gross_total ?? null
        const p1Net   = s1?.net_total   ?? null
        const p2Net   = s2?.net_total   ?? null
        // Penalty rows carry net_total but no gross_total. Surface the flag so the UI
        // can tag the round without dropping its contribution to the team score.
        const p1IsPenalty = s1?.entry_type === 'missed_penalty'
        const p2IsPenalty = s2?.entry_type === 'missed_penalty'

        teamRows.push({
          teamId: team.id,
          teamName: team.name || `${p1Name.split(' ')[0]}/${p2Name.split(' ')[0]}`,
          p1Name, p1Gross, p1Net, p1IsPenalty,
          p2Name, p2Gross, p2Net, p2IsPenalty,
          teamGross: (p1Gross ?? 0) + (p2Gross ?? 0),
          teamNet:   (p1Net   ?? 0) + (p2Net   ?? 0),
          p1Hcp: p1?.handicap ?? null,
          p2Hcp: p2?.handicap ?? null,
          nightResult: s1?.format_points ?? s2?.format_points ?? null,
          // A submitted-or-penalty entry both count as "has a result" — the team
          // should rank above teams with no scores at all.
          hasScore: s1 != null || s2 != null,
        })
      }
    }

    return teamRows
  }

  // Lower = better in golf (points: higher = better); scoreless teams sink
  function sortRows(rows, by) {
    return [...rows].sort((a, b) => {
      if (!a.hasScore && b.hasScore)  return 1
      if (a.hasScore  && !b.hasScore) return -1
      if (by === 'points') {
        return ((b.points || 0) - (a.points || 0))
          || (a.teamNet - b.teamNet)
          || a.teamName.localeCompare(b.teamName)
      }
      return by === 'gross'
        ? (a.teamGross - b.teamGross) || a.teamName.localeCompare(b.teamName)
        : (a.teamNet   - b.teamNet) || a.teamName.localeCompare(b.teamName)
    })
  }

  function medalEmoji(rank) {
    return ['🥇', '🥈', '🥉'][rank] ?? null
  }

  function medalColor(rank) {
    return ['#FFD700', '#C0C0C0', '#CD7F32'][rank] ?? null
  }

  const displayRows = flightFilter
    ? rows.filter(r => teamFlightMap[r.teamId] === flightFilter)
    : rows

  // Team-of-the-night column (scramble / best ball, once results are computed)
  const isNightEvent = view === 'week'
    && ['scramble', 'best_ball'].includes(selectedEvent?.format)
    && rows.some(r => r.nightResult != null)

  const eventLabel = (evt) => {
    const wk  = evt.week_number ? `Wk ${evt.week_number} — ` : ''
    const tag = evt.status === 'open' ? ' (current)' : ''
    return `${wk}${evt.name}${tag}`
  }

  // ─────────────────────────────────────────────────────────────────
  if (error) {
    return (
      <div style={styles.centered}>
        <p style={{ color: '#c53030', fontSize: 14 }}>Error: {error}</p>
        {onBack && <button style={styles.backBtn} onClick={onBack}>← Back</button>}
      </div>
    )
  }

  return (
    <div style={styles.container}>

      {/* Header — hidden in admin panel (no onBack) */}
      {onBack && (
        <div style={styles.header}>
          <button style={styles.headerBack} onClick={onBack}>← Back</button>
          <div style={styles.headerTitle}>Standings</div>
          <div style={{ width: 52 }} />
        </div>
      )}

      {/* This Week / Season toggle */}
      <div style={styles.toggleRow}>
        <button
          style={{ ...styles.toggleBtn, ...(view === 'week' ? styles.toggleActive : {}) }}
          onClick={() => setView('week')}
        >This Week</button>
        <button
          style={{ ...styles.toggleBtn, ...(view === 'season' ? styles.toggleActive : {}) }}
          onClick={() => setView('season')}
        >Season</button>
      </div>

      {/* Week picker (only visible in weekly view) */}
      {view === 'week' && events.length > 0 && (
        <div style={styles.eventPicker}>
          <select
            style={styles.eventSelect}
            value={selectedEvent?.id || ''}
            onChange={e => {
              const evt = events.find(ev => ev.id === e.target.value)
              setSelectedEvent(evt)
            }}
          >
            {events.map(evt => (
              <option key={evt.id} value={evt.id}>{eventLabel(evt)}</option>
            ))}
          </select>
        </div>
      )}

      {/* Season context note */}
      {view === 'season' && adminMode && (
        <p style={styles.seasonNote}>All weeks included. Players only see completed weeks.</p>
      )}

      {/* Segment picker */}
      {view === 'season' && segments.length > 0 && (
        <div style={styles.eventPicker}>
          <select
            style={styles.eventSelect}
            value={segmentIdx}
            onChange={e => setSegmentIdx(parseInt(e.target.value, 10))}
          >
            <option value={-1}>Full season</option>
            {segments.map((seg, i) => (
              <option key={i} value={i}>
                {seg.name} (Wk {seg.start_week}–{seg.end_week})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Flight filter */}
      {flights.length > 0 && (
        <div style={styles.eventPicker}>
          <select style={styles.eventSelect} value={flightFilter} onChange={e => setFlightFilter(e.target.value)}>
            <option value="">All flights</option>
            {flights.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </div>
      )}

      {/* Net / Gross / Points sort */}
      <div style={styles.sortRow}>
        <span style={styles.sortLabel}>Sort by:</span>
        <button
          style={{ ...styles.sortBtn, ...(sortBy === 'net' ? styles.sortActive : {}) }}
          onClick={() => setSortBy('net')}
        >Net Score</button>
        <button
          style={{ ...styles.sortBtn, ...(sortBy === 'gross' ? styles.sortActive : {}) }}
          onClick={() => setSortBy('gross')}
        >Gross Score</button>
        {view === 'season' && hasPoints && (
          <button
            style={{ ...styles.sortBtn, ...(sortBy === 'points' ? styles.sortActive : {}) }}
            onClick={() => setSortBy('points')}
          >Points</button>
        )}
      </div>

      {/* Weekly matchups (match-play weeks) */}
      {!loading && view === 'week' && weekMatchups.length > 0 && (
        <div style={{ ...styles.tableWrap, marginBottom: 0 }}>
          <div style={styles.tableHeader}>
            <div style={{ ...styles.thCell, flex: 1 }}>Matchups</div>
          </div>
          {weekMatchups.map(m => (
            <div key={m.id} style={{ ...styles.teamRow, justifyContent: 'space-between' }}>
              <span style={{ fontSize: 13, color: 'var(--black)' }}>
                {m.homeName} <span style={{ color: 'var(--gray-400)' }}>vs</span> {m.awayName}
              </span>
              {m.status === 'scored' ? (
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--green-dark)' }}>
                  {Number(m.points_home)}–{Number(m.points_away)}
                  {m.result?.no_show && <span style={{ fontWeight: 400, color: 'var(--gray-400)' }}> (no-show)</span>}
                </span>
              ) : (
                <span style={{ fontSize: 11, color: 'var(--gray-400)', fontStyle: 'italic' }}>not scored</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div style={styles.loading}>Loading standings…</div>
      ) : displayRows.length === 0 ? (
        <div style={styles.empty}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>📭</div>
          <p style={{ margin: 0 }}>
            {view === 'season'
              ? (adminMode ? 'No scores recorded yet.' : 'No completed weeks yet.')
              : selectedEvent
                ? `No scores recorded yet for ${selectedEvent.name}.`
                : 'No scores recorded yet.'}
          </p>
        </div>
      ) : (
        <div style={styles.tableWrap}>
          <div style={styles.tableHeader}>
            <div style={{ ...styles.thCell, width: 32 }}>#</div>
            <div style={{ ...styles.thCell, flex: 1 }}>Team</div>
            {view === 'season' && hasPoints && (
              <div style={{ ...styles.thCell, width: 56, textAlign: 'right' }}>Pts</div>
            )}
            {isNightEvent && (
              <div style={{ ...styles.thCell, width: 56, textAlign: 'right' }}>Team</div>
            )}
            <div style={{ ...styles.thCell, width: 56, textAlign: 'right' }}>Gross</div>
            <div style={{ ...styles.thCell, width: 56, textAlign: 'right' }}>Net</div>
          </div>

          {displayRows.map((row, idx) => (
            <div key={row.teamId} style={{ ...styles.teamRow, ...(idx < 3 ? styles.teamRowTop : {}) }}>
              <div style={{ ...styles.rankCell, color: medalColor(idx) || 'var(--gray-400)' }}>
                {medalEmoji(idx) ?? idx + 1}
              </div>

              <div style={styles.teamInfo}>
                <div style={styles.teamName}>{row.teamName}</div>
                <div style={styles.playerLine}>
                  <span style={styles.playerChip}>
                    {row.p1Name.split(' ')[0]}
                    {view === 'week' && row.p1Gross != null && (
                      <span style={styles.chipScore}> {row.p1Gross}</span>
                    )}
                    {view === 'week' && row.p1IsPenalty && (
                      <span style={styles.penaltyPill}>Missed</span>
                    )}
                  </span>
                  <span style={styles.ampersand}>&</span>
                  <span style={styles.playerChip}>
                    {row.p2Name.split(' ')[0]}
                    {view === 'week' && row.p2Gross != null && (
                      <span style={styles.chipScore}> {row.p2Gross}</span>
                    )}
                    {view === 'week' && row.p2IsPenalty && (
                      <span style={styles.penaltyPill}>Missed</span>
                    )}
                  </span>
                  {view === 'season' && row.rounds != null && (
                    <span style={styles.roundsBadge}>
                      {row.rounds} rnd{row.rounds !== 1 ? 's' : ''}
                    </span>
                  )}
                  {view === 'season' && hasPoints && (row.w + row.t + row.l) > 0 && (
                    <span style={styles.roundsBadge}>{row.w}–{row.t}–{row.l}</span>
                  )}
                </div>
              </div>

              {view === 'season' && hasPoints && (
                <div style={{ ...styles.scoreCell, fontWeight: sortBy === 'points' ? 700 : 400, color: 'var(--green-dark)' }}>
                  {row.points ?? 0}
                </div>
              )}
              {isNightEvent && (
                <div style={{ ...styles.scoreCell, fontWeight: 700, color: 'var(--green-dark)' }}>
                  {row.nightResult != null ? Number(row.nightResult) : '—'}
                </div>
              )}
              <div style={{ ...styles.scoreCell, fontWeight: sortBy === 'gross' ? 700 : 400 }}>
                {row.teamGross || '—'}
              </div>
              <div style={{ ...styles.scoreCell, fontWeight: sortBy === 'net' ? 700 : 400, color: 'var(--green-dark)' }}>
                {row.teamNet || '—'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const styles = {
  container:    { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--off-white)' },
  centered:     { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16, padding: 24 },
  header:       { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--green-dark)', color: 'var(--white)', flexShrink: 0 },
  headerBack:   { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: 500, width: 52 },
  headerTitle:  { fontSize: 17, fontWeight: 800, color: 'var(--white)', letterSpacing: '-0.2px' },
  toggleRow:    { display: 'flex', margin: '12px 16px 0', background: 'var(--white)', borderRadius: 'var(--radius-sm)', padding: 3, boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)', gap: 2 },
  toggleBtn:    { flex: 1, padding: '8px', borderRadius: 6, fontSize: 13, fontWeight: 600, color: 'var(--gray-400)', transition: 'all 0.15s' },
  toggleActive: { background: 'var(--green)', color: 'var(--white)', boxShadow: '0 1px 4px rgba(45,106,79,0.3)' },
  eventPicker:  { margin: '10px 16px 0' },
  eventSelect:  { width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: 13, background: 'var(--white)', color: 'var(--black)' },
  seasonNote:   { margin: '8px 16px 0', fontSize: 11, color: 'var(--gray-400)', fontStyle: 'italic', lineHeight: 1.4 },
  sortRow:      { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px 0' },
  sortLabel:    { fontSize: 11, color: 'var(--gray-400)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px', marginRight: 2 },
  sortBtn:      { padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 600, color: 'var(--gray-600)', background: 'var(--white)', border: '1px solid var(--gray-200)' },
  sortActive:   { background: 'var(--green-xlight)', color: 'var(--green-dark)', border: '1px solid var(--green)' },
  loading:      { padding: 40, textAlign: 'center', color: 'var(--gray-400)', fontSize: 14 },
  empty:        { padding: 40, textAlign: 'center', color: 'var(--gray-400)', fontSize: 14, lineHeight: 1.6 },
  backBtn:      { padding: '10px 24px', background: 'var(--green)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: 14, fontWeight: 700 },
  tableWrap:    { margin: '12px 16px 24px', background: 'var(--white)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)', overflow: 'hidden' },
  tableHeader:  { display: 'flex', alignItems: 'center', padding: '8px 12px', background: 'var(--off-white)', borderBottom: '1px solid var(--gray-200)' },
  thCell:       { fontSize: 10, fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.5px' },
  teamRow:      { display: 'flex', alignItems: 'center', padding: '12px', borderBottom: '1px solid var(--gray-100)', gap: 8 },
  teamRowTop:   { background: 'linear-gradient(to right, rgba(45,106,79,0.03), transparent)' },
  rankCell:     { width: 32, fontSize: 16, textAlign: 'center', flexShrink: 0 },
  teamInfo:     { flex: 1, minWidth: 0 },
  teamName:     { fontSize: 14, fontWeight: 700, color: 'var(--black)', marginBottom: 3 },
  playerLine:   { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  playerChip:   { fontSize: 11, color: 'var(--gray-600)', background: 'var(--gray-100)', padding: '2px 7px', borderRadius: 10, fontWeight: 500 },
  penaltyPill:  { display: 'inline-block', marginLeft: 6, fontSize: 9, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: '#8a6d1f', background: '#fef3c7', border: '1px solid #f6e27a', padding: '1px 6px', borderRadius: 10 },
  chipScore:    { fontWeight: 700, color: 'var(--green-dark)' },
  ampersand:    { fontSize: 10, color: 'var(--gray-400)' },
  roundsBadge:  { fontSize: 10, color: 'var(--green)', background: 'var(--green-xlight)', padding: '2px 7px', borderRadius: 10, fontWeight: 600 },
  scoreCell:    { width: 56, textAlign: 'right', fontSize: 15, color: 'var(--black)', flexShrink: 0 },
}

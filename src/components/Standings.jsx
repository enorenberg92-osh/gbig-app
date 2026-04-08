import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export default function Standings({ session, onBack }) {
  const [view, setView]         = useState('week')
  const [sortBy, setSortBy]     = useState('net')
  const [loading, setLoading]   = useState(true)
  const [events, setEvents]     = useState([])
  const [selectedEvent, setSelectedEvent] = useState(null)
  const [rows, setRows]         = useState([])
  const [error, setError]       = useState(null)

  useEffect(() => { loadEvents() }, [])

  useEffect(() => {
    if (view === 'week' && selectedEvent) loadWeekly(selectedEvent.id)
    if (view === 'season') loadSeason()
  }, [view, selectedEvent, sortBy])

  async function loadEvents() {
    // Only show events that have already started — never expose future weeks to players
    const today = new Date().toISOString().split('T')[0]
    const { data, error } = await supabase
      .from('events')
      .select('id, name, week_number, start_date, status')
      .neq('is_bye', true)
      .lte('start_date', today)
      .order('week_number', { ascending: false })

    if (error) { setError(error.message); setLoading(false); return }

    const evts = data || []
    setEvents(evts)
    if (evts.length > 0) setSelectedEvent(evts[0])
    else setLoading(false)
  }

  async function loadWeekly(eventId) {
    setLoading(true)
    setError(null)

    // Load scores, players, and teams separately (avoid FK join failures)
    const [scoresRes, playersRes, teamsRes] = await Promise.all([
      supabase.from('scores').select('id, player_id, event_id, gross_total, net_total, handicap_used').eq('event_id', eventId),
      supabase.from('players').select('id, name, first_name, last_name, handicap'),
      supabase.from('teams').select('id, name, player1_id, player2_id'),
    ])

    if (scoresRes.error) { setError(scoresRes.error.message); setLoading(false); return }

    const playerMap = {}
    ;(playersRes.data || []).forEach(p => { playerMap[p.id] = p })

    const teamRows = buildTeamRows(scoresRes.data || [], playersRes.data || [], teamsRes.data || [], false)
    setRows(sortRows(teamRows, sortBy))
    setLoading(false)
  }

  async function loadSeason() {
    setLoading(true)
    setError(null)

    // Load all scored events (open or closed)
    const { data: closedEvents } = await supabase
      .from('events')
      .select('id')
      .in('status', ['open', 'closed'])

    const closedIds = (closedEvents || []).map(e => e.id)

    if (closedIds.length === 0) {
      setRows([])
      setLoading(false)
      return
    }

    const [scoresRes, playersRes, teamsRes] = await Promise.all([
      supabase.from('scores').select('id, player_id, event_id, gross_total, net_total').in('event_id', closedIds),
      supabase.from('players').select('id, name, first_name, last_name, handicap'),
      supabase.from('teams').select('id, name, player1_id, player2_id'),
    ])

    if (scoresRes.error) { setError(scoresRes.error.message); setLoading(false); return }

    const teamRows = buildTeamRows(scoresRes.data || [], playersRes.data || [], teamsRes.data || [], true)
    setRows(sortRows(teamRows, sortBy))
    setLoading(false)
  }

  function buildTeamRows(scores, players, teams, aggregate) {
    if (!scores.length || !teams.length) return []

    // Build lookup maps
    const playerMap = {}
    players.forEach(p => { playerMap[p.id] = p })

    const byPlayer = {}
    scores.forEach(s => {
      if (!byPlayer[s.player_id]) byPlayer[s.player_id] = []
      byPlayer[s.player_id].push(s)
    })

    const teamRows = []

    for (const team of teams) {
      const p1scores = byPlayer[team.player1_id] || []
      const p2scores = byPlayer[team.player2_id] || []

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
          teamName: team.name || `${p1Name.split(' ')[0]} & ${p2Name.split(' ')[0]}`,
          p1Name, p2Name,
          p1Gross, p2Gross,
          teamGross: p1Gross + p2Gross,
          teamNet:   p1Net + p2Net,
          rounds,
          avgGross: rounds > 0 ? ((p1Gross + p2Gross) / rounds).toFixed(1) : '—',
          avgNet:   rounds > 0 ? ((p1Net   + p2Net)   / rounds).toFixed(1) : '—',
        })
      } else {
        const s1 = p1scores[0]
        const s2 = p2scores[0]
        const p1Gross = s1?.gross_total ?? null
        const p2Gross = s2?.gross_total ?? null
        const p1Net   = s1?.net_total   ?? null
        const p2Net   = s2?.net_total   ?? null

        teamRows.push({
          teamId: team.id,
          teamName: team.name || `${p1Name.split(' ')[0]} & ${p2Name.split(' ')[0]}`,
          p1Name, p1Gross, p1Net,
          p2Name, p2Gross, p2Net,
          teamGross: (p1Gross ?? 0) + (p2Gross ?? 0),
          teamNet:   (p1Net   ?? 0) + (p2Net   ?? 0),
          p1Hcp: p1?.handicap ?? null,
          p2Hcp: p2?.handicap ?? null,
        })
      }
    }

    return teamRows
  }

  function sortRows(rows, by) {
    return [...rows].sort((a, b) =>
      by === 'gross' ? a.teamGross - b.teamGross : a.teamNet - b.teamNet
    )
  }

  useEffect(() => {
    setRows(prev => sortRows(prev, sortBy))
  }, [sortBy])

  function medalColor(rank) {
    if (rank === 0) return '#FFD700'
    if (rank === 1) return '#C0C0C0'
    if (rank === 2) return '#CD7F32'
    return null
  }

  const eventLabel = (evt) => {
    const wk = evt.week_number ? `Wk ${evt.week_number} — ` : ''
    return `${wk}${evt.name}`
  }

  if (error) {
    return (
      <div style={styles.centered}>
        <p style={{ color: '#c53030', fontSize: 14 }}>Error: {error}</p>
        <button style={styles.backBtn} onClick={onBack}>← Back</button>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button style={styles.headerBack} onClick={onBack}>← Back</button>
        <div style={styles.headerTitle}>Standings</div>
        <div style={{ width: 52 }} />
      </div>

      {/* View toggle */}
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

      {/* Event selector (weekly only) */}
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

      {/* Sort toggle */}
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
      </div>

      {/* Standings */}
      {loading ? (
        <div style={styles.loading}>Loading standings…</div>
      ) : rows.length === 0 ? (
        <div style={styles.empty}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>📭</div>
          <p>No scores recorded yet{view === 'week' && selectedEvent ? ` for ${selectedEvent.name}` : ''}.</p>
        </div>
      ) : (
        <div style={styles.tableWrap}>
          <div style={styles.tableHeader}>
            <div style={{ ...styles.thCell, width: 32 }}>#</div>
            <div style={{ ...styles.thCell, flex: 1 }}>Team</div>
            <div style={{ ...styles.thCell, width: 48, textAlign: 'right' }}>Gross</div>
            <div style={{ ...styles.thCell, width: 48, textAlign: 'right' }}>Net</div>
          </div>

          {rows.map((row, idx) => {
            const medal = medalColor(idx)
            return (
              <div key={row.teamId} style={{ ...styles.teamRow, ...(idx < 3 ? styles.teamRowTop : {}) }}>
                <div style={{ ...styles.rankCell, color: medal || 'var(--gray-400)' }}>
                  {medal ? ['🥇', '🥈', '🥉'][idx] : idx + 1}
                </div>

                <div style={styles.teamInfo}>
                  <div style={styles.teamName}>{row.teamName}</div>
                  <div style={styles.playerLine}>
                    <span style={styles.playerChip}>
                      {row.p1Name.split(' ')[0]}
                      {view === 'week' && row.p1Gross != null && (
                        <span style={styles.chipScore}> {row.p1Gross}</span>
                      )}
                    </span>
                    <span style={styles.ampersand}>&</span>
                    <span style={styles.playerChip}>
                      {row.p2Name.split(' ')[0]}
                      {view === 'week' && row.p2Gross != null && (
                        <span style={styles.chipScore}> {row.p2Gross}</span>
                      )}
                    </span>
                    {view === 'season' && row.rounds != null && (
                      <span style={styles.roundsBadge}>{row.rounds} rnd{row.rounds !== 1 ? 's' : ''}</span>
                    )}
                  </div>
                </div>

                <div style={{ ...styles.scoreCell, fontWeight: sortBy === 'gross' ? 700 : 400 }}>
                  {view === 'season' ? row.avgGross : row.teamGross || '—'}
                </div>
                <div style={{ ...styles.scoreCell, fontWeight: sortBy === 'net' ? 700 : 400, color: 'var(--green-dark)' }}>
                  {view === 'season' ? row.avgNet : row.teamNet || '—'}
                </div>
              </div>
            )
          })}
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
  chipScore:    { fontWeight: 700, color: 'var(--green-dark)' },
  ampersand:    { fontSize: 10, color: 'var(--gray-400)' },
  roundsBadge:  { fontSize: 10, color: 'var(--green)', background: 'var(--green-xlight)', padding: '2px 7px', borderRadius: 10, fontWeight: 600 },
  scoreCell:    { width: 48, textAlign: 'right', fontSize: 15, color: 'var(--black)', flexShrink: 0 },
}

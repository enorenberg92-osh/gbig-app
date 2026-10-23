import React, { useState, useEffect, useRef } from 'react'
import { Target, Inbox } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import { Button, Toast, EmptyState } from '../ui'
import { displayHole } from '../../lib/holeUtils'
import { loadSkinsRound, loadSeasonSkinsEnrollments } from '../../lib/loadSkinsRound'
import { loadWorkingLeague } from '../../lib/leagueUtils'
import { fetchAllRows } from '../../lib/fetchAllRows'

const SCORE_LABELS = [
  { diff: -3, label: 'Albatross', color: '#b8860b', bg: '#fef9c3' },
  { diff: -2, label: 'Eagle 🦅',  color: '#b8860b', bg: '#fef9c3' },
  { diff: -1, label: 'Birdie 🐦', color: '#dc2626', bg: '#fee2e2' },
  { diff:  0, label: 'Par',       color: '#16a34a', bg: '#dcfce7' },
  { diff:  1, label: 'Bogey',     color: 'var(--black, #111)', bg: 'transparent' },
  { diff:  2, label: 'Double',    color: 'var(--black, #111)', bg: 'transparent' },
]

function scoreLabel(score, par) {
  if (!score || !par) return null
  const diff = score - par
  const match = SCORE_LABELS.find(l => l.diff === diff) || { label: `+${diff}`, color: 'var(--black, #111)', bg: 'transparent' }
  return match
}

export default function AdminSkins({ activeEventId = null, onEventChange = () => {} }) {
  const { locationId } = useLocation()
  const [events, setEvents]           = useState([])
  const [selectedEvent, setSelectedEvent] = useState(activeEventId || '')
  const [eventDetails, setEventDetails] = useState(null)
  const [skinResults, setSkinResults] = useState(null)   // null = not yet run
  const [calculating, setCalculating] = useState(false)
  const [loading, setLoading]         = useState(true)
  const [toast, setToast]             = useState(null)
  const [leaguePlayers, setLeaguePlayers] = useState([])
  const [workingLeague, setWorkingLeague] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [savingPlayers, setSavingPlayers] = useState(new Set())
  const pendingPlayers = useRef(new Set())
  const scope = useRef(0)
  const reportRequest = useRef(0)

  useEffect(() => {
    if (!locationId) return
    const currentScope = ++scope.current
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setWorkingLeague(null)
    setLeaguePlayers([])
    setSkinResults(null)
    setSavingPlayers(new Set())
    async function load() {
      try {
        const league = await loadWorkingLeague(supabase, locationId)
        const [results, enrollments] = await Promise.all([
          Promise.all([
            fetchAllRows(() => supabase.from('events')
              .select('id, name, week_number, start_date, course_id, status')
              .eq('location_id', locationId)
              .eq('league_id', league.id)
              .neq('is_bye', true)
              .order('week_number', { ascending: true }).order('id')),
            fetchAllRows(() => supabase.from('players')
              .select('id, name, first_name, last_name, league_id')
              .eq('location_id', locationId)
              .order('id')),
            fetchAllRows(() => supabase.from('teams')
              .select('id, player1_id, player2_id').eq('location_id', locationId).eq('league_id', league.id).order('id')),
          ]),
          loadSeasonSkinsEnrollments(supabase, league.id, locationId),
        ])
        const failure = results.find(result => result.error)
        if (failure) throw failure.error
        const [evts, plrs, teams] = results.map(result => result.data || [])
        const rosterIds = new Set(teams.flatMap(team => [team.player1_id, team.player2_id]).filter(Boolean))
        enrollments.forEach(row => rosterIds.add(row.player_id))
        const enrolledIds = new Set(enrollments.filter(row => row.enrolled).map(row => row.player_id))
        const roster = plrs.filter(player => rosterIds.has(player.id) || player.league_id === league.id)
        const enrolledPlayers = roster.map(player => ({ ...player, in_skins: enrolledIds.has(player.id) }))
        if (cancelled || currentScope !== scope.current) return
        setWorkingLeague(league)
        setEvents(evts)
        setLeaguePlayers(enrolledPlayers.sort((a, b) =>
          playerLastName(a).localeCompare(playerLastName(b), undefined, { sensitivity: 'base' }) ||
          playerName(a).localeCompare(playerName(b), undefined, { sensitivity: 'base' })
        ))
        const nextEvent = evts.find(event => event.id === activeEventId) || evts.find(event => event.status === 'open') || evts[0]
        setSelectedEvent(nextEvent?.id || '')
        if (nextEvent && nextEvent.id !== activeEventId) onEventChange(nextEvent.id)
      } catch (error) {
        if (cancelled || currentScope !== scope.current) return
        setEvents([])
        setSelectedEvent('')
        setLoadError(error.message || 'Skins enrollment could not be loaded. Reload to try again.')
      } finally {
        if (!cancelled && currentScope === scope.current) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true; scope.current++; reportRequest.current++ }
  }, [locationId])

  // Sync when parent changes the active event
  useEffect(() => {
    if (activeEventId && activeEventId !== selectedEvent && events.some(event => event.id === activeEventId)) {
      setSelectedEvent(activeEventId)
    }
  }, [activeEventId])

  // Reset report when event changes
  useEffect(() => {
    reportRequest.current++
    setSkinResults(null)
    setCalculating(false)
    setEventDetails(null)
    let cancelled = false
    if (!selectedEvent) return
    // Load event details (for course par info)
    supabase.from('events').select('*, courses(id, name, num_holes, hole_pars, total_par, start_hole)')
      .eq('id', selectedEvent).eq('location_id', locationId).single()
      .then(({ data }) => { if (!cancelled) setEventDetails(data || null) })
    return () => { cancelled = true }
  }, [selectedEvent])

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  async function toggleEnrollment(player, enrolled) {
    if (!workingLeague || loadError) return
    const key = `${workingLeague.id}:${player.id}`
    if (pendingPlayers.current.has(key)) return
    const currentScope = scope.current
    pendingPlayers.current.add(key)
    setSavingPlayers(previous => new Set(previous).add(player.id))
    setLeaguePlayers(previous => previous.map(row => row.id === player.id ? { ...row, in_skins: enrolled } : row))
    reportRequest.current++
    setSkinResults(null)
    try {
      const { data, error } = await supabase.rpc('admin_set_skins_enrollment', {
        p_league_id: workingLeague.id, p_player_id: player.id, p_enrolled: enrolled,
      })
      if (error) throw error
      if (data !== enrolled) throw new Error('Enrollment could not be verified. Please try again.')
    } catch (error) {
      if (currentScope !== scope.current) return
      setLeaguePlayers(previous => previous.map(row => row.id === player.id ? { ...row, in_skins: player.in_skins } : row))
      showToast('Enrollment not saved: ' + error.message, 'error')
    } finally {
      pendingPlayers.current.delete(key)
      if (currentScope === scope.current) setSavingPlayers(previous => {
        const next = new Set(previous)
        next.delete(player.id)
        return next
      })
    }
  }

  async function runSkinReport() {
    if (!selectedEvent) return
    const request = ++reportRequest.current
    setCalculating(true)
    setSkinResults(null)

    let round
    try { round = await loadSkinsRound(supabase, selectedEvent, locationId) }
    catch (error) {
      if (request !== reportRequest.current) return
      showToast('Error loading skins: ' + error.message, 'error')
      setCalculating(false)
      return
    }
    if (request !== reportRequest.current) return
    const { scores: skinsScores, players: allPlayers, course: resolvedCourse } = round
    const holePars = resolvedCourse.hole_pars
    const playerMap = {}
    allPlayers.forEach(p => { playerMap[p.id] = p })

    if (skinsScores.length === 0) {
      setSkinResults([])
      setCalculating(false)
      return
    }

    // 4. Calculate skins hole by hole
    const results = []
    for (let h = 0; h < resolvedCourse.num_holes; h++) {
      const par = holePars ? holePars[h] : null

      // Collect each skins player's score on this hole
      const holeEntries = skinsScores
        .filter(s => Array.isArray(s.hole_scores) && s.hole_scores[h] != null)
        .map(s => ({
          playerId: s.player_id,
          player:   playerMap[s.player_id],
          score:    s.hole_scores[h],
        }))

      if (holeEntries.length === 0) {
        results.push({ hole: displayHole(h, resolvedCourse), par, status: 'no_scores', participants: skinsScores.length })
        continue
      }

      const minScore = Math.min(...holeEntries.map(e => e.score))
      const winners  = holeEntries.filter(e => e.score === minScore)

      if (winners.length === 1) {
        results.push({
          hole: displayHole(h, resolvedCourse),
          par,
          status: 'won',
          winner: winners[0].player,
          score:  minScore,
          allEntries: holeEntries,
        })
      } else {
        results.push({
          hole: displayHole(h, resolvedCourse),
          par,
          status: 'tied',
          tiedPlayers: winners.map(w => w.player),
          score: minScore,
          allEntries: holeEntries,
        })
      }
    }

    setSkinResults(results)
    setCalculating(false)
  }

  // ── Derived summary ─────────────────────────────────────────────────────────
  const skinsPlayers = leaguePlayers.filter(player => player.in_skins)
  const wonHoles    = skinResults ? skinResults.filter(r => r.status === 'won') : []
  const tiedHoles   = skinResults ? skinResults.filter(r => r.status === 'tied') : []
  const totalSkins  = wonHoles.length

  // Count skins per player
  const playerSkinCounts = {}
  wonHoles.forEach(r => {
    if (!r.winner) return
    const name = playerName(r.winner)
    playerSkinCounts[name] = (playerSkinCounts[name] || 0) + 1
  })
  const skinLeaders = Object.entries(playerSkinCounts).sort((a, b) => b[1] - a[1])

  function playerName(p) {
    if (!p) return 'Unknown'
    return p.first_name ? `${p.first_name} ${p.last_name || ''}`.trim() : p.name || 'Unknown'
  }

  function playerLastName(p) {
    return p.last_name?.trim() || (p.name || playerName(p)).trim().split(/\s+/).at(-1) || ''
  }

  if (loading) return <div style={st.loading}>Loading…</div>

  const eventLabel = (evt) => {
    const wk = evt.week_number ? `Wk ${evt.week_number} — ` : ''
    const dt = evt.start_date
      ? ` · ${new Date(evt.start_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
      : ''
    return `${wk}${evt.name || 'Unnamed'}${dt}`
  }

  return (
    <div style={st.page}>
      <Toast toast={toast} />

      {/* Event selector */}
      <div style={st.card}>
        <label style={st.label}>Select Event</label>
        <select
          style={st.select}
          value={selectedEvent}
          onChange={e => { setSelectedEvent(e.target.value); onEventChange(e.target.value) }}
        >
          {events.map(evt => (
            <option key={evt.id} value={evt.id}>{eventLabel(evt)}</option>
          ))}
        </select>

        <div style={st.skinsNote} aria-live="polite">
          {loadError || `${skinsPlayers.length} of ${leaguePlayers.length} players enrolled in skins${workingLeague?.name ? ` · ${workingLeague.name}` : ''}`}
        </div>
        {!loadError && leaguePlayers.length > 0 && (
          <div role="region" aria-label="Skins enrollment players" tabIndex={0} style={st.enrollmentList}>
            {leaguePlayers.map(player => (
              <label key={player.id} style={st.enrollmentRow}>
                <span style={st.enrollmentName}>{playerName(player)}</span>
                <input
                  type="checkbox"
                  checked={player.in_skins}
                  disabled={savingPlayers.has(player.id) || calculating}
                  onChange={event => toggleEnrollment(player, event.target.checked)}
                  aria-label={`Enroll ${playerName(player)} in skins`}
                  style={st.enrollmentCheckbox}
                />
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Run report button */}
      <Button
        variant="primary"
        size="lg"
        fullWidth
        icon={<Target size={16} strokeWidth={2.25} />}
        loading={calculating}
        loadingText="Calculating…"
        disabled={!selectedEvent || !!loadError || savingPlayers.size > 0}
        onClick={runSkinReport}
        style={{
          background: 'var(--green-dark)',
          borderColor: 'var(--green-dark)',
          padding: '16px',
          fontSize: '15px',
          fontWeight: 800,
          letterSpacing: '0.2px',
          boxShadow: '0 2px 8px rgba(45,106,79,0.25)',
        }}
      >
        Run Skin Report
      </Button>

      {/* Results */}
      {skinResults === null && !calculating && (
        <div style={st.card}>
          <EmptyState
            icon={<Target size={44} strokeWidth={1.75} color="var(--green)" />}
            title="Ready to calculate"
            description="Select an event above and click Run Skin Report to see who won each hole."
          />
        </div>
      )}

      {skinResults !== null && skinResults.length === 0 && (
        <div style={st.card}>
          <EmptyState
            icon={<Inbox size={40} strokeWidth={1.5} />}
            title="No skins scores found"
            description="No scores have been submitted yet by players enrolled in skins for this event."
          />
        </div>
      )}

      {skinResults !== null && skinResults.length > 0 && (
        <>
          {/* Summary banner */}
          <div style={st.summaryCard}>
            <div style={st.summaryRow}>
              <div style={st.summaryItem}>
                <span style={st.summaryNum}>{totalSkins}</span>
                <span style={st.summaryLbl}>Skin{totalSkins !== 1 ? 's' : ''} Won</span>
              </div>
              <div style={st.summaryItem}>
                <span style={st.summaryNum}>{tiedHoles.length}</span>
                <span style={st.summaryLbl}>Tied Hole{tiedHoles.length !== 1 ? 's' : ''}</span>
              </div>
              <div style={st.summaryItem}>
                <span style={st.summaryNum}>{skinsPlayers.length}</span>
                <span style={st.summaryLbl}>Player{skinsPlayers.length !== 1 ? 's' : ''} in Pool</span>
              </div>
            </div>

            {skinLeaders.length > 0 && (
              <div style={st.leaderList}>
                {skinLeaders.map(([name, count], i) => (
                  <div key={name} style={st.leaderRow}>
                    <span style={st.leaderMedal}>{['🥇','🥈','🥉'][i] || `${i+1}.`}</span>
                    <span style={st.leaderName}>{name}</span>
                    <span style={st.leaderCount}>{count} skin{count !== 1 ? 's' : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Hole-by-hole table */}
          <div style={st.card}>
            <div style={st.tableHead}>
              <span style={st.thHole}>Hole</span>
              <span style={st.thPar}>Par</span>
              <span style={{ flex: 1 }}>Result</span>
              <span style={st.thScore}>Score</span>
            </div>

            {skinResults.map(r => {
              const lbl = r.status === 'won' ? scoreLabel(r.score, r.par) : null
              const isWon  = r.status === 'won'
              const isTied = r.status === 'tied'

              return (
                <div
                  key={r.hole}
                  style={{
                    ...st.tableRow,
                    background: isWon ? '#f0fdf4' : isTied ? '#fffbeb' : '#fafafa',
                    borderLeft: `3px solid ${isWon ? 'var(--green)' : isTied ? '#f6c90e' : '#e5e7eb'}`,
                  }}
                >
                  <span style={st.thHole}>
                    <span style={st.holeBadge}>{r.hole}</span>
                  </span>
                  <span style={{ ...st.thPar, color: 'var(--gray-400)', fontSize: '13px' }}>
                    {r.par ?? '—'}
                  </span>
                  <div style={{ flex: 1 }}>
                    {isWon && (
                      <>
                        <div style={st.winnerName}>🏆 {playerName(r.winner)}</div>
                        {r.allEntries && r.allEntries.length > 1 && (
                          <div style={st.otherScores}>
                            {r.allEntries
                              .filter(e => e.playerId !== r.winner?.id)
                              .map(e => `${playerName(e.player)} ${e.score}`)
                              .join(' · ')}
                          </div>
                        )}
                      </>
                    )}
                    {isTied && (
                      <div style={st.tiedLabel}>
                        Tied — No skin
                        <span style={st.tiedCount}>{r.tiedPlayers.length} players tied</span>
                      </div>
                    )}
                    {r.status === 'no_scores' && (
                      <div style={st.noScoreLabel}>Awaiting scores</div>
                    )}
                  </div>
                  <div style={st.thScore}>
                    {r.score != null && (
                      <>
                        <span style={st.scoreNum}>{r.score}</span>
                        {lbl && (
                          <span style={{ ...st.scoreLbl, background: lbl.bg, color: lbl.color }}>
                            {lbl.label}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

const st = {
  page:    { padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '860px' },
  loading: { padding: '60px', textAlign: 'center', color: 'var(--gray-400)' },

  card:    { background: '#fff', borderRadius: 'var(--radius)', padding: '16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  label:   { fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '8px' },
  select:  { width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--gray-100)', color: 'var(--black)' },
  skinsNote: { marginTop: '10px', fontSize: '12px', color: 'var(--gray-500)', lineHeight: '1.5', padding: '8px 12px', background: 'var(--off-white)', borderRadius: '6px' },
  enrollmentList: { maxHeight: 'min(45dvh, 360px)', overflowY: 'auto', WebkitOverflowScrolling: 'touch' },
  enrollmentRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', minHeight: '44px', borderBottom: '1px solid var(--gray-200)', cursor: 'pointer' },
  enrollmentName: { fontSize: '14px', color: 'var(--black)', overflowWrap: 'anywhere', minWidth: 0 },
  enrollmentCheckbox: { width: '18px', height: '18px', margin: '0 2px 0 0', flexShrink: 0, accentColor: 'var(--green-dark)', cursor: 'pointer' },

  // Summary banner
  summaryCard:  { background: 'var(--green-dark)', borderRadius: 'var(--radius)', padding: '20px', boxShadow: 'var(--shadow)' },
  summaryRow:   { display: 'flex', justifyContent: 'space-around', marginBottom: '16px' },
  summaryItem:  { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' },
  summaryNum:   { fontSize: '32px', fontWeight: 800, color: '#fff', lineHeight: 1 },
  summaryLbl:   { fontSize: '11px', color: 'rgba(255,255,255,0.65)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.4px' },
  leaderList:   { borderTop: '1px solid rgba(255,255,255,0.15)', paddingTop: '14px', display: 'flex', flexDirection: 'column', gap: '8px' },
  leaderRow:    { display: 'flex', alignItems: 'center', gap: '10px' },
  leaderMedal:  { fontSize: '18px', width: '28px', textAlign: 'center' },
  leaderName:   { flex: 1, fontSize: '14px', fontWeight: 700, color: '#fff' },
  leaderCount:  { fontSize: '12px', fontWeight: 700, color: '#f6c90e', background: 'rgba(246,201,14,0.15)', padding: '2px 10px', borderRadius: '20px' },

  // Hole table
  tableHead:  { display: 'flex', alignItems: 'center', padding: '8px 12px', background: 'var(--off-white)', borderRadius: '6px', marginBottom: '6px', gap: '10px' },
  tableRow:   { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px', borderRadius: '6px', marginBottom: '4px', transition: 'background 0.15s' },
  thHole:     { width: '44px', flexShrink: 0, fontSize: '11px', fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', textAlign: 'center' },
  thPar:      { width: '36px', flexShrink: 0, textAlign: 'center' },
  thScore:    { width: '100px', flexShrink: 0, textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px' },

  holeBadge:    { width: '28px', height: '28px', borderRadius: '50%', background: 'var(--green-dark)', color: '#fff', fontSize: '12px', fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' },
  winnerName:   { fontSize: '14px', fontWeight: 700, color: 'var(--green-dark)' },
  otherScores:  { fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' },
  tiedLabel:    { fontSize: '13px', fontWeight: 600, color: '#b45309', display: 'flex', alignItems: 'center', gap: '8px' },
  tiedCount:    { fontSize: '11px', fontWeight: 600, color: '#92400e', background: '#fef3c7', padding: '2px 8px', borderRadius: '20px' },
  noScoreLabel: { fontSize: '12px', color: 'var(--gray-400)', fontStyle: 'italic' },
  scoreNum:     { fontSize: '18px', fontWeight: 800, color: 'var(--black)' },
  scoreLbl:     { fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '20px', letterSpacing: '0.2px' },
}

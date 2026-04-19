import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'

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
  const [skinsPlayers, setSkinsPlayers] = useState([])

  useEffect(() => {
    if (!locationId) return
    async function load() {
      const [{ data: evts }, { data: plrs }] = await Promise.all([
        supabase.from('events')
          .select('id, name, week_number, start_date, course_id, status')
          .eq('location_id', locationId)
          .neq('is_bye', true)
          .order('week_number', { ascending: true }),
        supabase.from('players')
          .select('id, name, first_name, last_name, in_skins')
          .eq('location_id', locationId)
          .eq('in_skins', true)
          .order('name'),
      ])
      setEvents(evts || [])
      setSkinsPlayers(plrs || [])
      // Only fall back to local default if parent hasn't provided one
      if (!activeEventId && evts?.length) {
        const open = evts.find(e => e.status === 'open') || evts[0]
        setSelectedEvent(open.id)
        onEventChange(open.id)
      }
      setLoading(false)
    }
    load()
  }, [locationId])

  // Sync when parent changes the active event
  useEffect(() => {
    if (activeEventId && activeEventId !== selectedEvent) {
      setSelectedEvent(activeEventId)
    }
  }, [activeEventId])

  // Reset report when event changes
  useEffect(() => {
    setSkinResults(null)
    if (!selectedEvent) return
    // Load event details (for course par info)
    supabase.from('events').select('*, courses(id, name, hole_pars, total_par)')
      .eq('id', selectedEvent).single()
      .then(({ data }) => setEventDetails(data || null))
  }, [selectedEvent])

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  async function runSkinReport() {
    if (!selectedEvent) return
    setCalculating(true)
    setSkinResults(null)

    // 1. Load all scores for this event
    const { data: allScores, error } = await supabase
      .from('scores')
      .select('player_id, hole_scores, gross_total, net_total')
      .eq('event_id', selectedEvent)
      .eq('location_id', locationId)

    if (error) {
      showToast('Error loading scores: ' + error.message, 'error')
      setCalculating(false)
      return
    }

    // 2. Load all players (for name lookup) + get skins-eligible IDs
    const { data: allPlayers } = await supabase
      .from('players')
      .select('id, name, first_name, last_name, in_skins')
      .eq('location_id', locationId)

    const playerMap = {}
    ;(allPlayers || []).forEach(p => { playerMap[p.id] = p })

    const skinsIds = new Set((allPlayers || []).filter(p => p.in_skins).map(p => p.id))

    // Filter scores to skins-eligible players only
    const skinsScores = (allScores || []).filter(s => skinsIds.has(s.player_id))

    if (skinsScores.length === 0) {
      setSkinResults([])
      setCalculating(false)
      return
    }

    // 3. Get hole pars from the course attached to this event
    let holePars = null
    if (eventDetails?.courses?.hole_pars) {
      holePars = eventDetails.courses.hole_pars
    } else if (eventDetails?.course_id) {
      const { data: course } = await supabase
        .from('courses').select('hole_pars').eq('id', eventDetails.course_id).single()
      holePars = course?.hole_pars || null
    }

    // 4. Calculate skins hole by hole
    const results = []
    for (let h = 0; h < 9; h++) {
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
        results.push({ hole: h + 1, par, status: 'no_scores', participants: skinsScores.length })
        continue
      }

      const minScore = Math.min(...holeEntries.map(e => e.score))
      const winners  = holeEntries.filter(e => e.score === minScore)

      if (winners.length === 1) {
        results.push({
          hole: h + 1,
          par,
          status: 'won',
          winner: winners[0].player,
          score:  minScore,
          allEntries: holeEntries,
        })
      } else {
        results.push({
          hole: h + 1,
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
      {toast && (
        <div style={{ ...st.toast, background: toast.type === 'error' ? '#c53030' : 'var(--green)' }}>
          {toast.msg}
        </div>
      )}

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

        {/* Skins players note */}
        <div style={st.skinsNote}>
          {skinsPlayers.length === 0
            ? '⚠️ No players are marked as "In Skins" — go to Players tab to enroll them.'
            : `🎯 ${skinsPlayers.length} player${skinsPlayers.length !== 1 ? 's' : ''} enrolled in skins: ${skinsPlayers.map(p => p.first_name || p.name).join(', ')}`
          }
        </div>
      </div>

      {/* Run report button */}
      <button
        style={{ ...st.runBtn, opacity: calculating || !selectedEvent ? 0.7 : 1 }}
        onClick={runSkinReport}
        disabled={calculating || !selectedEvent}
      >
        {calculating ? '⏳ Calculating…' : '🎯 Run Skin Report'}
      </button>

      {/* Results */}
      {skinResults === null && !calculating && (
        <div style={st.promptCard}>
          <div style={{ fontSize: '36px', marginBottom: '10px' }}>🎯</div>
          <div style={st.promptTitle}>Ready to calculate</div>
          <div style={st.promptSub}>
            Select an event above and click <strong>Run Skin Report</strong> to see who won each hole.
          </div>
        </div>
      )}

      {skinResults !== null && skinResults.length === 0 && (
        <div style={st.promptCard}>
          <div style={{ fontSize: '36px', marginBottom: '10px' }}>📭</div>
          <div style={st.promptTitle}>No skins scores found</div>
          <div style={st.promptSub}>
            No scores have been submitted yet by players enrolled in skins for this event.
          </div>
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
  toast:   { position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', color: '#fff', padding: '10px 22px', borderRadius: '20px', fontSize: '13px', fontWeight: 600, zIndex: 9999, boxShadow: 'var(--shadow-lg)', whiteSpace: 'nowrap' },

  card:    { background: '#fff', borderRadius: 'var(--radius)', padding: '16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  label:   { fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '8px' },
  select:  { width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--gray-100)', color: 'var(--black)' },
  skinsNote: { marginTop: '10px', fontSize: '12px', color: 'var(--gray-500)', lineHeight: '1.5', padding: '8px 12px', background: 'var(--off-white)', borderRadius: '6px' },

  runBtn:  { width: '100%', padding: '16px', background: 'var(--green-dark)', color: '#fff', borderRadius: 'var(--radius-sm)', fontSize: '15px', fontWeight: 800, cursor: 'pointer', letterSpacing: '0.2px', boxShadow: '0 2px 8px rgba(45,106,79,0.25)', transition: 'opacity 0.2s' },

  promptCard:  { background: '#fff', borderRadius: 'var(--radius)', padding: '48px 24px', textAlign: 'center', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  promptTitle: { fontSize: '17px', fontWeight: 700, color: 'var(--green-dark)', marginBottom: '8px' },
  promptSub:   { fontSize: '14px', color: 'var(--gray-400)', lineHeight: '1.6' },

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

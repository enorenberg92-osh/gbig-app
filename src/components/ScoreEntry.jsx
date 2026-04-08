import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import HoleEventAnimation from './HoleEventAnimation'

/**
 * ScoreEntry
 *
 * Player-facing, hole-by-hole score entry for both teammates.
 * One player on the team enters scores for both players.
 *
 * Props:
 *   session   {object}  - Supabase auth session
 *   onBack    {func}    - returns to LeagueDashboard
 */
export default function ScoreEntry({ session, onBack }) {
  const [loading, setLoading]           = useState(true)
  const [team, setTeam]                 = useState(null)       // { id, player1, player2 }
  const [event, setEvent]               = useState(null)       // current open event
  const [course, setCourse]             = useState(null)       // course with hole_pars
  const [currentHole, setCurrentHole]  = useState(0)          // 0-indexed (0 = hole 1)
  const [scores, setScores]             = useState({})         // { p1: [null×9], p2: [null×9] }
  const [showHoleEvent, setShowHoleEvent] = useState(false)
  const [alreadySubmitted, setAlreadySubmitted] = useState(false)
  const [saving, setSaving]             = useState(false)
  const [toast, setToast]               = useState(null)
  const [error, setError]               = useState(null)

  const NUM_HOLES = 9

  useEffect(() => { init() }, [])

  async function init() {
    try {
      // 1. Find this player's record
      const { data: playerRow, error: pErr } = await supabase
        .from('players')
        .select('id, name')
        .eq('user_id', session.user.id)
        .single()

      if (pErr || !playerRow) { setError('No player record found for your account. Ask your admin.'); setLoading(false); return }

      // 2. Find their team (load players separately to avoid FK join issues)
      const { data: teamRow, error: tErr } = await supabase
        .from('teams')
        .select('id, player1_id, player2_id')
        .or(`player1_id.eq.${playerRow.id},player2_id.eq.${playerRow.id}`)
        .single()

      if (tErr || !teamRow) { setError('No team found for your account. Ask your admin.'); setLoading(false); return }

      // Load both players independently
      const { data: teamPlayers } = await supabase
        .from('players')
        .select('id, name, handicap')
        .in('id', [teamRow.player1_id, teamRow.player2_id].filter(Boolean))

      const playerById = {}
      ;(teamPlayers || []).forEach(p => { playerById[p.id] = p })

      const hydratedTeam = {
        ...teamRow,
        p1: playerById[teamRow.player1_id] || null,
        p2: playerById[teamRow.player2_id] || null,
      }
      setTeam(hydratedTeam)

      // 3. Find the current open event that falls within this calendar week
      const today = new Date().toISOString().split('T')[0]
      const { data: evtRow } = await supabase
        .from('events')
        .select('*')
        .eq('status', 'open')
        .lte('start_date', today)
        .gte('end_date', today)
        .limit(1)
        .single()

      if (!evtRow) { setError('No open event this week. Check back soon!'); setLoading(false); return }
      setEvent(evtRow)

      // Load course separately to avoid FK join issues
      if (evtRow.course_id) {
        const { data: courseRow } = await supabase
          .from('courses')
          .select('id, name, hole_pars, total_par, start_hole')
          .eq('id', evtRow.course_id)
          .single()
        if (courseRow) setCourse(courseRow)
      }

      // 4. Check if already submitted
      const { data: existing } = await supabase
        .from('scores')
        .select('id')
        .eq('event_id', evtRow.id)
        .eq('player_id', teamRow.p1.id)

      if (existing && existing.length > 0) { setAlreadySubmitted(true); setLoading(false); return }

      // 5. Initialize blank scores
      setScores({
        p1: Array(NUM_HOLES).fill(null),
        p2: Array(NUM_HOLES).fill(null),
      })

      setLoading(false)
    } catch (e) {
      setError('Something went wrong. Try again.')
      setLoading(false)
    }
  }

  // When we land on a hole, check if it's the hole event hole
  useEffect(() => {
    if (!event || !event.hole_event_hole) return
    // hole_event_hole is 1-indexed, currentHole is 0-indexed
    if (currentHole + 1 === event.hole_event_hole) {
      setShowHoleEvent(true)
    }
  }, [currentHole, event])

  function setScore(player, holeIdx, value) {
    const num = value === '' ? null : Math.max(1, Math.min(20, parseInt(value, 10) || 0))
    setScores(prev => ({
      ...prev,
      [player]: prev[player].map((s, i) => i === holeIdx ? num : s),
    }))
  }

  function handleIncrement(player, holeIdx, delta) {
    setScores(prev => {
      const current = prev[player][holeIdx] ?? (getPar(holeIdx) || 4)
      const next = Math.max(1, Math.min(20, current + delta))
      return {
        ...prev,
        [player]: prev[player].map((s, i) => i === holeIdx ? next : s),
      }
    })
  }

  function getPar(holeIdx) {
    if (!course?.hole_pars || !Array.isArray(course.hole_pars)) return null
    return course.hole_pars[holeIdx] ?? null
  }

  function scoreColor(score, par) {
    if (!score || !par) return 'var(--black)'
    const diff = score - par
    if (diff <= -2) return '#b8860b'   // eagle or better — gold
    if (diff === -1) return '#dc2626'  // birdie — red
    if (diff === 0)  return '#16a34a'  // par — green
    return 'var(--black)'              // bogey or worse — black
  }

  function scoreBg(score, par) {
    if (!score || !par) return 'transparent'
    const diff = score - par
    if (diff <= -2) return '#fef9c3'   // eagle — light gold
    if (diff === -1) return '#fee2e2'  // birdie — light red
    if (diff === 0)  return '#dcfce7'  // par — light green
    return 'transparent'               // bogey+ — no background
  }

  function canAdvance() {
    return scores.p1[currentHole] != null && scores.p2[currentHole] != null
  }

  function goNext() {
    if (currentHole < NUM_HOLES - 1) setCurrentHole(h => h + 1)
  }

  function goPrev() {
    if (currentHole > 0) setCurrentHole(h => h - 1)
  }

  function totalScore(player) {
    if (!scores[player] || !Array.isArray(scores[player])) return 0
    return scores[player].reduce((sum, s) => sum + (s || 0), 0)
  }

  function totalPar() {
    if (!course?.hole_pars) return null
    return course.hole_pars.slice(0, NUM_HOLES).reduce((a, b) => a + b, 0)
  }

  function vsPar(player) {
    const gross = totalScore(player)
    const par = totalPar()
    if (!par || !gross) return null
    return gross - par
  }

  function vsParLabel(diff) {
    if (diff === null) return ''
    if (diff === 0) return 'E'
    return diff > 0 ? `+${diff}` : `${diff}`
  }

  async function handleSubmit() {
    const allFilled = scores.p1.every(s => s != null) && scores.p2.every(s => s != null)
    if (!allFilled) {
      showToast('Please enter scores for all 9 holes before submitting.', 'error')
      return
    }

    setSaving(true)

    const coursePar = course?.total_par ?? 36

    const p1Gross = totalScore('p1')
    const p2Gross = totalScore('p2')
    const p1Hcp = Math.round(team.p1.handicap ?? 0)
    const p2Hcp = Math.round(team.p2.handicap ?? 0)

    const rows = [
      {
        event_id:      event.id,
        player_id:     team.p1.id,
        hole_scores:   scores.p1,
        gross_total:   p1Gross,
        net_total:     p1Gross - p1Hcp,
        handicap_used: p1Hcp,
      },
      {
        event_id:      event.id,
        player_id:     team.p2.id,
        hole_scores:   scores.p2,
        gross_total:   p2Gross,
        net_total:     p2Gross - p2Hcp,
        handicap_used: p2Hcp,
      },
    ]

    const { error: insertErr } = await supabase.from('scores').insert(rows)

    if (insertErr) {
      showToast('Error saving scores: ' + insertErr.message, 'error')
      setSaving(false)
      return
    }

    setSaving(false)
    setAlreadySubmitted(true)
    showToast('Scores submitted! Great round! 🏌️')
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  // ─── Render states ────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={styles.centered}>
        <div style={styles.spinner}>⛳</div>
        <p style={styles.loadingText}>Loading your round…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={styles.centered}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>😕</div>
        <p style={styles.errorText}>{error}</p>
        <button style={styles.backBtn} onClick={onBack}>← Back</button>
      </div>
    )
  }

  if (alreadySubmitted) {
    const hasScores = Array.isArray(scores.p1) && scores.p1.some(s => s != null)
    const p1v = hasScores ? vsPar('p1') : null
    const p2v = hasScores ? vsPar('p2') : null
    return (
      <div style={styles.doneWrap}>
        <div style={styles.doneCard}>
          <div style={styles.doneEmoji}>🏌️</div>
          <h2 style={styles.doneTitle}>
            {hasScores ? 'Scores Submitted!' : 'Already Submitted'}
          </h2>
          <p style={styles.doneSub}>
            {hasScores
              ? `Nice round, ${team?.p1?.name?.split(' ')[0]}!`
              : `Your team already entered scores for this week's round.`}
          </p>
          {hasScores && (
            <div style={styles.doneSummary}>
              <div style={styles.doneSummaryRow}>
                <span>{team?.p1?.name}</span>
                <span style={{ fontWeight: 700 }}>
                  {totalScore('p1')}
                  {p1v !== null && (
                    <span style={{ color: p1v <= 0 ? 'var(--green)' : '#c53030', marginLeft: 4 }}>
                      ({vsParLabel(p1v)})
                    </span>
                  )}
                </span>
              </div>
              <div style={styles.doneSummaryRow}>
                <span>{team?.p2?.name}</span>
                <span style={{ fontWeight: 700 }}>
                  {totalScore('p2')}
                  {p2v !== null && (
                    <span style={{ color: p2v <= 0 ? 'var(--green)' : '#c53030', marginLeft: 4 }}>
                      ({vsParLabel(p2v)})
                    </span>
                  )}
                </span>
              </div>
            </div>
          )}
          <button style={styles.backBtn2} onClick={onBack}>← Back to League</button>
        </div>
      </div>
    )
  }

  // ─── Main hole-by-hole UI ─────────────────────────────────────────

  const hole = currentHole + 1  // display number (1-indexed)
  const par = getPar(currentHole)
  const isLastHole = currentHole === NUM_HOLES - 1
  const allDone = scores.p1.every(s => s != null) && scores.p2.every(s => s != null)

  return (
    <div style={styles.container}>
      {/* Hole event overlay */}
      {showHoleEvent && event?.hole_event_name && (
        <HoleEventAnimation
          holeName={event.hole_event_name}
          holeNum={event.hole_event_hole}
          onDismiss={() => setShowHoleEvent(false)}
        />
      )}

      {/* Toast */}
      {toast && (
        <div style={{ ...styles.toast, background: toast.type === 'error' ? '#c53030' : 'var(--green)' }}>
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div style={styles.header}>
        <button style={styles.headerBack} onClick={onBack}>← Back</button>
        <div style={styles.headerCenter}>
          <div style={styles.headerEventName}>{event?.name || 'Score Entry'}</div>
        </div>
        <div style={{ width: 52 }} />
      </div>

      {/* Progress dots */}
      <div style={styles.progressRow}>
        {Array.from({ length: NUM_HOLES }, (_, i) => {
          const done = scores.p1[i] != null && scores.p2[i] != null
          const active = i === currentHole
          return (
            <button
              key={i}
              onClick={() => setCurrentHole(i)}
              style={{
                ...styles.dot,
                background: active ? 'var(--green)' : done ? '#a8d5b5' : 'var(--gray-200)',
                transform: active ? 'scale(1.3)' : 'scale(1)',
              }}
            />
          )
        })}
      </div>

      {/* Hole card */}
      <div style={styles.holeCard}>
        <div style={styles.holeBadgeRow}>
          <div style={styles.holeBadge}>
            <span style={styles.holeBadgeNum}>HOLE {hole}</span>
            {par && <span style={styles.holeBadgePar}>Par {par}</span>}
          </div>
          {event?.hole_event_hole === hole && event?.hole_event_name && (
            <button style={styles.holeEventChip} onClick={() => setShowHoleEvent(true)}>
              🎯 {event.hole_event_name}
            </button>
          )}
        </div>

        {/* Score inputs for each player */}
        {['p1', 'p2'].map(pk => {
          const player = team[pk]
          const s = scores[pk][currentHole]
          const diff = s != null && par ? s - par : null

          return (
            <div key={pk} style={styles.playerRow}>
              <div style={styles.playerInfo}>
                <div style={styles.playerName}>{player.name}</div>
                <div style={styles.playerHcp}>Hcp {player.handicap ?? '—'}</div>
              </div>
              <div style={styles.scoreControls}>
                <button
                  style={styles.stepBtn}
                  onClick={() => handleIncrement(pk, currentHole, -1)}
                >
                  −
                </button>
                <div style={{
                  ...styles.scoreBox,
                  background: scoreBg(s, par),
                  color: scoreColor(s, par),
                  border: `2px solid ${scoreColor(s, par) === 'var(--black)' ? 'var(--gray-200)' : scoreColor(s, par)}`,
                }}>
                  <span style={styles.scoreNum}>{s ?? '—'}</span>
                  {diff !== null && (
                    <span style={{ ...styles.diffLabel, color: scoreColor(s, par) }}>
                      {diff === 0 ? 'E' : diff > 0 ? `+${diff}` : `${diff}`}
                    </span>
                  )}
                </div>
                <button
                  style={styles.stepBtn}
                  onClick={() => handleIncrement(pk, currentHole, 1)}
                >
                  +
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* Running totals */}
      <div style={styles.totalsCard}>
        <div style={styles.totalsTitle}>Running Total</div>
        {['p1', 'p2'].map(pk => {
          const gross = totalScore(pk)
          const filled = scores[pk].filter(s => s != null).length
          const par_so_far = course?.hole_pars
            ? course.hole_pars.slice(0, filled).reduce((a, b) => a + b, 0)
            : null
          const diff = par_so_far ? gross - par_so_far : null
          return (
            <div key={pk} style={styles.totalsRow}>
              <span style={styles.totalsName}>{team[pk].name}</span>
              <span style={styles.totalsScore}>
                {gross > 0 ? gross : '—'}
                {diff !== null && gross > 0 && (
                  <span style={{ color: diff <= 0 ? 'var(--green)' : '#c53030', marginLeft: 6, fontSize: 11 }}>
                    ({vsParLabel(diff)})
                  </span>
                )}
              </span>
            </div>
          )
        })}
      </div>

      {/* Navigation */}
      <div style={styles.navRow}>
        <button
          style={{ ...styles.navBtn, opacity: currentHole === 0 ? 0.3 : 1 }}
          onClick={goPrev}
          disabled={currentHole === 0}
        >
          ← Hole {hole - 1}
        </button>

        {!isLastHole ? (
          <button
            style={{ ...styles.nextBtn, opacity: canAdvance() ? 1 : 0.5 }}
            onClick={goNext}
          >
            Hole {hole + 1} →
          </button>
        ) : (
          <button
            style={{ ...styles.submitBtn, opacity: allDone ? 1 : 0.5 }}
            onClick={handleSubmit}
            disabled={saving || !allDone}
          >
            {saving ? 'Saving…' : '✓ Submit Scores'}
          </button>
        )}
      </div>

      {/* Scorecard summary — visible from hole 2 onward */}
      {currentHole > 0 && (
        <div style={styles.scorecardWrap}>
          <div style={styles.scorecardTitle}>Scorecard</div>
          <div style={styles.scorecardGrid}>
            {/* Header row */}
            <div style={styles.scHdr}></div>
            {Array.from({ length: NUM_HOLES }, (_, i) => (
              <div key={i} style={{ ...styles.scHdr, ...(i === currentHole ? { color: 'var(--green)', fontWeight: 700 } : {}) }}>
                {i + 1}
              </div>
            ))}
            <div style={styles.scHdr}>TOT</div>

            {/* Par row */}
            <div style={styles.scLabel}>Par</div>
            {Array.from({ length: NUM_HOLES }, (_, i) => (
              <div key={i} style={styles.scPar}>{getPar(i) ?? '—'}</div>
            ))}
            <div style={styles.scPar}>{totalPar() ?? '—'}</div>

            {/* Player rows */}
            {['p1', 'p2'].map(pk => (
              <React.Fragment key={pk}>
                <div style={styles.scLabel}>{team[pk].name.split(' ')[0]}</div>
                {scores[pk].map((s, i) => {
                  const p = getPar(i)
                  return (
                    <div key={i} style={{
                      ...styles.scScore,
                      background: scoreBg(s, p),
                      color: scoreColor(s, p),
                      fontWeight: s != null ? 700 : 400,
                      border: s != null ? `1px solid ${scoreColor(s, p) === 'var(--black)' ? 'transparent' : scoreColor(s, p)}` : 'none',
                    }}>
                      {s ?? '·'}
                    </div>
                  )
                })}
                <div style={{ ...styles.scScore, fontWeight: 700 }}>
                  {totalScore(pk) > 0 ? totalScore(pk) : '—'}
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--off-white)', overflowY: 'auto' },
  centered: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 24, textAlign: 'center', gap: 12 },
  spinner: { fontSize: 48, animation: 'spin 2s linear infinite' },
  loadingText: { color: 'var(--gray-400)', fontSize: 14 },
  errorText: { color: 'var(--gray-600)', fontSize: 15, lineHeight: 1.5, maxWidth: 280 },

  // Header
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--green-dark)', color: 'var(--white)', flexShrink: 0 },
  headerBack: { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: 500, width: 52 },
  headerCenter: { flex: 1, textAlign: 'center' },
  headerEventName: { fontSize: 14, fontWeight: 700, color: 'var(--white)' },

  // Progress dots
  progressRow: { display: 'flex', gap: 6, justifyContent: 'center', padding: '12px 16px', background: 'var(--white)', borderBottom: '1px solid var(--gray-200)', flexShrink: 0 },
  dot: { width: 10, height: 10, borderRadius: '50%', transition: 'all 0.2s ease', border: 'none', cursor: 'pointer', padding: 0 },

  // Hole card
  holeCard: { margin: '16px 16px 0', background: 'var(--white)', borderRadius: 'var(--radius)', padding: '18px 16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)', display: 'flex', flexDirection: 'column', gap: 16 },
  holeBadgeRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  holeBadge: { display: 'flex', flexDirection: 'column', gap: 2 },
  holeBadgeNum: { fontSize: 22, fontWeight: 800, color: 'var(--green-dark)', letterSpacing: '-0.3px' },
  holeBadgePar: { fontSize: 12, color: 'var(--gray-400)', fontWeight: 500 },
  holeEventChip: { fontSize: 11, fontWeight: 700, color: 'var(--green-dark)', background: 'var(--green-xlight)', border: '1px solid var(--green)', padding: '4px 10px', borderRadius: 20 },

  // Player score row
  playerRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderTop: '1px solid var(--gray-100)' },
  playerInfo: { flex: 1 },
  playerName: { fontSize: 15, fontWeight: 700, color: 'var(--black)' },
  playerHcp: { fontSize: 11, color: 'var(--gray-400)', marginTop: 2 },
  scoreControls: { display: 'flex', alignItems: 'center', gap: 10 },
  stepBtn: { width: 42, height: 42, borderRadius: '50%', background: 'var(--gray-100)', color: 'var(--black)', fontSize: 22, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px solid var(--gray-200)', flexShrink: 0 },
  scoreBox: { width: 60, height: 60, borderRadius: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--gray-200)', transition: 'all 0.15s' },
  scoreNum: { fontSize: 26, fontWeight: 800, lineHeight: 1 },
  diffLabel: { fontSize: 10, fontWeight: 700, marginTop: 1 },

  // Totals
  totalsCard: { margin: '10px 16px 0', background: 'var(--white)', borderRadius: 'var(--radius)', padding: '12px 16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  totalsTitle: { fontSize: 10, fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 },
  totalsRow: { display: 'flex', justifyContent: 'space-between', padding: '4px 0' },
  totalsName: { fontSize: 13, color: 'var(--black)' },
  totalsScore: { fontSize: 14, fontWeight: 700, color: 'var(--black)' },

  // Nav
  navRow: { display: 'flex', gap: 10, padding: '14px 16px', flexShrink: 0 },
  navBtn: { flex: 1, padding: '12px', background: 'var(--white)', border: '1.5px solid var(--gray-200)', borderRadius: 'var(--radius-sm)', fontSize: 14, fontWeight: 600, color: 'var(--gray-600)' },
  nextBtn: { flex: 2, padding: '14px', background: 'var(--green)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: 15, fontWeight: 700, boxShadow: '0 2px 8px rgba(45,106,79,0.3)' },
  submitBtn: { flex: 2, padding: '14px', background: 'var(--green-dark)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: 15, fontWeight: 700, boxShadow: '0 2px 8px rgba(45,106,79,0.4)' },

  // Scorecard
  scorecardWrap: { margin: '0 16px 24px', background: 'var(--white)', borderRadius: 'var(--radius)', padding: '14px 12px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)', overflowX: 'auto' },
  scorecardTitle: { fontSize: 10, fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 10 },
  scorecardGrid: { display: 'grid', gridTemplateColumns: '50px repeat(9, 1fr) 36px', gap: 2, minWidth: 320 },
  scHdr: { fontSize: 10, fontWeight: 600, color: 'var(--gray-400)', textAlign: 'center', padding: '3px 0' },
  scLabel: { fontSize: 10, fontWeight: 700, color: 'var(--black)', display: 'flex', alignItems: 'center', paddingRight: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  scPar: { fontSize: 11, color: 'var(--gray-400)', textAlign: 'center', padding: '3px 0' },
  scScore: { fontSize: 12, textAlign: 'center', padding: '4px 2px', borderRadius: 4 },

  // Done screen
  doneWrap: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 24, background: 'var(--off-white)' },
  doneCard: { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '32px 24px', boxShadow: 'var(--shadow-lg)', textAlign: 'center', width: '100%', maxWidth: 360 },
  doneEmoji: { fontSize: 52, marginBottom: 12 },
  doneTitle: { fontSize: 24, fontWeight: 800, color: 'var(--green-dark)', marginBottom: 6 },
  doneSub: { fontSize: 15, color: 'var(--gray-400)', marginBottom: 24 },
  doneSummary: { background: 'var(--off-white)', borderRadius: 'var(--radius-sm)', padding: '14px 16px', marginBottom: 24, display: 'flex', flexDirection: 'column', gap: 10 },
  doneSummaryRow: { display: 'flex', justifyContent: 'space-between', fontSize: 14 },
  backBtn: { marginTop: 8, padding: '10px 24px', background: 'var(--green)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: 14, fontWeight: 700 },
  backBtn2: { width: '100%', padding: '13px', background: 'var(--green)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: 15, fontWeight: 700 },
  toast: { position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', color: 'white', padding: '10px 20px', borderRadius: 20, fontSize: 13, fontWeight: 600, zIndex: 9999, boxShadow: 'var(--shadow-lg)', whiteSpace: 'nowrap' },
}

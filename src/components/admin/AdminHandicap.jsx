import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { DEFAULT_SETTINGS, calcHandicap, calcBreakdown } from '../../lib/handicapCalc'
import { useLocation } from '../../context/LocationContext'

// ── Component ────────────────────────────────────────────────────────────────
export default function AdminHandicap() {
  const { locationId } = useLocation()
  const [players,      setPlayers]      = useState([])
  const [scoreHistory, setScoreHistory] = useState({}) // { playerId: [{eventName, date, gross, par, diff}] }
  const [settings,     setSettings]     = useState(DEFAULT_SETTINGS)
  const [loading,      setLoading]      = useState(true)
  const [updating,     setUpdating]     = useState(false)
  const [expanded,     setExpanded]     = useState({}) // { playerId: bool }
  const [toast,        setToast]        = useState(null)

  useEffect(() => { if (locationId) loadAll() }, [locationId])

  async function loadAll() {
    setLoading(true)

    const [{ data: plrs }, { data: scores }, { data: leagueCfg }] = await Promise.all([
      supabase.from('players').select('*').eq('location_id', locationId).order('name'),
      supabase
        .from('scores')
        .select('player_id, gross_total, created_at, events(id, name, start_date, event_date, week_number, courses(name, hole_pars))')
        .eq('location_id', locationId)
        .order('created_at', { ascending: true }),
      supabase.from('league_config').select('num_weeks').eq('location_id', locationId).limit(1).single(),
    ])

    // Merge league num_weeks into settings
    if (leagueCfg?.num_weeks) {
      setSettings(s => ({ ...s, scoresUsed: leagueCfg.num_weeks }))
    }

    // Build score history per player
    const history = {}
    ;(scores || []).forEach(s => {
      const pid = s.player_id
      if (!history[pid]) history[pid] = []
      const holePars  = s.events?.courses?.hole_pars
      const coursePar = holePars ? holePars.reduce((sum, p) => sum + p, 0) : null
      const diff      = coursePar != null && s.gross_total != null
        ? s.gross_total - coursePar
        : null
      history[pid].push({
        eventName: s.events?.name || 'Unknown Event',
        courseName: s.events?.courses?.name || null,
        date:  s.events?.start_date || s.events?.event_date || null,
        gross: s.gross_total,
        par:   coursePar,
        diff,
      })
    })

    setPlayers(plrs  || [])
    setScoreHistory(history)
    setLoading(false)
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  async function handleRecalcAll() {
    setUpdating(true)

    // Compute all new handicaps in memory first (no DB calls yet)
    const toUpdate = players
      .filter(p => !p.handicap_locked)
      .map(p => {
        const diffs  = (scoreHistory[p.id] || []).filter(r => r.diff != null).map(r => r.diff)
        const newHcp = calcHandicap(diffs, settings)
        // Only queue a write if the value actually changed
        return (newHcp != null && newHcp !== p.handicap) ? { id: p.id, newHcp } : null
      })
      .filter(Boolean)

    // Fire all DB updates in parallel instead of one-by-one
    const results = await Promise.all(
      toUpdate.map(({ id, newHcp }) =>
        supabase.from('players').update({ handicap: newHcp }).eq('id', id)
      )
    )
    const updated = results.filter(r => !r.error).length
    const errors  = results.filter(r =>  r.error).length

    setUpdating(false)
    showToast(
      errors
        ? `Updated ${updated} player(s) — ${errors} error(s).`
        : `✓ ${updated} handicap${updated !== 1 ? 's' : ''} updated!`,
      errors ? 'error' : 'success'
    )
    loadAll()
  }

  function toggleExpand(id) {
    setExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }

  function formatDate(d) {
    if (!d) return ''
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
  }

  if (loading) return <div style={styles.loading}>Loading handicaps…</div>

  const playersWithScores    = players.filter(p => (scoreHistory[p.id] || []).some(r => r.diff != null))
  const playersWithoutScores = players.filter(p => !(scoreHistory[p.id] || []).some(r => r.diff != null))

  return (
    <div style={styles.container}>
      {toast && (
        <div style={{ ...styles.toast, background: toast.type === 'error' ? '#c53030' : 'var(--green)' }}>
          {toast.msg}
        </div>
      )}

      {/* Settings Summary */}
      <div style={styles.settingsCard}>
        <h3 style={styles.settingsTitle}>⚙️ Handicap Rules</h3>
        <div style={styles.settingsGrid}>
          <div style={styles.settingItem}>
            <span style={styles.settingLabel}>Handicap %</span>
            <span style={styles.settingValue}>90%</span>
          </div>
          <div style={styles.settingItem}>
            <span style={styles.settingLabel}>Scores Used</span>
            <span style={styles.settingValue}>{settings.scoresUsed} (most recent)</span>
          </div>
          <div style={styles.settingItem}>
            <span style={styles.settingLabel}>Min Scores</span>
            <span style={styles.settingValue}>1</span>
          </div>
          <div style={styles.settingItem}>
            <span style={styles.settingLabel}>Max Handicap</span>
            <span style={styles.settingValue}>27</span>
          </div>
          <div style={styles.settingItem}>
            <span style={styles.settingLabel}>Rounding</span>
            <span style={styles.settingValue}>Truncate</span>
          </div>
          <div style={styles.settingItem}>
            <span style={styles.settingLabel}>Discards (4+ scores)</span>
            <span style={styles.settingValue}>1 high · 1 low</span>
          </div>
        </div>
        <div style={styles.formulaNote}>
          Differential = Gross Score − Course Par &nbsp;·&nbsp; Handicap = avg(used diffs) × 90% → truncate
        </div>
      </div>

      {/* Recalculate Button */}
      <button
        style={{ ...styles.recalcBtn, opacity: updating ? 0.7 : 1 }}
        onClick={handleRecalcAll}
        disabled={updating}
      >
        {updating ? 'Updating…' : '🔄 Recalculate & Update All Handicaps'}
      </button>

      {/* Players With Scores */}
      {playersWithScores.length > 0 && (
        <>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>Players with Score History</span>
            <span style={styles.countPill}>{playersWithScores.length}</span>
          </div>

          {playersWithScores.map(player => {
            const rounds      = (scoreHistory[player.id] || []).filter(r => r.diff != null)
            const diffs       = rounds.map(r => r.diff)
            const breakdown   = calcBreakdown(diffs, settings)
            const newHcp      = breakdown?.capped
            const currentHcp  = player.handicap
            const changed     = newHcp != null && newHcp !== currentHcp
            const isOpen      = !!expanded[player.id]

            return (
              <div key={player.id} style={styles.playerCard}>
                {/* Player Header */}
                <div style={styles.playerHeader} onClick={() => toggleExpand(player.id)}>
                  <div style={styles.playerAvatar}>
                    {(player.name || '?')[0].toUpperCase()}
                  </div>
                  <div style={styles.playerInfo}>
                    <div style={styles.playerName}>
                      {player.name}
                      {player.handicap_locked && (
                        <span style={styles.lockedBadge}>🔒 Locked</span>
                      )}
                    </div>
                    <div style={styles.playerMeta}>{rounds.length} round{rounds.length !== 1 ? 's' : ''} on record</div>
                  </div>
                  <div style={styles.hcpPair}>
                    <div style={styles.hcpBox}>
                      <span style={styles.hcpLabel}>Handicap</span>
                      <span style={styles.hcpVal}>{currentHcp ?? '—'}</span>
                    </div>
                    {!player.handicap_locked && <>
                      <div style={styles.hcpArrow}>→</div>
                      <div style={{ ...styles.hcpBox, background: changed ? (newHcp < currentHcp ? '#f0fff4' : '#fff5f5') : 'var(--green-xlight)' }}>
                        <span style={styles.hcpLabel}>Calculated</span>
                        <span style={{ ...styles.hcpVal, color: changed ? (newHcp < currentHcp ? 'var(--green)' : '#c53030') : 'var(--green-dark)' }}>
                          {newHcp ?? '—'}
                        </span>
                      </div>
                    </>}
                    {player.handicap_locked && (
                      <div style={styles.lockedNote}>Admin locked — won't change on recalculate</div>
                    )}
                  </div>
                  {!player.handicap_locked && <span style={styles.chevron}>{isOpen ? '▲' : '▼'}</span>}
                </div>

                {/* Expanded Breakdown — hidden for locked players */}
                {isOpen && breakdown && !player.handicap_locked && (
                  <div style={styles.breakdown}>
                    {/* Score History Table */}
                    <div style={styles.breakdownTitle}>Score History (chronological)</div>
                    <div style={styles.tableWrap}>
                      <table style={styles.table}>
                        <thead>
                          <tr>
                            <th style={styles.th}>Event</th>
                            <th style={styles.th}>Date</th>
                            <th style={styles.thNum}>Gross</th>
                            <th style={styles.thNum}>Par</th>
                            <th style={styles.thNum}>Diff</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rounds.map((r, i) => (
                            <tr key={i} style={i % 2 === 0 ? styles.rowEven : {}}>
                              <td style={styles.td}>{r.eventName}{r.courseName ? ` · ${r.courseName}` : ''}</td>
                              <td style={styles.td}>{formatDate(r.date)}</td>
                              <td style={styles.tdNum}>{r.gross}</td>
                              <td style={styles.tdNum}>{r.par}</td>
                              <td style={{ ...styles.tdNum, color: r.diff > 0 ? '#c53030' : r.diff < 0 ? 'var(--green)' : 'var(--black)', fontWeight: 600 }}>
                                {r.diff > 0 ? `+${r.diff}` : r.diff}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* Calculation Steps */}
                    <div style={styles.calcSteps}>
                      <div style={styles.calcTitle}>Calculation (using {breakdown.n} score{breakdown.n !== 1 ? 's' : ''})</div>
                      <div style={styles.calcRow}>
                        <span style={styles.calcLabel}>Sorted diffs</span>
                        <span style={styles.calcVal}>
                          {breakdown.sorted.map((d, i) => {
                            const isDiscardedLow  = i < breakdown.rule.low
                            const isDiscardedHigh = i >= breakdown.sorted.length - breakdown.rule.high && breakdown.rule.high > 0
                            const color = isDiscardedLow || isDiscardedHigh ? 'var(--gray-300)' : 'var(--black)'
                            const textDecoration = isDiscardedLow || isDiscardedHigh ? 'line-through' : 'none'
                            return (
                              <span key={i} style={{ marginRight: 6, color, textDecoration, fontSize: 12 }}>
                                {d > 0 ? `+${d}` : d}
                                {isDiscardedLow  ? '↓' : ''}
                                {isDiscardedHigh ? '↑' : ''}
                              </span>
                            )
                          })}
                        </span>
                      </div>
                      <div style={styles.calcRow}>
                        <span style={styles.calcLabel}>Used diffs</span>
                        <span style={styles.calcVal}>[{breakdown.used.map(d => d > 0 ? `+${d}` : d).join(', ')}]</span>
                      </div>
                      <div style={styles.calcRow}>
                        <span style={styles.calcLabel}>Average</span>
                        <span style={styles.calcVal}>{breakdown.avg.toFixed(3)}</span>
                      </div>
                      <div style={styles.calcRow}>
                        <span style={styles.calcLabel}>× 90%</span>
                        <span style={styles.calcVal}>{breakdown.raw.toFixed(3)}</span>
                      </div>
                      <div style={styles.calcRow}>
                        <span style={styles.calcLabel}>Truncate</span>
                        <span style={styles.calcVal}>{Math.floor(breakdown.raw)}</span>
                      </div>
                      {Math.floor(breakdown.raw) !== breakdown.capped && (
                        <div style={styles.calcRow}>
                          <span style={styles.calcLabel}>Capped at {SETTINGS.maxHandicap}</span>
                          <span style={styles.calcVal}>{breakdown.capped}</span>
                        </div>
                      )}
                      <div style={{ ...styles.calcRow, borderTop: '1px solid var(--gray-200)', marginTop: 4, paddingTop: 6 }}>
                        <span style={{ ...styles.calcLabel, fontWeight: 700, color: 'var(--green-dark)' }}>New Handicap</span>
                        <span style={{ ...styles.calcVal, fontWeight: 800, fontSize: 18, color: 'var(--green-dark)' }}>{breakdown.capped}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </>
      )}

      {/* Players Without Scores */}
      {playersWithoutScores.length > 0 && (
        <>
          <div style={styles.sectionHeader}>
            <span style={styles.sectionTitle}>No Score History</span>
            <span style={{ ...styles.countPill, background: '#fff8e1', color: '#7a5c00' }}>{playersWithoutScores.length}</span>
          </div>
          <div style={styles.card}>
            {playersWithoutScores.map(player => (
              <div key={player.id} style={styles.noScoreRow}>
                <div style={styles.noScoreAvatar}>{(player.name || '?')[0].toUpperCase()}</div>
                <div style={styles.playerInfo}>
                  <div style={styles.playerName}>{player.name}</div>
                  <div style={styles.playerMeta}>No rounds recorded — handicap unchanged ({player.handicap ?? 'not set'})</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {players.length === 0 && (
        <div style={styles.empty}>No players found. Add players in the Players tab first.</div>
      )}
    </div>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = {
  container:    { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  loading:      { padding: '40px', textAlign: 'center', color: 'var(--gray-400)' },
  toast:        { position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', color: 'white', padding: '10px 20px', borderRadius: '20px', fontSize: '13px', fontWeight: 600, zIndex: 9999, boxShadow: 'var(--shadow-lg)', whiteSpace: 'nowrap' },

  settingsCard:  { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '14px 16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  settingsTitle: { fontSize: '13px', fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '10px' },
  settingsGrid:  { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px', marginBottom: '10px' },
  settingItem:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  settingLabel:  { fontSize: '12px', color: 'var(--gray-500)' },
  settingValue:  { fontSize: '12px', fontWeight: 700, color: 'var(--green-dark)' },
  formulaNote:   { fontSize: '11px', color: 'var(--gray-400)', borderTop: '1px solid var(--gray-100)', paddingTop: '8px', marginTop: '4px' },

  recalcBtn: { width: '100%', padding: '13px', background: 'var(--green)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700, boxShadow: '0 2px 8px rgba(74,124,89,0.35)', transition: 'opacity 0.15s' },

  sectionHeader: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' },
  sectionTitle:  { fontSize: '13px', fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  countPill:     { fontSize: '12px', fontWeight: 700, background: 'var(--green-xlight)', color: 'var(--green)', padding: '2px 10px', borderRadius: '20px' },

  playerCard:    { background: 'var(--white)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)', overflow: 'hidden' },
  playerHeader:  { display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px', cursor: 'pointer' },
  playerAvatar:  { width: '36px', height: '36px', background: 'var(--green)', color: 'var(--white)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '15px', fontWeight: 700, flexShrink: 0 },
  playerInfo:    { flex: 1, minWidth: 0 },
  playerName:    { fontSize: '14px', fontWeight: 600, color: 'var(--black)' },
  playerMeta:    { fontSize: '12px', color: 'var(--gray-400)', marginTop: '1px' },
  hcpPair:       { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 },
  hcpBox:        { display: 'flex', flexDirection: 'column', alignItems: 'center', background: 'var(--green-xlight)', borderRadius: '8px', padding: '4px 10px', minWidth: '52px' },
  hcpLabel:      { fontSize: '10px', color: 'var(--green)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.3px' },
  hcpVal:        { fontSize: '18px', fontWeight: 800, color: 'var(--green-dark)', lineHeight: 1.2 },
  hcpArrow:      { fontSize: '14px', color: 'var(--gray-300)', fontWeight: 700 },
  chevron:       { fontSize: '10px', color: 'var(--gray-300)', flexShrink: 0 },

  breakdown:      { padding: '0 14px 14px', borderTop: '1px solid var(--gray-100)' },
  breakdownTitle: { fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.4px', margin: '12px 0 8px' },

  tableWrap: { overflowX: 'auto', WebkitOverflowScrolling: 'touch', marginBottom: '14px' },
  table:     { width: '100%', borderCollapse: 'collapse', fontSize: '12px', minWidth: '360px' },
  th:        { padding: '6px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--gray-500)', background: 'var(--gray-100)', fontSize: '11px' },
  thNum:     { padding: '6px 8px', textAlign: 'center', fontWeight: 600, color: 'var(--gray-500)', background: 'var(--gray-100)', fontSize: '11px', width: '50px' },
  td:        { padding: '6px 8px', color: 'var(--black)', borderBottom: '1px solid var(--gray-100)' },
  tdNum:     { padding: '6px 8px', textAlign: 'center', color: 'var(--black)', borderBottom: '1px solid var(--gray-100)' },
  rowEven:   { background: '#fafafa' },

  calcSteps:  { background: 'var(--off-white)', borderRadius: 'var(--radius-sm)', padding: '12px 14px', border: '1px solid var(--gray-200)' },
  calcTitle:  { fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '8px' },
  calcRow:    { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '3px 0' },
  calcLabel:  { fontSize: '12px', color: 'var(--gray-500)' },
  calcVal:    { fontSize: '13px', color: 'var(--black)', fontWeight: 500 },

  card:       { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '12px 14px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  noScoreRow: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', borderBottom: '1px solid var(--gray-100)' },
  noScoreAvatar: { width: '32px', height: '32px', background: 'var(--gray-200)', color: 'var(--gray-500)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 700, flexShrink: 0 },

  empty:       { padding: '40px', textAlign: 'center', color: 'var(--gray-400)', fontSize: '13px' },
  lockedBadge: { fontSize: '11px', fontWeight: 600, color: '#c53030', background: '#fff0f0', border: '1px solid #c53030', padding: '1px 7px', borderRadius: '10px', marginLeft: '8px', verticalAlign: 'middle' },
  lockedNote:  { fontSize: '11px', color: '#c53030', fontStyle: 'italic', maxWidth: '120px', textAlign: 'right', lineHeight: 1.3 },
}

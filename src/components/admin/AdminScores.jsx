import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'

// ─── Skins calculation ───────────────────────────────────────────────────────
// For each hole: find the lowest score. If exactly one player shot it → skin won.
// No carryovers. Each hole is independent.
function calcSkins(playerScoreMap) {
  // playerScoreMap: { playerId: [h1, h2, ..., h9] }
  const entries = Object.entries(playerScoreMap)
  const skins = {} // hole (1-indexed) → playerId or null

  for (let hole = 0; hole < 9; hole++) {
    const holeScores = entries
      .map(([pid, scores]) => ({ pid, score: scores[hole] }))
      .filter(x => x.score != null && x.score > 0)

    if (holeScores.length === 0) { skins[hole + 1] = null; continue }

    const min = Math.min(...holeScores.map(x => x.score))
    const winners = holeScores.filter(x => x.score === min)
    skins[hole + 1] = winners.length === 1 ? winners[0].pid : null // null = tie
  }
  return skins
}

// ─── Score colour (vs par) ───────────────────────────────────────────────────
function scoreColor(score, par) {
  if (!score || !par) return 'var(--black)'
  const diff = score - par
  if (diff <= -2) return '#b8860b'   // eagle or better — gold
  if (diff === -1) return '#dc2626'  // birdie — red
  if (diff === 0)  return '#16a34a'  // par — green
  return 'var(--black)'              // bogey or worse — black
}

export default function AdminScores({ activeEventId = null, onEventChange = () => {} }) {
  const [events, setEvents]         = useState([])
  const [selectedEvent, setSelectedEvent] = useState(activeEventId || '')
  const [eventData, setEventData]   = useState(null)   // { course, pars[] }
  const [teams, setTeams]           = useState([])      // [{team, p1, p2, score1, score2}]
  const [loading, setLoading]       = useState(true)
  const [saving, setSaving]         = useState(false)
  const [toast, setToast]           = useState(null)
  const [editingTeam, setEditingTeam] = useState(null) // team id being edited
  const [holeScores, setHoleScores] = useState({})     // { p1Id: [..9], p2Id: [..9] }
  const [skinsResult, setSkinsResult] = useState(null)
  const [subMap, setSubMap]           = useState({})  // { player_id: { sub_first_name, sub_last_name, sub_handicap } }

  useEffect(() => {
    loadEvents()
  }, [])

  // Sync when parent changes the active event (tab switch or week close)
  useEffect(() => {
    if (activeEventId && activeEventId !== selectedEvent) {
      setSelectedEvent(activeEventId)
    }
  }, [activeEventId])

  useEffect(() => {
    if (selectedEvent) loadEventData(selectedEvent)
  }, [selectedEvent])

  async function loadEvents() {
    const { data, error } = await supabase
      .from('events')
      .select('id, name, event_date, start_date, status, course_id, week_number, is_bye')
      .order('week_number', { ascending: true, nullsFirst: false })

    // Filter bye weeks client-side (safe even if is_bye column doesn't exist yet)
    const playable = (data || []).filter(e => !e.is_bye)
    setEvents(playable)

    // Only compute a local default if the parent hasn't given us one yet
    if (playable.length && !activeEventId) {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const open = playable.find(e => e.status === 'open')
      const current = !open && playable.find(e => {
        if (!e.start_date || !e.end_date) return false
        const start = new Date(e.start_date + 'T00:00:00')
        const end   = new Date(e.end_date   + 'T23:59:59')
        return today >= start && today <= end
      })
      const upcoming = !open && !current && playable.find(e => {
        if (!e.start_date) return false
        return new Date(e.start_date + 'T00:00:00') > today
      })
      const chosen = open || current || upcoming || playable[0]
      setSelectedEvent(chosen.id)
      onEventChange(chosen.id)
    }
    setLoading(false)
  }

  async function loadEventData(eventId) {
    setLoading(true)
    setEditingTeam(null)
    setSkinsResult(null)
    setSubMap({})

    // Get event first, then fetch course separately (avoids FK join issues)
    const { data: evt } = await supabase
      .from('events')
      .select('*')
      .eq('id', eventId)
      .single()

    // Fetch course independently if one is assigned
    let course = null
    if (evt?.course_id) {
      const { data: courseData } = await supabase
        .from('courses')
        .select('id, name, hole_pars')
        .eq('id', evt.course_id)
        .single()
      course = courseData
    }

    // Load teams, players, scores, and approved subs independently
    const [{ data: teamRows }, { data: allPlayers }, { data: scoreRows }, { data: subRows }] = await Promise.all([
      supabase.from('teams').select('id, name, player1_id, player2_id').order('created_at', { ascending: true }),
      supabase.from('players').select('id, name, handicap, in_skins'),
      supabase.from('scores').select('*').eq('event_id', eventId),
      supabase.from('subs').select('player_id, sub_first_name, sub_last_name, sub_handicap, sub_player_id').eq('event_id', eventId).eq('status', 'approved'),
    ])

    // Build sub lookup map: player_id → sub info
    const builtSubMap = {}
    ;(subRows || []).forEach(s => { builtSubMap[s.player_id] = s })
    setSubMap(builtSubMap)

    // Build lookup maps
    const playerById = {}
    ;(allPlayers || []).forEach(p => { playerById[p.id] = p })

    const scoreByPlayer = {}
    ;(scoreRows || []).forEach(s => { scoreByPlayer[s.player_id] = s })

    // Build teams list — client-side join, no FK dependency
    const builtTeams = (teamRows || []).map(t => ({
      id: t.id,
      name: t.name,
      p1: playerById[t.player1_id] || null,
      p2: playerById[t.player2_id] || null,
      score1: scoreByPlayer[t.player1_id] || null,
      score2: scoreByPlayer[t.player2_id] || null,
    })).filter(t => t.p1 && t.p2)

    const holePars = course?.hole_pars || Array(9).fill(4)

    setEventData({ event: evt, course, holePars })
    setTeams(builtTeams)
    setLoading(false)
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  function startEditTeam(team) {
    const p1holes = team.score1?.hole_scores || Array(9).fill('')
    const p2holes = team.score2?.hole_scores || Array(9).fill('')
    setHoleScores({
      [team.p1.id]: p1holes.map(v => v === null ? '' : String(v)),
      [team.p2.id]: p2holes.map(v => v === null ? '' : String(v)),
    })
    setEditingTeam(team.id)
    setSkinsResult(null)
  }

  function updateHole(playerId, holeIdx, val) {
    setHoleScores(prev => {
      const updated = [...(prev[playerId] || Array(9).fill(''))]
      updated[holeIdx] = val
      return { ...prev, [playerId]: updated }
    })
  }

  function calcGross(playerId) {
    return (holeScores[playerId] || [])
      .reduce((sum, v) => sum + (parseInt(v) || 0), 0)
  }

  function calcNet(playerId, handicap) {
    return Math.round(calcGross(playerId) - (handicap || 0))
  }

  function calcNetVsPar(playerId, handicap) {
    const totalPar = (eventData?.holePars || []).reduce((s, p) => s + p, 0)
    return calcNet(playerId, handicap) - totalPar
  }

  async function handleSaveTeamScores(team) {
    setSaving(true)
    const players = [
      { player: team.p1, existingScore: team.score1 },
      { player: team.p2, existingScore: team.score2 },
    ]

    for (const { player, existingScore } of players) {
      const holes = (holeScores[player.id] || []).map(v => parseInt(v) || null)
      const gross = holes.reduce((s, v) => s + (v || 0), 0)
      // Use sub's handicap if an approved sub exists for this player/event
      const sub = subMap[player.id]
      const effectiveHandicap = sub != null ? (sub.sub_handicap || 0) : (player.handicap || 0)
      const net   = Math.round(gross - effectiveHandicap)

      const payload = {
        event_id:      selectedEvent,
        player_id:     player.id,
        hole_scores:   holes,
        gross_total:   gross,
        net_total:     net,
        handicap_used: Math.round(effectiveHandicap),
        sub_played:    sub != null,  // true = player sat out; don't count toward their history
      }

      let error
      if (existingScore) {
        ;({ error } = await supabase.from('scores').update(payload).eq('id', existingScore.id))
      } else {
        ;({ error } = await supabase.from('scores').insert(payload))
      }
      if (error) { showToast('Error saving: ' + error.message, 'error'); setSaving(false); return }

      // If an approved sub played AND has a player profile, save their own score record
      if (sub?.sub_player_id) {
        const subScorePayload = {
          event_id:      selectedEvent,
          player_id:     sub.sub_player_id,
          hole_scores:   holes,
          gross_total:   gross,
          net_total:     net,
          handicap_used: Math.round(effectiveHandicap),
          sub_played:    false,  // from the sub's perspective, they actually played
        }
        // Upsert: update if a record already exists for this sub + event, else insert
        const { data: existingSubScore } = await supabase
          .from('scores')
          .select('id')
          .eq('event_id', selectedEvent)
          .eq('player_id', sub.sub_player_id)
          .maybeSingle()

        if (existingSubScore) {
          await supabase.from('scores').update(subScorePayload).eq('id', existingSubScore.id)
        } else {
          await supabase.from('scores').insert(subScorePayload)
        }
      }
    }

    setSaving(false)
    showToast(`✓ Scores saved for ${team.name}!`)
    setEditingTeam(null)
    loadEventData(selectedEvent)
  }

  async function handleCalculateSkins() {
    // Load scores + all players independently (avoids FK join issues)
    const [{ data: allScores }, { data: skinPlayers }] = await Promise.all([
      supabase.from('scores').select('player_id, hole_scores').eq('event_id', selectedEvent),
      supabase.from('players').select('id, name, in_skins'),
    ])

    if (!allScores?.length) { showToast('No scores entered yet.', 'error'); return }

    // Build player lookup
    const playerById = {}
    ;(skinPlayers || []).forEach(p => { playerById[p.id] = p })

    // Filter to only players flagged as in_skins
    const skinsScores = allScores.filter(s => playerById[s.player_id]?.in_skins)

    if (!skinsScores.length) {
      showToast('No players in the skins game have scores this week.', 'error')
      return
    }

    const playerScoreMap = {}
    const playerNames = {}
    skinsScores.forEach(s => {
      if (s.hole_scores) {
        playerScoreMap[s.player_id] = s.hole_scores
        playerNames[s.player_id] = playerById[s.player_id]?.name || s.player_id
      }
    })

    const skins = calcSkins(playerScoreMap)
    setSkinsResult({ skins, playerNames, allScores: skinsScores })
  }

  // ── UI Helpers ──────────────────────────────────────────────────────────────
  const submitted   = teams.filter(t => t.score1 || t.score2)
  const unsubmitted = teams.filter(t => !t.score1 && !t.score2)
  const holePars    = eventData?.holePars || Array(9).fill(4)
  const totalPar    = holePars.reduce((s, p) => s + p, 0)

  if (loading && !events.length) return <div style={styles.loading}>Loading…</div>

  return (
    <div style={styles.container}>
      {toast && (
        <div style={{ ...styles.toast, background: toast.type === 'error' ? '#c53030' : 'var(--green)' }}>
          {toast.msg}
        </div>
      )}

      {/* Event Selector */}
      <div style={styles.card}>
        <label style={styles.sectionLabel}>Event / Round</label>
        <select style={styles.select} value={selectedEvent} onChange={e => { setSelectedEvent(e.target.value); onEventChange(e.target.value) }}>
          {events.map(evt => (
            <option key={evt.id} value={evt.id}>
              {evt.week_number != null ? `Wk ${evt.week_number} — ` : ''}{evt.name || 'Unnamed'}
              {' '}({evt.status || 'draft'})
            </option>
          ))}
        </select>
        {eventData && (
          <div style={styles.eventMeta}>
            Course: <strong>{eventData.course?.name || 'Not assigned'}</strong>
            {' · '}Par {totalPar}
            {' · '}{submitted.length}/{teams.length} teams submitted
          </div>
        )}
      </div>

      {loading && <div style={styles.loading}>Loading scores…</div>}

      {!loading && (
        <>
          {/* Unsubmitted Teams */}
          {unsubmitted.length > 0 && (
            <div style={styles.card}>
              <div style={styles.cardTitleRow}>
                <h3 style={styles.cardTitle}>⏳ Awaiting Scores</h3>
                <span style={{ ...styles.badge, background: '#fff5f5', color: '#c53030' }}>
                  {unsubmitted.length}
                </span>
              </div>
              {unsubmitted.map(team => (
                <TeamRow
                  key={team.id}
                  team={team}
                  holePars={holePars}
                  isEditing={editingTeam === team.id}
                  holeScores={holeScores}
                  saving={saving}
                  subMap={subMap}
                  onEdit={() => startEditTeam(team)}
                  onHoleChange={updateHole}
                  onSave={() => handleSaveTeamScores(team)}
                  onCancel={() => setEditingTeam(null)}
                  calcGross={calcGross}
                  calcNet={calcNet}
                  calcNetVsPar={calcNetVsPar}
                />
              ))}
            </div>
          )}

          {/* Submitted Teams */}
          {submitted.length > 0 && (
            <div style={styles.card}>
              <div style={styles.cardTitleRow}>
                <h3 style={styles.cardTitle}>✓ Submitted</h3>
                <span style={{ ...styles.badge, background: 'var(--green-xlight)', color: 'var(--green)' }}>
                  {submitted.length}
                </span>
              </div>
              {submitted.map(team => (
                <TeamRow
                  key={team.id}
                  team={team}
                  holePars={holePars}
                  isEditing={editingTeam === team.id}
                  holeScores={holeScores}
                  saving={saving}
                  subMap={subMap}
                  onEdit={() => startEditTeam(team)}
                  onHoleChange={updateHole}
                  onSave={() => handleSaveTeamScores(team)}
                  onCancel={() => setEditingTeam(null)}
                  calcGross={calcGross}
                  calcNet={calcNet}
                  calcNetVsPar={calcNetVsPar}
                />
              ))}
            </div>
          )}

          {/* Skins Calculator */}
          <button style={styles.skinsBtn} onClick={handleCalculateSkins}>
            🎯 Calculate Skins for This Event
          </button>

          {skinsResult && (
            <div style={styles.card}>
              <h3 style={styles.cardTitle}>🎯 Skins Results</h3>
              <p style={styles.skinsNote}>Lowest unique score per hole wins. No carryovers.</p>
              {Array.from({ length: 9 }, (_, i) => i + 1).map(hole => {
                const winnerId = skinsResult.skins[hole]
                const allHoleScores = skinsResult.allScores.map(s => ({
                  name: s.players?.name,
                  score: s.hole_scores?.[hole - 1],
                })).filter(x => x.score)
                const min = Math.min(...allHoleScores.map(x => x.score))
                return (
                  <div key={hole} style={styles.skinHoleRow}>
                    <span style={styles.skinHoleNum}>H{hole}</span>
                    <span style={styles.skinPar}>Par {holePars[hole - 1]}</span>
                    <div style={styles.skinScores}>
                      {allHoleScores.map(x => (
                        <span key={x.name} style={{ ...styles.skinScore, color: scoreColor(x.score, holePars[hole - 1]), fontWeight: x.score === min ? 700 : 400 }}>
                          {x.name}: {x.score}
                        </span>
                      ))}
                    </div>
                    {winnerId ? (
                      <span style={styles.skinWinner}>🏆 {skinsResult.playerNames[winnerId]}</span>
                    ) : (
                      <span style={styles.skinTie}>Tied – no skin</span>
                    )}
                  </div>
                )
              })}
              <div style={styles.skinsSummary}>
                {Object.values(skinsResult.skins).filter(Boolean).length === 0
                  ? 'No skins won this week.'
                  : `${Object.values(skinsResult.skins).filter(Boolean).length} skin(s) won this week.`}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Team Row Component ───────────────────────────────────────────────────────
function TeamRow({ team, holePars, isEditing, holeScores, saving, subMap = {}, onEdit, onHoleChange, onSave, onCancel, calcGross, calcNet, calcNetVsPar }) {
  const totalPar = holePars.reduce((s, p) => s + p, 0)
  const submitted = !!(team.score1 || team.score2)

  // Helper: get effective handicap (sub's if one exists, else player's own)
  function effectiveHcp(player) {
    const sub = subMap[player.id]
    return sub != null ? (sub.sub_handicap || 0) : (player.handicap || 0)
  }

  // Helper: sub display name
  function subName(playerId) {
    const s = subMap[playerId]
    if (!s) return null
    return `${s.sub_first_name || ''} ${s.sub_last_name || ''}`.trim()
  }

  return (
    <div style={trStyles.wrapper}>
      {/* Team Header */}
      <div style={trStyles.header} onClick={!isEditing ? onEdit : undefined}>
        <div style={trStyles.headerLeft}>
          <span style={trStyles.teamName}>{team.name}</span>
          <span style={trStyles.players}>
            {subName(team.p1?.id)
              ? <>{subName(team.p1.id)} <span style={trStyles.subPill}>sub for {team.p1.name.split(' ')[0]}</span></>
              : team.p1?.name}
            {' & '}
            {subName(team.p2?.id)
              ? <>{subName(team.p2.id)} <span style={trStyles.subPill}>sub for {team.p2.name.split(' ')[0]}</span></>
              : team.p2?.name}
          </span>
        </div>
        {submitted && !isEditing && (
          <div style={trStyles.headerRight}>
            <div style={trStyles.teamTotals}>
              <span>Gross {(team.score1?.gross_total || 0) + (team.score2?.gross_total || 0)}</span>
              <span>Net {(team.score1?.net_total || 0) + (team.score2?.net_total || 0)}</span>
            </div>
            <button style={trStyles.editBtn}>Edit</button>
          </div>
        )}
        {!submitted && !isEditing && (
          <button style={trStyles.enterBtn}>+ Enter Scores</button>
        )}
      </div>

      {/* Scorecard Editor */}
      {isEditing && (
        <div style={trStyles.scorecard}>
          <div style={trStyles.scorecardScroll}>
            <table style={trStyles.table}>
              <thead>
                <tr>
                  <th style={trStyles.thLabel}>Hole</th>
                  {holePars.map((_, i) => (
                    <th key={i} style={trStyles.th}>{i + 1}</th>
                  ))}
                  <th style={trStyles.thTotal}>Gross</th>
                  <th style={trStyles.thTotal}>Net</th>
                  <th style={trStyles.thTotal}>vs Par</th>
                </tr>
                <tr style={trStyles.parRow}>
                  <td style={trStyles.thLabel}>Par</td>
                  {holePars.map((par, i) => (
                    <td key={i} style={trStyles.parCell}>{par}</td>
                  ))}
                  <td style={trStyles.parCell}>{totalPar}</td>
                  <td style={trStyles.parCell}>—</td>
                  <td style={trStyles.parCell}>—</td>
                </tr>
              </thead>
              <tbody>
                {[team.p1, team.p2].map(player => {
                  const hcp   = effectiveHcp(player)
                  const gross = calcGross(player.id)
                  const net   = calcNet(player.id, hcp)
                  const vspar = calcNetVsPar(player.id, hcp)
                  const sName = subName(player.id)
                  return (
                    <tr key={player.id}>
                      <td style={trStyles.playerCell}>
                        <div style={trStyles.playerName}>
                          {sName || player.name.split(' ')[0]}
                        </div>
                        {sName && (
                          <div style={trStyles.subForLabel}>sub for {player.name.split(' ')[0]}</div>
                        )}
                        <div style={trStyles.playerHcp}>
                          HCP {hcp ?? '—'}
                          {sName && ' ⚠️'}
                        </div>
                      </td>
                      {holePars.map((par, i) => {
                        const val = (holeScores[player.id] || [])[i] || ''
                        const score = parseInt(val)
                        const diff = score && par ? score - par : null
                        const hasScore = score && par
                        const borderColor = hasScore
                          ? diff <= -2 ? '#b8860b'
                          : diff === -1 ? '#dc2626'
                          : diff === 0  ? '#16a34a'
                          : 'var(--gray-200)'
                          : 'var(--gray-200)'
                        const bgColor = hasScore
                          ? diff <= -2 ? '#fef9c3'
                          : diff === -1 ? '#fee2e2'
                          : diff === 0  ? '#dcfce7'
                          : 'var(--gray-100)'
                          : 'var(--gray-100)'
                        return (
                          <td key={i} style={trStyles.inputCell}>
                            <input
                              type="number"
                              min="1"
                              max="15"
                              value={val}
                              onChange={e => onHoleChange(player.id, i, e.target.value)}
                              style={{
                                ...trStyles.holeInput,
                                color: score ? scoreColor(score, par) : 'var(--gray-400)',
                                fontWeight: score ? 700 : 400,
                                border: `1.5px solid ${borderColor}`,
                                background: bgColor,
                              }}
                            />
                          </td>
                        )
                      })}
                      <td style={trStyles.totalCell}>{gross || '—'}</td>
                      <td style={trStyles.totalCell}>{gross ? net : '—'}</td>
                      <td style={{
                        ...trStyles.totalCell,
                        color: gross ? (vspar < 0 ? '#dc2626' : vspar > 0 ? 'var(--black)' : '#16a34a') : 'var(--gray-400)',
                        fontWeight: 700,
                      }}>
                        {gross ? (vspar > 0 ? `+${vspar}` : vspar) : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Team Summary */}
          {(() => {
            const g1 = calcGross(team.p1.id), g2 = calcGross(team.p2.id)
            const h1 = effectiveHcp(team.p1), h2 = effectiveHcp(team.p2)
            const n1 = calcNet(team.p1.id, h1), n2 = calcNet(team.p2.id, h2)
            const teamGross = g1 + g2, teamNet = n1 + n2
            const teamVsPar = teamNet - (totalPar * 2)
            return (
              <div style={trStyles.teamSummary}>
                <div style={trStyles.summaryItem}>
                  <span style={trStyles.summaryLabel}>Team Gross</span>
                  <span style={trStyles.summaryValue}>{g1 && g2 ? teamGross : '—'}</span>
                </div>
                <div style={trStyles.summaryItem}>
                  <span style={trStyles.summaryLabel}>Team HCP</span>
                  <span style={trStyles.summaryValue}>{Math.round((h1 + h2) * 10) / 10}</span>
                </div>
                <div style={trStyles.summaryItem}>
                  <span style={trStyles.summaryLabel}>Team Net</span>
                  <span style={trStyles.summaryValue}>{g1 && g2 ? teamNet : '—'}</span>
                </div>
                <div style={trStyles.summaryItem}>
                  <span style={trStyles.summaryLabel}>Net vs Par</span>
                  <span style={{ ...trStyles.summaryValue, color: teamVsPar < 0 ? '#dc2626' : teamVsPar > 0 ? 'var(--black)' : '#16a34a' }}>
                    {g1 && g2 ? (teamVsPar > 0 ? `+${teamVsPar}` : teamVsPar) : '—'}
                  </span>
                </div>
              </div>
            )
          })()}

          <div style={trStyles.actions}>
            <button style={trStyles.saveBtn} onClick={onSave} disabled={saving}>
              {saving ? 'Saving…' : '✓ Save Scores'}
            </button>
            <button style={trStyles.cancelBtn} onClick={onCancel}>Cancel</button>
          </div>
        </div>
      )}

      {/* Submitted Score Summary (collapsed) */}
      {submitted && !isEditing && (
        <div style={trStyles.submittedSummary}>
          {[team.p1, team.p2].map((player, i) => {
            const s = i === 0 ? team.score1 : team.score2
            const sName = subName(player.id)
            return (
              <div key={player.id} style={trStyles.submittedRow}>
                <span style={trStyles.submittedName}>
                  {sName
                    ? <>{sName} <span style={trStyles.subPillSm}>sub</span></>
                    : player.name}
                </span>
                <span style={trStyles.submittedScores}>
                  Gross {s?.gross_total ?? '—'} · Net {s?.net_total ?? '—'}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = {
  container: { padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' },
  loading: { padding: '40px', textAlign: 'center', color: 'var(--gray-400)' },
  toast: { position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', color: 'white', padding: '10px 20px', borderRadius: '20px', fontSize: '13px', fontWeight: 600, zIndex: 9999, boxShadow: 'var(--shadow-lg)', whiteSpace: 'nowrap' },
  card: { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '14px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  cardTitleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' },
  cardTitle: { fontSize: '13px', fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  badge: { fontSize: '12px', fontWeight: 700, padding: '2px 10px', borderRadius: '20px' },
  sectionLabel: { fontSize: '11px', fontWeight: 600, color: 'var(--gray-600)', textTransform: 'uppercase', letterSpacing: '0.4px', display: 'block', marginBottom: '6px' },
  select: { width: '100%', padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--gray-100)', color: 'var(--black)' },
  eventMeta: { fontSize: '12px', color: 'var(--gray-400)', marginTop: '8px' },
  skinsBtn: { width: '100%', padding: '12px', background: 'var(--gold)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700, boxShadow: '0 2px 8px rgba(201,168,76,0.4)' },
  skinsNote: { fontSize: '12px', color: 'var(--gray-400)', marginBottom: '12px' },
  skinHoleRow: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 0', borderBottom: '1px solid var(--gray-100)', flexWrap: 'wrap' },
  skinHoleNum: { fontSize: '12px', fontWeight: 700, background: 'var(--green-xlight)', color: 'var(--green)', padding: '3px 8px', borderRadius: '6px', flexShrink: 0 },
  skinPar: { fontSize: '11px', color: 'var(--gray-400)', flexShrink: 0 },
  skinScores: { flex: 1, display: 'flex', gap: '8px', flexWrap: 'wrap' },
  skinScore: { fontSize: '12px' },
  skinWinner: { fontSize: '12px', fontWeight: 700, color: '#7a5c00', background: 'var(--gold-light)', padding: '2px 8px', borderRadius: '20px', flexShrink: 0 },
  skinTie: { fontSize: '11px', color: 'var(--gray-400)', fontStyle: 'italic', flexShrink: 0 },
  skinsSummary: { marginTop: '12px', fontSize: '13px', fontWeight: 600, color: 'var(--green-dark)', textAlign: 'center', padding: '10px', background: 'var(--green-xlight)', borderRadius: 'var(--radius-sm)' },
}

const trStyles = {
  wrapper: { borderBottom: '1px solid var(--gray-100)', paddingBottom: '12px', marginBottom: '12px' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', padding: '6px 0' },
  headerLeft: { display: 'flex', flexDirection: 'column', gap: '2px' },
  teamName: { fontSize: '14px', fontWeight: 700, color: 'var(--green-dark)' },
  players: { fontSize: '12px', color: 'var(--gray-400)' },
  headerRight: { display: 'flex', alignItems: 'center', gap: '10px' },
  teamTotals: { display: 'flex', gap: '10px', fontSize: '12px', color: 'var(--gray-600)' },
  editBtn: { fontSize: '12px', color: 'var(--green)', fontWeight: 600, padding: '4px 10px', background: 'var(--green-xlight)', borderRadius: '6px' },
  enterBtn: { fontSize: '12px', color: 'var(--green)', fontWeight: 700, padding: '6px 12px', background: 'var(--green-xlight)', borderRadius: '6px' },
  scorecard: { marginTop: '10px' },
  scorecardScroll: { overflowX: 'auto', WebkitOverflowScrolling: 'touch', marginBottom: '10px' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '520px' },
  thLabel: { padding: '6px 8px', textAlign: 'left', fontWeight: 600, color: 'var(--gray-600)', fontSize: '11px', background: 'var(--gray-100)', borderRadius: '4px', whiteSpace: 'nowrap' },
  th: { padding: '6px 4px', textAlign: 'center', fontWeight: 600, color: 'var(--gray-600)', fontSize: '11px', background: 'var(--gray-100)', minWidth: '34px' },
  thTotal: { padding: '6px 6px', textAlign: 'center', fontWeight: 700, color: 'var(--green-dark)', fontSize: '11px', background: 'var(--green-xlight)', minWidth: '40px' },
  parRow: { background: 'var(--gray-100)' },
  parCell: { padding: '4px', textAlign: 'center', fontSize: '12px', color: 'var(--gray-600)', fontWeight: 600 },
  playerCell: { padding: '8px 6px 8px 0' },
  playerName: { fontSize: '13px', fontWeight: 600, color: 'var(--black)', whiteSpace: 'nowrap' },
  playerHcp: { fontSize: '10px', color: 'var(--gray-400)' },
  inputCell: { padding: '4px 2px' },
  holeInput: {
    width: '32px',
    height: '32px',
    border: '1.5px solid var(--gray-200)',
    borderRadius: '6px',
    textAlign: 'center',
    fontSize: '14px',
    fontWeight: 600,
    lineHeight: '32px',
    background: 'var(--gray-100)',
    outline: 'none',
    padding: 0,
    display: 'block',
    MozAppearance: 'textfield',
    WebkitAppearance: 'none',
  },
  totalCell: { padding: '4px 6px', textAlign: 'center', fontSize: '13px', fontWeight: 600, color: 'var(--black)' },
  teamSummary: { display: 'flex', gap: '8px', background: 'var(--green-xlight)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', marginBottom: '10px' },
  summaryItem: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' },
  summaryLabel: { fontSize: '10px', color: 'var(--green)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.3px' },
  summaryValue: { fontSize: '16px', fontWeight: 800, color: 'var(--green-dark)' },
  actions: { display: 'flex', gap: '10px' },
  saveBtn: { flex: 1, padding: '11px', background: 'var(--green)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700 },
  cancelBtn: { flex: 1, padding: '11px', background: 'var(--gray-100)', color: 'var(--gray-600)', borderRadius: 'var(--radius-sm)', fontSize: '14px' },
  submittedSummary: { paddingTop: '6px', display: 'flex', gap: '12px', flexWrap: 'wrap' },
  submittedRow: { display: 'flex', gap: '8px', alignItems: 'center' },
  submittedName: { fontSize: '12px', fontWeight: 600, color: 'var(--black)' },
  submittedScores: { fontSize: '12px', color: 'var(--gray-400)' },
  subPill: { fontSize: '10px', fontWeight: 700, background: '#fff3cd', color: '#7a5c00', padding: '1px 6px', borderRadius: '10px', marginLeft: '4px', verticalAlign: 'middle' },
  subPillSm: { fontSize: '9px', fontWeight: 700, background: '#fff3cd', color: '#7a5c00', padding: '1px 5px', borderRadius: '8px', marginLeft: '3px', verticalAlign: 'middle' },
  subForLabel: { fontSize: '9px', color: '#7a5c00', fontStyle: 'italic' },
}

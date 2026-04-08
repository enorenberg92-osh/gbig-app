import React, { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'

// ── Crop Modal ────────────────────────────────────────────────────────────────
function CropModal({ file, onConfirm, onCancel }) {
  const SIZE = 270  // on-screen crop circle diameter
  const [img, setImg]         = useState(null)
  const [scale, setScale]     = useState(1)
  const [minScale, setMinScale] = useState(1)
  const [offset, setOffset]   = useState({ x: 0, y: 0 })
  const dragging  = useRef(false)
  const dragStart = useRef({ mx: 0, my: 0, ox: 0, oy: 0 })

  useEffect(() => {
    const image = new Image()
    const url   = URL.createObjectURL(file)
    image.onload = () => {
      const s = Math.max(SIZE / image.naturalWidth, SIZE / image.naturalHeight)
      setImg(image)
      setMinScale(s)
      setScale(s)
      setOffset({ x: (SIZE - image.naturalWidth * s) / 2, y: (SIZE - image.naturalHeight * s) / 2 })
    }
    image.src = url
    return () => URL.revokeObjectURL(url)
  }, [file])

  function clamp(off, s) {
    if (!img) return off
    return {
      x: Math.min(0, Math.max(SIZE - img.naturalWidth  * s, off.x)),
      y: Math.min(0, Math.max(SIZE - img.naturalHeight * s, off.y)),
    }
  }

  // Mouse drag
  const onMD = e => { dragging.current = true; dragStart.current = { mx: e.clientX, my: e.clientY, ox: offset.x, oy: offset.y } }
  const onMM = e => { if (!dragging.current) return; const { mx, my, ox, oy } = dragStart.current; setOffset(clamp({ x: ox + e.clientX - mx, y: oy + e.clientY - my }, scale)) }
  const onMU = ()  => { dragging.current = false }

  // Touch drag
  const onTS = e => { if (e.touches.length !== 1) return; dragging.current = true; dragStart.current = { mx: e.touches[0].clientX, my: e.touches[0].clientY, ox: offset.x, oy: offset.y } }
  const onTM = e => { e.preventDefault(); if (!dragging.current || e.touches.length !== 1) return; const { mx, my, ox, oy } = dragStart.current; setOffset(clamp({ x: ox + e.touches[0].clientX - mx, y: oy + e.touches[0].clientY - my }, scale)) }

  function onZoom(raw) {
    const s  = Number(raw)
    const cx = SIZE / 2, cy = SIZE / 2
    setScale(s)
    setOffset(clamp({ x: cx - (cx - offset.x) * (s / scale), y: cy - (cy - offset.y) * (s / scale) }, s))
  }

  function confirm() {
    if (!img) return
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 400
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, -offset.x / scale, -offset.y / scale, SIZE / scale, SIZE / scale, 0, 0, 400, 400)
    canvas.toBlob(blob => onConfirm(blob), 'image/jpeg', 0.88)
  }

  const maxScale = minScale * 4

  return (
    <div style={cs.overlay}>
      <div style={cs.modal}>
        <div style={cs.title}>Position your photo</div>

        {/* Crop circle */}
        <div
          style={{ ...cs.cropArea, width: SIZE, height: SIZE }}
          onMouseDown={onMD} onMouseMove={onMM} onMouseUp={onMU} onMouseLeave={onMU}
          onTouchStart={onTS} onTouchMove={onTM} onTouchEnd={onMU}
        >
          {img && (
            <img src={img.src} draggable={false} style={{
              position: 'absolute', pointerEvents: 'none', userSelect: 'none',
              left: offset.x, top: offset.y,
              width: img.naturalWidth * scale, height: img.naturalHeight * scale,
            }} />
          )}
          {/* Dark ring outside the circle to show crop boundary */}
          <div style={cs.ring} />
        </div>

        {/* Zoom slider */}
        <div style={cs.zoomRow}>
          <span style={cs.zoomIcon}>🔍</span>
          <input type="range" style={cs.slider}
            min={minScale} max={maxScale} step={(maxScale - minScale) / 200}
            value={scale} onChange={e => onZoom(e.target.value)}
          />
          <span style={cs.zoomIcon}>🔎</span>
        </div>
        <div style={cs.hint}>Drag to reposition · slide to zoom</div>

        <div style={cs.btns}>
          <button style={cs.cancelBtn} onClick={onCancel}>Cancel</button>
          <button style={cs.confirmBtn} onClick={confirm}>Use this photo ✓</button>
        </div>
      </div>
    </div>
  )
}

const cs = {
  overlay:    { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.75)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 },
  modal:      { background: '#fff', borderRadius: 20, padding: '24px 20px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, width: '100%', maxWidth: 340 },
  title:      { fontSize: 16, fontWeight: 800, color: 'var(--black)' },
  cropArea:   { position: 'relative', overflow: 'hidden', borderRadius: '50%', cursor: 'grab', background: '#222', flexShrink: 0, touchAction: 'none' },
  ring:       { position: 'absolute', inset: -4, borderRadius: '50%', boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)', pointerEvents: 'none' },
  zoomRow:    { display: 'flex', alignItems: 'center', gap: 10, width: '100%' },
  zoomIcon:   { fontSize: 16 },
  slider:     { flex: 1, accentColor: 'var(--green-dark)' },
  hint:       { fontSize: 11, color: 'var(--gray-400)', marginTop: -6 },
  btns:       { display: 'flex', gap: 10, width: '100%' },
  cancelBtn:  { flex: 1, padding: '12px', background: 'var(--gray-100)', color: 'var(--gray-600)', borderRadius: 'var(--radius-sm)', fontSize: 14, fontWeight: 600, cursor: 'pointer' },
  confirmBtn: { flex: 1, padding: '12px', background: 'var(--green-dark)', color: '#fff', borderRadius: 'var(--radius-sm)', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
}

// playerId prop: if provided (admin view), load that player directly.
// Otherwise fall back to the logged-in user's player record.
export default function PlayerProfile({ session, onBack, playerId: adminPlayerId }) {
  const [loading, setLoading]       = useState(true)
  const [player, setPlayer]         = useState(null)
  const [team, setTeam]             = useState(null)
  const [teammate, setTeammate]     = useState(null)
  const [rounds, setRounds]         = useState([])
  const [parBreakdown, setParBreakdown] = useState([])
  const [trendMetric, setTrendMetric]   = useState('gross')
  const [error, setError]           = useState(null)
  const [pwForm, setPwForm]         = useState({ current: '', next: '', confirm: '' })
  const [pwSaving, setPwSaving]     = useState(false)
  const [pwMsg, setPwMsg]           = useState(null)  // { text, type }
  const [avatarUploading, setAvatarUploading] = useState(false)
  const [cropFile, setCropFile] = useState(null)
  const fileInputRef = useRef(null)

  useEffect(() => { load() }, [])

  async function load() {
    try {
      // 1. Find player — by explicit ID (admin view) or by logged-in user
      let playerRow, pErr
      if (adminPlayerId) {
        ;({ data: playerRow, error: pErr } = await supabase
          .from('players')
          .select('id, first_name, last_name, name, handicap, email, avatar_url')
          .eq('id', adminPlayerId)
          .single())
      } else {
        ;({ data: playerRow, error: pErr } = await supabase
          .from('players')
          .select('id, first_name, last_name, name, handicap, email, avatar_url')
          .eq('user_id', session.user.id)
          .single())
      }

      if (pErr || !playerRow) {
        setError('No player record found.')
        setLoading(false)
        return
      }
      setPlayer(playerRow)

      // 2. Load teams, all players, and this player's scores in parallel
      const [teamsRes, allPlayersRes, scoresRes] = await Promise.all([
        supabase.from('teams').select('id, name, player1_id, player2_id'),
        supabase.from('players').select('id, first_name, last_name, name, handicap'),
        supabase.from('scores')
          .select('id, event_id, gross_total, net_total, hole_scores, handicap_used')
          .eq('player_id', playerRow.id),
      ])

      // Team + teammate
      const myTeam = (teamsRes.data || []).find(
        t => t.player1_id === playerRow.id || t.player2_id === playerRow.id
      )
      setTeam(myTeam || null)
      if (myTeam) {
        const tmId = myTeam.player1_id === playerRow.id ? myTeam.player2_id : myTeam.player1_id
        const tm = (allPlayersRes.data || []).find(p => p.id === tmId)
        setTeammate(tm || null)
      }

      const scoreRows = scoresRes.data || []
      if (scoreRows.length === 0) { setRounds([]); setLoading(false); return }

      // 3. Load events for these scores
      const eventIds = [...new Set(scoreRows.map(s => s.event_id))]
      const { data: eventsData } = await supabase
        .from('events')
        .select('id, name, week_number, start_date, course_id')
        .in('id', eventIds)

      const eventMap = {}
      ;(eventsData || []).forEach(e => { eventMap[e.id] = e })

      // 4. Load courses
      const courseIds = [...new Set((eventsData || []).map(e => e.course_id).filter(Boolean))]
      const courseMap = {}
      if (courseIds.length > 0) {
        const { data: coursesData } = await supabase
          .from('courses')
          .select('id, name, hole_pars, total_par')
          .in('id', courseIds)
        ;(coursesData || []).forEach(c => { courseMap[c.id] = c })
      }

      // 5. Merge into rounds
      const rds = scoreRows.map(s => {
        const evt    = eventMap[s.event_id] || {}
        const course = courseMap[evt.course_id] || {}
        const coursePar = course.total_par ?? 36
        const holePars  = course.hole_pars || null
        const gross = s.gross_total
        const net   = s.net_total
        return {
          id:           s.id,
          eventName:    evt.name || 'Round',
          weekNumber:   evt.week_number || null,
          startDate:    evt.start_date || null,
          gross,
          net,
          handicapUsed: s.handicap_used,
          coursePar,
          vsPar:        gross != null ? gross - coursePar : null,
          holeScores:   Array.isArray(s.hole_scores) ? s.hole_scores : [],
          holePars,
        }
      })

      setRounds(rds)
      setParBreakdown(calcParTypeBreakdown(rds))
      setLoading(false)
    } catch (e) {
      setError('Something went wrong loading your profile.')
      setLoading(false)
    }
  }

  // ── Stat helpers ────────────────────────────────────────────────────────────

  function calcParTypeBreakdown(rds) {
    const byPar = {
      3: { birdie: 0, par: 0, bogey: 0, double: 0, total: 0, sum: 0 },
      4: { birdie: 0, par: 0, bogey: 0, double: 0, total: 0, sum: 0 },
      5: { birdie: 0, par: 0, bogey: 0, double: 0, total: 0, sum: 0 },
    }
    rds.forEach(rd => {
      if (!rd.holeScores?.length || !rd.holePars?.length) return
      rd.holeScores.forEach((s, i) => {
        const p = rd.holePars[i]
        if (!s || ![3, 4, 5].includes(p)) return
        const b = byPar[p]
        b.total++; b.sum += s
        const diff = s - p
        if (diff <= -1) b.birdie++
        else if (diff === 0) b.par++
        else if (diff === 1) b.bogey++
        else b.double++
      })
    })
    return [3, 4, 5].map(par => {
      const d = byPar[par]
      if (d.total === 0) return null
      const avg = (d.sum / d.total).toFixed(1)
      const vsAvg = ((d.sum / d.total) - par).toFixed(1)
      return {
        par,
        avg,
        vsAvg: Number(vsAvg) >= 0 ? `+${vsAvg}` : vsAvg,
        vsPositive: Number(vsAvg) > 0,
        birdiePct: pct(d.birdie, d.total),
        parPct:    pct(d.par,    d.total),
        bogeyPct:  pct(d.bogey,  d.total),
        doublePct: pct(d.double, d.total),
      }
    }).filter(Boolean)
  }

  function pct(n, t) { return t > 0 ? Math.round((n / t) * 100) : 0 }

  function vsParLabel(v) {
    if (v == null) return '—'
    if (v === 0) return 'E'
    return v > 0 ? `+${v}` : `${v}`
  }
  function vsParColor(v) {
    if (v == null) return 'var(--gray-400)'
    if (v <= -1)   return 'var(--green)'
    if (v === 0)   return 'var(--black)'
    return '#c53030'
  }

  // ── Derived stats ────────────────────────────────────────────────────────────

  const validGross = rounds.filter(r => r.gross != null)
  const validNet   = rounds.filter(r => r.net   != null)
  const avgGross   = validGross.length ? (validGross.reduce((a, r) => a + r.gross, 0) / validGross.length).toFixed(1) : null
  const avgNet     = validNet.length   ? (validNet.reduce((a, r)   => a + r.net,   0) / validNet.length).toFixed(1)   : null

  const sortedByNet = [...validNet].sort((a, b) => a.net - b.net)
  const bestRound  = sortedByNet[0]   || null
  const worstRound = sortedByNet[sortedByNet.length - 1] || null

  // ── SVG line chart ───────────────────────────────────────────────────────────

  function TrendChart({ rounds, metric }) {
    const W = 320, H = 120, PAD = { top: 16, bottom: 28, left: 32, right: 12 }
    const innerW = W - PAD.left - PAD.right
    const innerH = H - PAD.top  - PAD.bottom

    const getValue = r => metric === 'gross' ? r.gross : metric === 'net' ? r.net : r.handicapUsed
    const pts = rounds.filter(r => getValue(r) != null)
    if (pts.length === 0) return null

    // Single round — show the score with a prompt to keep playing
    if (pts.length === 1) {
      const val = getValue(pts[0])
      return (
        <div style={{ textAlign: 'center', padding: '16px 0 8px' }}>
          <div style={{ fontSize: 36, fontWeight: 800, color: 'var(--green-dark)', lineHeight: 1 }}>{val}</div>
          <div style={{ fontSize: 11, color: 'var(--gray-400)', marginTop: 8 }}>
            {pts[0].weekNumber ? `Wk ${pts[0].weekNumber}` : 'Round 1'} · Play more rounds to build your trend
          </div>
        </div>
      )
    }

    const vals  = pts.map(getValue)
    const minV  = Math.min(...vals)
    const maxV  = Math.max(...vals)
    const range = maxV - minV || 1

    const coords = pts.map((r, i) => ({
      x: PAD.left + (i / (pts.length - 1)) * innerW,
      y: PAD.top  + (1 - (getValue(r) - minV) / range) * innerH,
      val: getValue(r),
      label: r.weekNumber ? `Wk ${r.weekNumber}` : `R${i + 1}`,
    }))

    // Smooth bezier path
    function smoothPath(coords) {
      if (coords.length < 2) return ''
      let d = `M ${coords[0].x} ${coords[0].y}`
      for (let i = 1; i < coords.length; i++) {
        const p0 = coords[i - 2] || coords[i - 1]
        const p1 = coords[i - 1]
        const p2 = coords[i]
        const p3 = coords[i + 1] || p2
        const cp1x = p1.x + (p2.x - p0.x) / 6
        const cp1y = p1.y + (p2.y - p0.y) / 6
        const cp2x = p2.x - (p3.x - p1.x) / 6
        const cp2y = p2.y - (p3.y - p1.y) / 6
        d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`
      }
      return d
    }

    const lineColor = metric === 'net' ? 'var(--green)' : metric === 'handicap' ? 'var(--gold)' : 'var(--gray-800)'
    const path = smoothPath(coords)

    // Y-axis labels
    const yLabels = [maxV, Math.round((maxV + minV) / 2), minV]

    return (
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', overflow: 'visible' }}>
        {/* Y-axis grid lines + labels */}
        {yLabels.map((v, i) => {
          const y = PAD.top + (i / (yLabels.length - 1)) * innerH
          return (
            <g key={i}>
              <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="var(--gray-200)" strokeWidth={0.5} strokeDasharray="3 3" />
              <text x={PAD.left - 4} y={y + 4} textAnchor="end" fontSize={8} fill="var(--gray-400)">{v}</text>
            </g>
          )
        })}

        {/* Line */}
        <path d={path} fill="none" stroke={lineColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

        {/* Dots + x-labels */}
        {coords.map((c, i) => (
          <g key={i}>
            <circle cx={c.x} cy={c.y} r={3.5} fill="#fff" stroke={lineColor} strokeWidth={2} />
            {(i === 0 || i === coords.length - 1 || coords.length <= 8) && (
              <text x={c.x} y={H - 4} textAnchor="middle" fontSize={7.5} fill="var(--gray-400)">{c.label}</text>
            )}
          </g>
        ))}
      </svg>
    )
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (loading) return (
    <div style={styles.centered}>
      <div style={{ fontSize: 40 }}>⛳</div>
      <p style={{ color: 'var(--gray-400)', fontSize: 14 }}>Loading your profile…</p>
    </div>
  )

  if (error) return (
    <div style={styles.centered}>
      <p style={{ color: '#c53030', fontSize: 14 }}>{error}</p>
      <button style={styles.backBtn} onClick={onBack}>← Back</button>
    </div>
  )

  // Support both `first_name/last_name` and legacy `name` column
  const fullName = player
    ? (player.first_name ? `${player.first_name} ${player.last_name ?? ''}`.trim() : player.name || 'Unknown')
    : '?'
  const nameParts = fullName.trim().split(' ')
  const initials  = nameParts.length >= 2
    ? `${nameParts[0][0]}${nameParts[nameParts.length - 1][0]}`.toUpperCase()
    : fullName.slice(0, 2).toUpperCase()
  const playerFirst  = player?.first_name || player?.name?.split(' ')[0] || 'Player'
  const teammateFirst = teammate
    ? (teammate.first_name || teammate.name?.split(' ')[0] || 'Teammate')
    : null
  const teamName = team?.name || (teammateFirst ? `${playerFirst} & ${teammateFirst}` : null)
  const teammateName = teammate
    ? (teammate.first_name ? `${teammate.first_name} ${teammate.last_name ?? ''}`.trim() : teammate.name)
    : null

  // Step 1 — file picked → open crop modal
  function handleAvatarUpload(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setCropFile(file)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // Step 2 — crop confirmed → upload the blob
  async function handleCropConfirm(blob) {
    setCropFile(null)
    if (!player?.id) return
    setAvatarUploading(true)

    const path = `${player.id}/avatar.jpg`
    const { error: uploadErr } = await supabase.storage
      .from('avatars')
      .upload(path, blob, { upsert: true, contentType: 'image/jpeg' })

    if (uploadErr) {
      alert('Upload failed: ' + uploadErr.message)
      setAvatarUploading(false)
      return
    }

    const { data: { publicUrl } } = supabase.storage.from('avatars').getPublicUrl(path)
    const urlWithBust = `${publicUrl}?t=${Date.now()}`
    await supabase.from('players').update({ avatar_url: urlWithBust }).eq('id', player.id)
    setPlayer(prev => ({ ...prev, avatar_url: urlWithBust }))
    setAvatarUploading(false)
  }

  async function handleChangePassword(e) {
    e.preventDefault()
    if (pwForm.next !== pwForm.confirm) {
      setPwMsg({ text: 'New passwords do not match.', type: 'error' }); return
    }
    if (pwForm.next.length < 6) {
      setPwMsg({ text: 'Password must be at least 6 characters.', type: 'error' }); return
    }
    setPwSaving(true)
    setPwMsg(null)
    const { error: authErr } = await supabase.auth.updateUser({ password: pwForm.next })
    if (authErr) {
      setPwMsg({ text: authErr.message, type: 'error' })
      setPwSaving(false)
      return
    }
    // Also update the visible password in the players table
    if (player?.id) {
      await supabase.from('players').update({ league_password: pwForm.next }).eq('id', player.id)
    }
    setPwMsg({ text: 'Password updated successfully!', type: 'success' })
    setPwForm({ current: '', next: '', confirm: '' })
    setPwSaving(false)
  }

  return (
    <>
    <div style={styles.container}>
      {/* Header bar */}
      <div style={styles.header}>
        <button style={styles.headerBack} onClick={onBack}>← Back</button>
        <div style={styles.headerTitle}>My Profile</div>
        <div style={{ width: 52 }} />
      </div>

      <div style={styles.content}>

        {/* ── Player hero card ── */}
        <div style={styles.heroCard}>
          {/* Avatar — tappable to upload on own profile */}
          <div
            style={{
              ...styles.avatar,
              cursor: adminPlayerId ? 'default' : 'pointer',
              overflow: 'hidden',
              position: 'relative',
              padding: 0,
            }}
            onClick={() => !adminPlayerId && fileInputRef.current?.click()}
            title={adminPlayerId ? '' : 'Tap to change photo'}
          >
            {player?.avatar_url ? (
              <img
                src={player.avatar_url}
                alt={fullName}
                style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '50%' }}
              />
            ) : avatarUploading ? (
              <span style={{ fontSize: 14 }}>…</span>
            ) : (
              initials
            )}
            {/* Camera badge — shown on own profile only */}
            {!adminPlayerId && (
              <div style={styles.cameraBadge}>
                {avatarUploading ? '⏳' : '📷'}
              </div>
            )}
          </div>
          {/* Hidden file input */}
          {!adminPlayerId && (
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={handleAvatarUpload}
            />
          )}
          <div style={styles.heroInfo}>
            <div style={styles.heroName}>{fullName}</div>
            {teamName && <div style={styles.heroTeam}>{teamName}</div>}
            <div style={styles.heroBadges}>
              <span style={styles.badge}>⛳ {rounds.length} events played</span>
              {teammateName && <span style={styles.badge}>🤝 {teammateName}</span>}
            </div>
          </div>
        </div>

        {/* ── Stat tiles ── */}
        <div style={styles.tilesRow}>
          <div style={styles.tile}>
            <div style={styles.tileLabel}>HANDICAP</div>
            <div style={styles.tileNum}>{player?.handicap ?? '—'}</div>
            <div style={styles.tileSub}>current</div>
          </div>
          <div style={styles.tile}>
            <div style={styles.tileLabel}>AVG GROSS</div>
            <div style={styles.tileNum}>{avgGross ?? '—'}</div>
            <div style={styles.tileSub}>per 9 holes</div>
          </div>
          <div style={{ ...styles.tile, borderRight: 'none' }}>
            <div style={styles.tileLabel}>AVG NET</div>
            <div style={{ ...styles.tileNum, color: 'var(--green-dark)' }}>{avgNet ?? '—'}</div>
            <div style={styles.tileSub}>per 9 holes</div>
          </div>
        </div>

        {/* ── Season trend chart ── */}
        {rounds.length >= 1 && (
          <div style={styles.card}>
            <div style={styles.cardHeader}>
              <div style={styles.cardTitle}>SEASON TREND</div>
              <div style={styles.metricToggle}>
                {['gross', 'net', 'handicap'].map(m => (
                  <button
                    key={m}
                    style={{ ...styles.metricBtn, ...(trendMetric === m ? styles.metricBtnActive : {}) }}
                    onClick={() => setTrendMetric(m)}
                  >
                    {m.charAt(0).toUpperCase() + m.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <TrendChart rounds={rounds} metric={trendMetric} />
          </div>
        )}

        {/* ── Best & Worst rounds ── */}
        {bestRound && worstRound && bestRound.id !== worstRound.id && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>BEST &amp; WORST ROUNDS</div>
            <div style={styles.bwRow}>
              <div style={styles.bestCard}>
                <div style={styles.bwLabel}>BEST NET</div>
                <div style={styles.bwScore}>{bestRound.net}</div>
                <div style={styles.bwDetail}>
                  {bestRound.eventName} · gross {bestRound.gross}, hdcp {bestRound.handicapUsed ?? '—'}
                </div>
              </div>
              <div style={styles.worstCard}>
                <div style={{ ...styles.bwLabel, color: '#9b2335' }}>WORST NET</div>
                <div style={{ ...styles.bwScore, color: '#c53030' }}>{worstRound.net}</div>
                <div style={{ ...styles.bwDetail, color: '#c53030' }}>
                  {worstRound.eventName} · gross {worstRound.gross}, hdcp {worstRound.handicapUsed ?? '—'}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Scoring by par type ── */}
        {parBreakdown.length > 0 && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>SCORING BY PAR TYPE — SEASON AVERAGE</div>
            <div style={styles.parGrid}>
              {parBreakdown.map(({ par, avg, vsAvg, vsPositive, birdiePct, parPct, bogeyPct, doublePct }) => (
                <div key={par} style={styles.parCard}>
                  <div style={styles.parCardLabel}>Par {par}s</div>
                  <div style={styles.parAvg}>{avg}</div>
                  <div style={{ ...styles.parVs, color: vsPositive ? '#c53030' : 'var(--green)' }}>{vsAvg} avg</div>
                  <div style={styles.parDivider} />
                  {[
                    { label: 'Birdie or better', pct: birdiePct, color: '#16a34a' },
                    { label: 'Par',              pct: parPct,    color: '#22c55e' },
                    { label: 'Bogey',            pct: bogeyPct,  color: '#d97706' },
                    { label: 'Double+',          pct: doublePct, color: '#ef4444' },
                  ].map(({ label, pct, color }) => (
                    <div key={label} style={styles.parRow}>
                      <div style={styles.parRowLabel}>{label}</div>
                      <div style={styles.parRowBar}>
                        <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 3 }} />
                      </div>
                      <div style={styles.parRowPct}>{pct}%</div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Recent rounds ── */}
        {rounds.length > 0 && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>RECENT ROUNDS</div>
            {[...rounds].reverse().slice(0, 8).map(rd => (
              <div key={rd.id} style={styles.roundRow}>
                <div style={styles.roundInfo}>
                  <div style={styles.roundName}>
                    {rd.weekNumber ? `Wk ${rd.weekNumber} — ` : ''}{rd.eventName}
                  </div>
                  <div style={styles.roundDate}>
                    {rd.startDate
                      ? new Date(rd.startDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                      : 'No date'}
                  </div>
                </div>
                <div style={styles.roundScores}>
                  <div style={styles.roundGross}>{rd.gross ?? '—'}</div>
                  <div style={styles.roundNet}>Net {rd.net ?? '—'}</div>
                  <div style={{ ...styles.roundVsPar, color: vsParColor(rd.vsPar) }}>
                    {vsParLabel(rd.vsPar)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {rounds.length === 0 && (
          <div style={styles.empty}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>📭</div>
            <p>No rounds recorded yet. Play your first round to see stats here!</p>
          </div>
        )}

        {/* ── Change Password (only for own profile, not admin view) ── */}
        {!adminPlayerId && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>CHANGE PASSWORD</div>
            <form onSubmit={handleChangePassword} style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                type="password"
                placeholder="New password"
                value={pwForm.next}
                onChange={e => setPwForm(f => ({ ...f, next: e.target.value }))}
                style={styles.pwInput}
                autoComplete="new-password"
                required
              />
              <input
                type="password"
                placeholder="Confirm new password"
                value={pwForm.confirm}
                onChange={e => setPwForm(f => ({ ...f, confirm: e.target.value }))}
                style={styles.pwInput}
                autoComplete="new-password"
                required
              />
              {pwMsg && (
                <div style={{ ...styles.pwMsg, background: pwMsg.type === 'error' ? '#fff5f5' : '#f0fdf4', color: pwMsg.type === 'error' ? '#c53030' : '#166534', border: `1px solid ${pwMsg.type === 'error' ? '#fecaca' : '#bbf7d0'}` }}>
                  {pwMsg.text}
                </div>
              )}
              <button type="submit" style={{ ...styles.pwBtn, opacity: pwSaving ? 0.7 : 1 }} disabled={pwSaving}>
                {pwSaving ? 'Saving…' : 'Update Password'}
              </button>
            </form>
          </div>
        )}

      </div>
    </div>

    {/* Crop modal — portal-style, covers the whole screen */}
    {cropFile && (
      <CropModal
        file={cropFile}
        onConfirm={handleCropConfirm}
        onCancel={() => { setCropFile(null); if (fileInputRef.current) fileInputRef.current.value = '' }}
      />
    )}
    </>
  )
}

const styles = {
  container:   { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--off-white)', overflowY: 'auto' },
  centered:    { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16, padding: 24, textAlign: 'center' },
  header:      { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--green-dark)', color: 'var(--white)', flexShrink: 0 },
  headerBack:  { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: 500, width: 52 },
  headerTitle: { fontSize: 17, fontWeight: 800, color: 'var(--white)' },
  content:     { display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 16px 40px' },
  backBtn:     { padding: '10px 24px', background: 'var(--green)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: 14, fontWeight: 700 },

  // Hero card
  heroCard:    { background: 'var(--green-dark)', borderRadius: 'var(--radius)', padding: '20px 16px', display: 'flex', alignItems: 'center', gap: 14 },
  avatar:      { width: 64, height: 64, borderRadius: '50%', background: 'rgba(255,255,255,0.2)', color: 'var(--white)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 800, flexShrink: 0, border: '2px solid rgba(255,255,255,0.4)' },
  cameraBadge: { position: 'absolute', bottom: 0, right: 0, background: 'var(--green-dark)', border: '2px solid rgba(255,255,255,0.6)', borderRadius: '50%', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, lineHeight: 1 },
  heroInfo:    { flex: 1, minWidth: 0 },
  heroName:    { fontSize: 20, fontWeight: 800, color: 'var(--white)', lineHeight: 1.2 },
  heroTeam:    { fontSize: 13, color: 'rgba(255,255,255,0.65)', marginTop: 2 },
  heroBadges:  { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  badge:       { fontSize: 11, color: 'var(--white)', background: 'rgba(255,255,255,0.15)', borderRadius: 20, padding: '3px 10px', border: '1px solid rgba(255,255,255,0.2)', fontWeight: 500 },

  // Stat tiles
  tilesRow:    { display: 'flex', background: 'var(--white)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)', overflow: 'hidden' },
  tile:        { flex: 1, padding: '16px 8px', textAlign: 'center', borderRight: '1px solid var(--gray-200)' },
  tileLabel:   { fontSize: 9, fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 6 },
  tileNum:     { fontSize: 28, fontWeight: 800, color: 'var(--black)', lineHeight: 1 },
  tileSub:     { fontSize: 10, color: 'var(--gray-400)', marginTop: 4 },

  // Generic card
  card:        { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  cardHeader:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  cardTitle:   { fontSize: 11, fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.5px' },

  // Trend metric toggle
  metricToggle:    { display: 'flex', gap: 4 },
  metricBtn:       { fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 20, background: 'var(--gray-100)', color: 'var(--gray-600)', border: '1px solid var(--gray-200)' },
  metricBtnActive: { background: 'var(--green-dark)', color: 'var(--white)', border: '1px solid var(--green-dark)' },

  // Best & Worst
  bwRow:    { display: 'flex', gap: 10, marginTop: 4 },
  bestCard: { flex: 1, background: '#f0fdf4', borderRadius: 12, padding: '14px 12px', border: '1px solid #bbf7d0' },
  worstCard:{ flex: 1, background: '#fff5f5', borderRadius: 12, padding: '14px 12px', border: '1px solid #fecaca' },
  bwLabel:  { fontSize: 10, fontWeight: 700, color: '#166534', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 },
  bwScore:  { fontSize: 32, fontWeight: 800, color: '#166534', lineHeight: 1 },
  bwDetail: { fontSize: 11, color: '#166534', marginTop: 6, lineHeight: 1.4 },

  // Par type grid
  parGrid:      { display: 'flex', gap: 8, marginTop: 4 },
  parCard:      { flex: 1, background: 'var(--off-white)', borderRadius: 10, padding: '12px 10px', border: '1px solid var(--gray-200)' },
  parCardLabel: { fontSize: 11, fontWeight: 700, color: 'var(--gray-600)', textAlign: 'center', marginBottom: 6 },
  parAvg:       { fontSize: 28, fontWeight: 800, color: '#c53030', textAlign: 'center', lineHeight: 1 },
  parVs:        { fontSize: 11, fontWeight: 600, textAlign: 'center', marginTop: 2, marginBottom: 8 },
  parDivider:   { height: 1, background: 'var(--gray-200)', marginBottom: 8 },
  parRow:       { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 5 },
  parRowLabel:  { fontSize: 9, color: 'var(--gray-600)', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  parRowBar:    { width: 40, height: 5, background: 'var(--gray-200)', borderRadius: 3, overflow: 'hidden', flexShrink: 0 },
  parRowPct:    { fontSize: 9, fontWeight: 700, color: 'var(--gray-600)', width: 22, textAlign: 'right', flexShrink: 0 },

  // Recent rounds
  roundRow:    { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--gray-100)' },
  roundInfo:   { flex: 1 },
  roundName:   { fontSize: 13, fontWeight: 600, color: 'var(--black)' },
  roundDate:   { fontSize: 11, color: 'var(--gray-400)', marginTop: 2 },
  roundScores: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 },
  roundGross:  { fontSize: 18, fontWeight: 800, color: 'var(--black)', lineHeight: 1 },
  roundNet:    { fontSize: 11, color: 'var(--gray-400)' },
  roundVsPar:  { fontSize: 12, fontWeight: 700 },

  empty:       { padding: 32, textAlign: 'center', color: 'var(--gray-400)', fontSize: 14, lineHeight: 1.6 },

  // Change password
  pwInput: { width: '100%', padding: '11px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: 15, background: 'var(--gray-100)', color: 'var(--black)', boxSizing: 'border-box' },
  pwMsg:   { padding: '10px 12px', borderRadius: 'var(--radius-sm)', fontSize: 13, lineHeight: 1.4 },
  pwBtn:   { width: '100%', padding: 13, background: 'var(--green-dark)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
}

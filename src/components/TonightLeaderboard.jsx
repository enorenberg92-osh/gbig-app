import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Tv, Maximize, Check, Clock, Radio, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useLocation } from '../context/LocationContext'
import { buildTonightRows, buildTeamRows, formatToPar } from '../lib/liveUtils'
import { Button, EmptyState, TabGroup } from './ui'

/**
 * TonightLeaderboard  (/league/tonight)
 *
 * Who's in the building tonight: every live card touched today (location
 * timezone) plus scores entered today without a live card. Updates in
 * realtime from live_rounds, with a 30s poll as the fallback (and to pick up
 * approvals, which don't stream).
 *
 * ?tv=1        full-screen lobby mode: large type, clock, wake lock, and it
 *              alternates Players / Teams every 20s
 * ?view=teams  start on (and, in TV mode, stay on) the Teams view
 *
 * Props:
 *   onBack  {func}  - returns to LeagueDashboard
 */
const POLL_MS = 30000
const TV_ROTATE_MS = 20000
const TV_PAGE_MS = 10000
const TV_COLUMN_ROWS = 12     // rows per column on the lobby screen (two columns)
// Wide enough to cover "today" in any US timezone; rows are filtered to the
// location's local date client-side.
const LOOKBACK_MS = 36 * 60 * 60 * 1000

export default function TonightLeaderboard({ onBack }) {
  const { locationId, timezone, appName } = useLocation()
  const [params, setParams] = useSearchParams()
  const tv = params.get('tv') === '1'
  const pinnedView = params.get('view')
  const [view, setView] = useState(pinnedView === 'teams' ? 'teams' : 'players')
  const [rows, setRows] = useState([])
  const [eventName, setEventName] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [updatedAt, setUpdatedAt] = useState(null)
  const [now, setNow] = useState(() => new Date())
  const [tvPage, setTvPage] = useState(0)
  const mounted = useRef(true)

  useEffect(() => () => { mounted.current = false }, [])

  const load = useCallback(async () => {
    if (!locationId) return
    try {
      const since = new Date(Date.now() - LOOKBACK_MS).toISOString()
      const [openRes, liveRes] = await Promise.all([
        supabase.from('events')
          .select('id, name, week_number, course_id')
          .eq('location_id', locationId)
          .eq('status', 'open'),
        supabase.from('live_rounds')
          .select('event_id, player_id, team_id, hole_scores, holes_played, handicap_used, source, bay, updated_at, submitted')
          .eq('location_id', locationId)
          .gte('updated_at', since)
          .order('updated_at', { ascending: false })
          .limit(1000),
      ])
      if (openRes.error || liveRes.error) throw openRes.error || liveRes.error
      const openEvents = openRes.data || []
      const liveRows = liveRes.data || []

      // Tonight's events: the open week(s) plus anything a live card points at
      // (a week published earlier this evening keeps showing until midnight).
      const eventsById = {}
      openEvents.forEach(e => { eventsById[e.id] = e })
      const missing = [...new Set(liveRows.map(r => r.event_id))].filter(id => !eventsById[id])
      if (missing.length) {
        const { data } = await supabase.from('events')
          .select('id, name, week_number, course_id')
          .eq('location_id', locationId)
          .in('id', missing)
        ;(data || []).forEach(e => { eventsById[e.id] = e })
      }
      const eventIds = Object.keys(eventsById)
      if (!eventIds.length) {
        if (mounted.current) { setRows([]); setEventName(''); setLoadError(false); setUpdatedAt(new Date()) }
        return
      }

      const courseIds = [...new Set(Object.values(eventsById).map(e => e.course_id).filter(Boolean))]
      const [scoreRes, courseRes, playerRes, teamRes] = await Promise.all([
        supabase.from('scores')
          .select('event_id, player_id, team_id, hole_scores, handicap_used, status, created_at')
          .eq('location_id', locationId)
          .in('event_id', eventIds)
          .eq('entry_type', 'played')
          .neq('status', 'rejected')
          .limit(2000),
        courseIds.length
          ? supabase.from('courses').select('id, num_holes, hole_pars, stroke_index').in('id', courseIds)
          : Promise.resolve({ data: [] }),
        supabase.from('players').select('id, name').eq('location_id', locationId),
        supabase.from('teams').select('id, name').eq('location_id', locationId),
      ])
      if (scoreRes.error) throw scoreRes.error
      const index = list => Object.fromEntries((list || []).map(x => [x.id, x]))

      const built = buildTonightRows({
        liveRows,
        scoreRows: scoreRes.data || [],
        events: eventsById,
        courses: index(courseRes.data),
        players: index(playerRes.data),
        teams: index(teamRes.data),
        timeZone: timezone,
        now: new Date(),
      })
      if (!mounted.current) return
      setRows(built)
      const shown = openEvents[0] || eventsById[built[0]?.eventId]
      setEventName(shown ? (shown.week_number ? `Week ${shown.week_number}` : shown.name || '') : '')
      setLoadError(false)
      setUpdatedAt(new Date())
    } catch (e) {
      console.error('[TonightLeaderboard] load failed', e)
      if (mounted.current) setLoadError(true)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [locationId, timezone])

  // Initial load + realtime (debounced so a burst of holes is one refetch) +
  // poll fallback. Channel and timers are torn down on unmount.
  useEffect(() => {
    if (!locationId) return undefined
    let debounce = null
    const reloadSoon = () => { clearTimeout(debounce); debounce = setTimeout(load, 400) }
    const channel = supabase
      .channel(`tonight-live-${locationId}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'live_rounds', filter: `location_id=eq.${locationId}` },
        reloadSoon)
      .subscribe()
    const poll = setInterval(load, POLL_MS)
    load()
    return () => {
      clearTimeout(debounce)
      clearInterval(poll)
      supabase.removeChannel(channel)
    }
  }, [locationId, load])

  // TV: clock, view rotation, and keep the screen awake (best effort).
  useEffect(() => {
    if (!tv) return undefined
    const clock = setInterval(() => setNow(new Date()), 15000)
    const rotate = pinnedView ? null : setInterval(() => setView(v => (v === 'players' ? 'teams' : 'players')), TV_ROTATE_MS)
    let lock = null
    const requestLock = async () => {
      try { lock = await navigator.wakeLock?.request('screen') } catch { /* unsupported / denied */ }
    }
    const onVisibility = () => { if (document.visibilityState === 'visible') requestLock() }
    requestLock()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(clock)
      if (rotate) clearInterval(rotate)
      document.removeEventListener('visibilitychange', onVisibility)
      try { lock?.release() } catch { /* already released */ }
    }
  }, [tv, pinnedView])

  const playingCount = rows.filter(r => r.status === 'live' && r.thru > 0).length
  const list = view === 'teams' ? buildTeamRows(rows) : rows
  const positions = positionLabels(list)
  const s = tv ? tvStyles : styles

  // TV pages through long boards: two columns of TV_COLUMN_ROWS per page.
  const tvPageSize = TV_COLUMN_ROWS * 2
  const tvPages = Math.max(1, Math.ceil(list.length / tvPageSize))
  useEffect(() => {
    if (!tv || tvPages < 2) { setTvPage(0); return undefined }
    const t = setInterval(() => setTvPage(p => (p + 1) % tvPages), TV_PAGE_MS)
    return () => clearInterval(t)
  }, [tv, tvPages, view])
  const page = Math.min(tvPage, tvPages - 1)

  const enterTv = () => setParams(p => { const next = new URLSearchParams(p); next.set('tv', '1'); return next })
  const exitTv = () => {
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {})
    setParams(p => { const next = new URLSearchParams(p); next.delete('tv'); return next })
  }
  const goFullscreen = () => document.documentElement.requestFullscreen?.().catch(() => {})

  const body = loading ? (
    <p style={s.muted}>Loading tonight's scores…</p>
  ) : list.length === 0 ? (
    <EmptyState
      icon={<Radio size={tv ? 64 : 40} strokeWidth={1.5} />}
      title="No one's on the course yet tonight"
      description="Scores show up here hole by hole as players enter them."
      style={tv ? { color: 'rgba(255,255,255,0.7)' } : undefined}
    />
  ) : (
    tv ? (
      <div style={tvStyles.columns}>
        {[0, 1].map(col => {
          const start = page * tvPageSize + col * TV_COLUMN_ROWS
          const slice = list.slice(start, start + TV_COLUMN_ROWS)
          if (!slice.length && col > 0) return null
          return (
            <div key={col} style={{ flex: 1, minWidth: 0 }}>
              <Board list={slice} positions={positions.slice(start)} view={view} s={s} tv />
            </div>
          )
        })}
      </div>
    ) : (
      <Board list={list} positions={positions} view={view} s={s} tv={false} />
    )
  )

  if (tv) {
    return (
      <div style={tvStyles.screen}>
        <LiveDotKeyframes />
        <div style={tvStyles.top}>
          <div>
            <div style={tvStyles.title}>
              {playingCount > 0 && <LiveDot size={18} />}
              Tonight{eventName ? ` · ${eventName}` : ''}
            </div>
            <div style={tvStyles.subtitle}>
              {appName} · {view === 'teams' ? 'Teams (net)' : 'Players (net)'}
              {playingCount > 0 ? ` · ${playingCount} on the course` : ''}
              {tvPages > 1 ? ` · page ${page + 1}/${tvPages}` : ''}
            </div>
          </div>
          <div style={tvStyles.topRight}>
            <div style={tvStyles.clock}>
              {now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone })}
            </div>
            <div style={tvStyles.controls}>
              {!document.fullscreenElement && document.documentElement.requestFullscreen && (
                <button style={tvStyles.ctrlBtn} onClick={goFullscreen} title="Full screen"><Maximize size={18} /></button>
              )}
              <button style={tvStyles.ctrlBtn} onClick={exitTv} title="Exit TV mode"><X size={18} /></button>
            </div>
          </div>
        </div>
        <div style={tvStyles.boardWrap}>{body}</div>
        {loadError && <div style={tvStyles.stale}>Reconnecting…</div>}
      </div>
    )
  }

  return (
    <div style={styles.container}>
      <LiveDotKeyframes />
      <div style={styles.header}>
        <button style={styles.headerBack} onClick={onBack}>← Back</button>
        <div style={styles.headerCenter}>
          <div style={styles.headerTitle}>Tonight{eventName ? ` · ${eventName}` : ''}</div>
          <div style={styles.headerSub}>
            {playingCount > 0 ? <><LiveDot size={7} /> {playingCount} on the course</> : 'Live leaderboard'}
          </div>
        </div>
        <div style={{ width: 52 }} />
      </div>

      <div style={styles.content}>
        <TabGroup
          options={[{ id: 'players', label: 'Players' }, { id: 'teams', label: 'Teams' }]}
          value={view}
          onChange={setView}
          style={{ marginBottom: 12 }}
        />
        <div style={styles.card}>{body}</div>
        <div style={styles.footer}>
          <span style={styles.muted}>
            {loadError
              ? 'Having trouble updating — retrying…'
              : updatedAt ? `Net to par over holes played · updated ${updatedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone })}` : ''}
          </span>
          <Button variant="secondary" size="sm" icon={<Tv size={14} strokeWidth={2.25} />} onClick={enterTv}>
            TV mode
          </Button>
        </div>
      </div>
    </div>
  )
}

// ── Board ──────────────────────────────────────────────────────────
function Board({ list, positions, view, s, tv }) {
  const head = { fontSize: 'inherit', fontWeight: 'inherit', color: 'inherit' }
  return (
    <div>
      <div style={{ ...s.row, ...s.headRow }}>
        <span style={{ ...s.pos, ...head }}>#</span>
        <span style={{ ...s.name, ...head }}>{view === 'teams' ? 'Team' : 'Player'}</span>
        <span style={{ ...s.num, ...head }}>Thru</span>
        <span style={{ ...s.num, ...head }}>Gross</span>
        <span style={{ ...s.num, ...head }}>Net</span>
        <span style={s.status}></span>
      </div>
      {list.map((r, i) => (
        <div key={r.key} style={{ ...s.row, ...(i % 2 ? s.rowAlt : null) }}>
          <span style={s.pos}>{r.netToPar == null ? '' : positions[i]}</span>
          <span style={s.name}>
            <span style={s.nameMain}>{r.name}</span>
            <span style={s.nameSub}>
              {view === 'teams'
                ? r.members.map(m => m.name.split(' ')[0]).join(' · ')
                : [r.teamName, r.bay ? `Bay ${r.bay}` : null].filter(Boolean).join(' · ')}
            </span>
          </span>
          <span style={s.num}>{r.finished ? 'F' : r.thru || '—'}</span>
          <span style={s.num}>{r.gross ?? '—'}</span>
          <span style={{ ...s.num, ...s.net, color: toParColor(r.netToPar, tv) }}>{formatToPar(r.netToPar)}</span>
          <span style={s.status}><StatusChip status={r.status} tv={tv} /></span>
        </div>
      ))}
    </div>
  )
}

function StatusChip({ status, tv }) {
  const size = tv ? 18 : 12
  if (status === 'live') {
    return <span style={{ ...chip.base, ...(tv ? chip.tv : null), color: tv ? '#b7e4c7' : 'var(--green-dark)' }}><LiveDot size={tv ? 12 : 7} /> Live</span>
  }
  if (status === 'approved') {
    return <span style={{ ...chip.base, ...(tv ? chip.tv : null), color: tv ? '#b7e4c7' : 'var(--green)' }}><Check size={size} strokeWidth={2.5} /> Final</span>
  }
  return <span style={{ ...chip.base, ...(tv ? chip.tv : null), color: tv ? '#fde68a' : '#92400e' }}><Clock size={size} strokeWidth={2.25} /> Submitted</span>
}

// Pulsing green dot used here and on the dashboard banner.
export function LiveDot({ size = 8, color = '#22c55e' }) {
  return (
    <span style={{
      display: 'inline-block', width: size, height: size, borderRadius: '50%',
      background: color, boxShadow: `0 0 0 0 ${color}`, flexShrink: 0,
      animation: 'liveDotPulse 1.6s ease-out infinite', verticalAlign: 'middle',
    }} />
  )
}

export function LiveDotKeyframes() {
  return (
    <style>{`@keyframes liveDotPulse {
      0% { box-shadow: 0 0 0 0 rgba(34,197,94,0.55); }
      70% { box-shadow: 0 0 0 8px rgba(34,197,94,0); }
      100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
    }`}</style>
  )
}

// "1, T2, T2, 4" — ties share a position.
function positionLabels(list) {
  const out = []
  list.forEach((r, i) => {
    const first = list.findIndex(x => x.netToPar === r.netToPar)
    const tied = list.filter(x => x.netToPar === r.netToPar).length > 1
    out[i] = `${tied ? 'T' : ''}${first + 1}`
  })
  return out
}

function toParColor(n, tv) {
  if (n == null) return tv ? 'rgba(255,255,255,0.5)' : 'var(--gray-400)'
  if (n < 0) return tv ? '#95d5b2' : 'var(--green)'
  if (n > 0) return tv ? '#fca5a5' : '#c53030'
  return tv ? '#fff' : 'var(--black)'
}

const chip = {
  base: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' },
  tv:   { fontSize: 'clamp(14px, 1.4vw, 22px)', gap: 8 },
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--off-white)', overflowY: 'auto' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--green-dark)', color: 'var(--white)', flexShrink: 0 },
  headerBack: { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: 500, width: 52, textAlign: 'left' },
  headerCenter: { flex: 1, textAlign: 'center' },
  headerTitle: { fontSize: 16, fontWeight: 800, color: 'var(--white)' },
  headerSub: { fontSize: 11, color: 'rgba(255,255,255,0.7)', marginTop: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 },
  content: { padding: '14px 16px 32px' },
  card: { background: 'var(--white)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)', overflow: 'hidden' },
  footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 12 },
  muted: { fontSize: 12, color: 'var(--gray-400)', padding: 16, margin: 0 },

  row: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderTop: '1px solid var(--gray-100)' },
  headRow: { borderTop: 'none', background: 'var(--gray-100)', fontSize: 10, fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.4px', paddingTop: 8, paddingBottom: 8 },
  rowAlt: {},
  pos: { width: 26, fontSize: 13, fontWeight: 700, color: 'var(--gray-500)', flexShrink: 0 },
  name: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  nameMain: { fontSize: 14, fontWeight: 700, color: 'var(--black)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  nameSub: { fontSize: 11, color: 'var(--gray-400)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  num: { width: 38, textAlign: 'center', fontSize: 13, fontWeight: 600, color: 'var(--gray-600)', flexShrink: 0 },
  net: { fontSize: 16, fontWeight: 800 },
  status: { width: 76, display: 'flex', justifyContent: 'flex-end', flexShrink: 0 },
}

// Lobby screen: sized off the viewport so it reads from across the room.
const tvStyles = {
  screen: { position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--green-dark)', color: '#fff', display: 'flex', flexDirection: 'column', padding: 'clamp(16px, 2.5vw, 40px)', boxSizing: 'border-box', overflow: 'hidden' },
  top: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, marginBottom: 'clamp(12px, 2vw, 28px)' },
  title: { fontSize: 'clamp(28px, 4vw, 64px)', fontWeight: 800, letterSpacing: '-0.5px', display: 'flex', alignItems: 'center', gap: 16, lineHeight: 1.1 },
  subtitle: { fontSize: 'clamp(14px, 1.6vw, 26px)', color: 'rgba(255,255,255,0.7)', marginTop: 6 },
  topRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 },
  clock: { fontSize: 'clamp(24px, 3vw, 48px)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' },
  controls: { display: 'flex', gap: 8, opacity: 0.6 },
  ctrlBtn: { color: '#fff', background: 'rgba(255,255,255,0.12)', borderRadius: 8, padding: 8, display: 'flex', cursor: 'pointer' },
  boardWrap: { flex: 1, overflow: 'hidden', background: 'rgba(0,0,0,0.18)', borderRadius: 16 },
  columns: { display: 'flex', gap: 'clamp(12px, 2vw, 32px)', height: '100%' },
  stale: { position: 'absolute', bottom: 12, right: 20, fontSize: 14, color: 'rgba(255,255,255,0.6)' },
  muted: { fontSize: 'clamp(16px, 2vw, 28px)', color: 'rgba(255,255,255,0.7)', padding: 32, margin: 0 },

  row: { display: 'flex', alignItems: 'center', gap: 'clamp(8px, 1.5vw, 24px)', padding: 'clamp(8px, 1.1vw, 18px) clamp(12px, 2vw, 32px)', borderTop: '1px solid rgba(255,255,255,0.08)' },
  headRow: { borderTop: 'none', fontSize: 'clamp(12px, 1.2vw, 20px)', fontWeight: 700, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: '1px' },
  rowAlt: { background: 'rgba(255,255,255,0.04)' },
  pos: { width: '3.2em', fontSize: 'clamp(18px, 2.2vw, 36px)', fontWeight: 700, color: 'rgba(255,255,255,0.6)', flexShrink: 0 },
  name: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' },
  nameMain: { fontSize: 'clamp(20px, 2.6vw, 44px)', fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  nameSub: { fontSize: 'clamp(12px, 1.3vw, 22px)', color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  num: { width: '4.2em', textAlign: 'center', fontSize: 'clamp(18px, 2.2vw, 36px)', fontWeight: 700, color: 'rgba(255,255,255,0.85)', flexShrink: 0, fontVariantNumeric: 'tabular-nums' },
  net: { fontSize: 'clamp(22px, 2.8vw, 48px)', fontWeight: 800 },
  status: { width: '7em', display: 'flex', justifyContent: 'flex-end', flexShrink: 0, fontSize: 'clamp(14px, 1.4vw, 22px)' },
}

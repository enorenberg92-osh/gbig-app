import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import AdminDashboard from './AdminDashboard'
import AdminScores    from './AdminScores'
import AdminPlayers   from './AdminPlayers'
import AdminSchedule  from './AdminSchedule'
import AdminCourses   from './AdminCourses'
import AdminSubs      from './AdminSubs'
import AdminAlerts    from './AdminAlerts'
import AdminSkins     from './AdminSkins'
import AdminHandicap  from './AdminHandicap'
import AdminLeague    from './AdminLeague'
import AdminStandings from './AdminStandings'

const SECTIONS = [
  { id: 'dashboard',  label: 'Overview',     emoji: '📊' },
  { id: 'scores',     label: 'Scores',       emoji: '⛳' },
  { id: 'standings',  label: 'Standings',    emoji: '🏅' },
  { id: 'players',    label: 'Players',      emoji: '👥' },
  { id: 'league',     label: 'Leagues',      emoji: '🏆' },
  { id: 'handicap',   label: 'Handicap',     emoji: '🏌️' },
  { id: 'schedule',   label: 'Schedule',     emoji: '📅' },
  { id: 'subs',       label: 'Subs',         emoji: '🔄' },
  { id: 'courses',    label: 'Courses',      emoji: '🗺️' },
  { id: 'skins',      label: 'Skins',        emoji: '🎯' },
  { id: 'alerts',     label: 'Alerts',       emoji: '🔔' },
]

export default function AdminPanel({ session, onBack }) {
  const [activeSection, setActiveSection] = useState('dashboard')
  const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= 768)

  // ── Shared active event across all tabs ──────────────────────────────────
  const [activeEventId, setActiveEventId]   = useState(null)
  const [activeEventLabel, setActiveEventLabel] = useState(null)
  const [allEvents, setAllEvents]           = useState([])

  useEffect(() => {
    loadActiveEvent()
  }, [])

  async function loadActiveEvent() {
    // Fetch all playable events
    const { data: evts } = await supabase
      .from('events')
      .select('id, name, week_number, status, start_date, is_bye')
      .order('week_number', { ascending: true, nullsFirst: false })
    const playable = (evts || []).filter(e => !e.is_bye)
    setAllEvents(playable)

    // Default: the open event, then the first upcoming, then week 1
    const open = playable.find(e => e.status === 'open')
    const today = new Date(); today.setHours(0,0,0,0)
    const upcoming = !open && playable.find(e => e.start_date && new Date(e.start_date + 'T00:00:00') > today)
    const chosen = open || upcoming || playable[0]
    if (chosen) {
      setActiveEventId(chosen.id)
      setActiveEventLabel(chosen.week_number != null ? `Wk ${chosen.week_number}` : chosen.name || 'Event')
    }
  }

  // Called by children when they change the week selector or a week is closed
  function handleEventChange(eventId) {
    setActiveEventId(eventId)
    const evt = allEvents.find(e => e.id === eventId)
    if (evt) setActiveEventLabel(evt.week_number != null ? `Wk ${evt.week_number}` : evt.name || 'Event')
  }

  // Called by AdminDashboard after closing a week (new open event id passed in)
  function handleWeekClosed(newEventId) {
    // Refresh event list then switch to the newly-opened event
    loadActiveEvent().then(() => {
      if (newEventId) handleEventChange(newEventId)
    })
  }

  useEffect(() => {
    const handle = () => setIsDesktop(window.innerWidth >= 768)
    window.addEventListener('resize', handle)
    return () => window.removeEventListener('resize', handle)
  }, [])

  const renderSection = () => {
    switch (activeSection) {
      case 'dashboard': return <AdminDashboard onWeekClosed={handleWeekClosed} />
      case 'scores':    return <AdminScores    activeEventId={activeEventId} onEventChange={handleEventChange} />
      case 'players':   return <AdminPlayers />
      case 'league':    return <AdminLeague />
      case 'handicap':  return <AdminHandicap />
      case 'subs':      return <AdminSubs />
      case 'schedule':  return <AdminSchedule />
      case 'courses':   return <AdminCourses />
      case 'skins':     return <AdminSkins     activeEventId={activeEventId} onEventChange={handleEventChange} />
      case 'alerts':    return <AdminAlerts />
      case 'standings': return <AdminStandings session={session} />
      default:          return <AdminDashboard onWeekClosed={handleWeekClosed} />
    }
  }

  const current = SECTIONS.find(s => s.id === activeSection) || SECTIONS[0]

  // ── DESKTOP LAYOUT ──────────────────────────────────────────────────────
  if (isDesktop) {
    return (
      <div style={ds.shell}>
        {/* Left sidebar */}
        <div style={ds.sidebar}>
          {/* Sidebar header */}
          <div style={ds.sidebarTop}>
            <div style={ds.sidebarLogo}>⛳</div>
            <div>
              <div style={ds.sidebarTitle}>GBIG Admin</div>
              <div style={ds.sidebarSub}>League Management</div>
            </div>
          </div>

          {/* Nav items */}
          <nav style={ds.nav}>
            {SECTIONS.map(({ id, label, emoji }) => {
              const active = activeSection === id
              return (
                <button
                  key={id}
                  style={{
                    ...ds.navItem,
                    background: active ? 'rgba(255,255,255,0.15)' : 'transparent',
                    color: active ? '#fff' : 'rgba(255,255,255,0.65)',
                    fontWeight: active ? 700 : 400,
                    borderLeft: active ? '3px solid #fff' : '3px solid transparent',
                  }}
                  onClick={() => setActiveSection(id)}
                >
                  <span style={ds.navEmoji}>{emoji}</span>
                  <span>{label}</span>
                </button>
              )
            })}
          </nav>

          {/* Back button at bottom */}
          <div style={ds.sidebarFooter}>
            <button style={ds.backBtn} onClick={onBack}>
              ← Back to League
            </button>
          </div>
        </div>

        {/* Main content area */}
        <div style={ds.main}>
          {/* Top bar */}
          <div style={ds.topBar}>
            <span style={ds.topBarEmoji}>{current.emoji}</span>
            <h1 style={ds.topBarTitle}>{current.label}</h1>
            {activeEventLabel && (
              <div style={ds.activeWeekPill}>
                🟢 {activeEventLabel} active
              </div>
            )}
          </div>

          {/* Scrollable content */}
          <div style={ds.content}>
            {renderSection()}
          </div>
        </div>
      </div>
    )
  }

  // ── MOBILE LAYOUT (original) ─────────────────────────────────────────────
  return (
    <div style={ms.container}>
      {/* Admin Header */}
      <div style={ms.header}>
        <button style={ms.backBtn} onClick={onBack}>
          ← League
        </button>
        <div style={ms.headerCenter}>
          <span style={ms.headerEmoji}>{current.emoji}</span>
          <span style={ms.headerTitle}>Admin — {current.label}</span>
        </div>
        {activeEventLabel
          ? <div style={ms.activeWeekPill}>🟢 {activeEventLabel}</div>
          : <div style={{ width: 60 }} />
        }
      </div>

      {/* Horizontal scrolling section nav */}
      <div style={ms.navScroll}>
        <div style={ms.navInner}>
          {SECTIONS.map(({ id, label, emoji }) => {
            const active = activeSection === id
            return (
              <button
                key={id}
                style={{
                  ...ms.navChip,
                  background: active ? 'var(--green)' : 'var(--white)',
                  color:      active ? 'var(--white)' : 'var(--gray-600)',
                  border:     active ? '1.5px solid var(--green)' : '1.5px solid var(--gray-200)',
                  fontWeight: active ? 700 : 400,
                }}
                onClick={() => setActiveSection(id)}
              >
                {emoji} {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Section Content */}
      <div style={ms.content}>
        {renderSection()}
      </div>
    </div>
  )
}

// ── Desktop styles ──────────────────────────────────────────────────────────
const ds = {
  shell: {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
    display: 'flex',
    background: 'var(--off-white)',
    fontFamily: 'inherit',
  },
  sidebar: {
    width: '230px',
    flexShrink: 0,
    background: 'var(--green-dark)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  sidebarTop: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '22px 20px 18px',
    borderBottom: '1px solid rgba(255,255,255,0.12)',
  },
  sidebarLogo: {
    fontSize: '28px',
    lineHeight: 1,
  },
  sidebarTitle: {
    fontSize: '15px',
    fontWeight: 800,
    color: '#fff',
    letterSpacing: '0.3px',
  },
  sidebarSub: {
    fontSize: '11px',
    color: 'rgba(255,255,255,0.55)',
    marginTop: '2px',
    letterSpacing: '0.2px',
  },
  nav: {
    flex: 1,
    overflowY: 'auto',
    padding: '12px 0',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  navItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '11px 20px',
    fontSize: '14px',
    textAlign: 'left',
    cursor: 'pointer',
    transition: 'all 0.12s ease',
    borderRadius: '0',
    width: '100%',
    letterSpacing: '0.1px',
  },
  navEmoji: {
    fontSize: '16px',
    width: '22px',
    textAlign: 'center',
    flexShrink: 0,
  },
  sidebarFooter: {
    padding: '16px 20px',
    borderTop: '1px solid rgba(255,255,255,0.12)',
  },
  backBtn: {
    fontSize: '13px',
    color: 'rgba(255,255,255,0.70)',
    fontWeight: 500,
    padding: '8px 0',
    width: '100%',
    textAlign: 'left',
    cursor: 'pointer',
    letterSpacing: '0.1px',
  },
  main: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    overflow: 'hidden',
  },
  topBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '16px 28px',
    background: '#fff',
    borderBottom: '1px solid var(--gray-200)',
    flexShrink: 0,
    boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
  },
  topBarEmoji: {
    fontSize: '22px',
  },
  topBarTitle: {
    fontSize: '20px',
    fontWeight: 800,
    color: 'var(--green-dark)',
    letterSpacing: '-0.2px',
    margin: 0,
  },
  content: {
    flex: 1,
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
    padding: '0',
  },
  activeWeekPill: {
    marginLeft: 'auto',
    fontSize: '12px',
    fontWeight: 700,
    color: 'var(--green-dark)',
    background: 'var(--green-xlight)',
    padding: '5px 12px',
    borderRadius: '20px',
    border: '1px solid var(--green)',
    whiteSpace: 'nowrap',
  },
}

// ── Mobile styles ───────────────────────────────────────────────────────────
const ms = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: 'var(--off-white)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '12px 16px',
    background: 'var(--green-dark)',
    color: 'var(--white)',
    flexShrink: 0,
  },
  backBtn: {
    color: 'rgba(255,255,255,0.80)',
    fontSize: '13px',
    fontWeight: 500,
    padding: '4px 0',
    width: 60,
    textAlign: 'left',
    flexShrink: 0,
  },
  activeWeekPill: {
    fontSize: '10px',
    fontWeight: 700,
    color: 'var(--green-dark)',
    background: 'rgba(255,255,255,0.9)',
    padding: '3px 8px',
    borderRadius: '12px',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  headerCenter: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  headerEmoji: { fontSize: '18px' },
  headerTitle: {
    fontSize: '15px',
    fontWeight: 700,
    letterSpacing: '0.2px',
  },
  navScroll: {
    overflowX: 'auto',
    flexShrink: 0,
    background: 'var(--white)',
    borderBottom: '1px solid var(--gray-200)',
    WebkitOverflowScrolling: 'touch',
    scrollbarWidth: 'none',
  },
  navInner: {
    display: 'flex',
    gap: '8px',
    padding: '10px 14px',
    width: 'max-content',
  },
  navChip: {
    padding: '6px 14px',
    borderRadius: '20px',
    fontSize: '13px',
    whiteSpace: 'nowrap',
    transition: 'all 0.15s ease',
  },
  content: {
    flex: 1,
    overflowY: 'auto',
    WebkitOverflowScrolling: 'touch',
  },
}

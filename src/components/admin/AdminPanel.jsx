import React, { useState, useEffect } from 'react'
import { Routes, Route, Navigate, useLocation as useRouterLocation, useNavigate } from 'react-router-dom'
import {
  LayoutDashboard, Flag, Medal, Users, Trophy, Activity,
  Calendar, Repeat2, Map, Target, Bell,
} from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
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
  { id: 'dashboard',  label: 'Overview',     Icon: LayoutDashboard },
  { id: 'scores',     label: 'Scores',       Icon: Flag },
  { id: 'standings',  label: 'Standings',    Icon: Medal },
  { id: 'players',    label: 'Players',      Icon: Users },
  { id: 'league',     label: 'Leagues',      Icon: Trophy },
  { id: 'handicap',   label: 'Handicap',     Icon: Activity },
  { id: 'schedule',   label: 'Schedule',     Icon: Calendar },
  { id: 'subs',       label: 'Subs',         Icon: Repeat2 },
  { id: 'courses',    label: 'Courses',      Icon: Map },
  { id: 'skins',      label: 'Skins',        Icon: Target },
  { id: 'alerts',     label: 'Alerts',       Icon: Bell },
]

// Derive the active section id from /league/admin/<section>. Anything that
// isn't a known section (or the bare /league/admin) falls back to 'dashboard'
// so the UI always has a sensible current tab to highlight.
function sectionFromPath(pathname) {
  const m = pathname.match(/\/league\/admin\/?([^/?#]*)/)
  const id = m && m[1] ? m[1] : 'dashboard'
  return SECTIONS.some(s => s.id === id) ? id : 'dashboard'
}

export default function AdminPanel({ session, onBack }) {
  const { locationId, appName } = useLocation()
  const routerLocation = useRouterLocation()
  const navigate = useNavigate()
  const activeSection = sectionFromPath(routerLocation.pathname)

  const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= 768)

  // ── Shared active event across all tabs ──────────────────────────────────
  const [activeEventId, setActiveEventId]       = useState(null)
  const [activeEventLabel, setActiveEventLabel] = useState(null)
  const [allEvents, setAllEvents]               = useState([])

  useEffect(() => {
    loadActiveEvent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadActiveEvent() {
    // Fetch all playable events for this location
    const { data: evts } = await supabase
      .from('events')
      .select('id, name, week_number, status, start_date, is_bye')
      .eq('location_id', locationId)
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

  // Navigate to a section. Guard against clicks on the already-active tab so
  // we don't push duplicate history entries for repeat clicks.
  function goToSection(id) {
    if (id !== activeSection) navigate('/league/admin/' + id)
  }

  useEffect(() => {
    const handle = () => setIsDesktop(window.innerWidth >= 768)
    window.addEventListener('resize', handle)
    return () => window.removeEventListener('resize', handle)
  }, [])

  // Centralised route table — rendered inside the main content pane for both
  // desktop and mobile layouts. The index route keeps /league/admin (no
  // trailing segment) landing on the dashboard, and the catch-all rewrites
  // unknown sub-paths back to the dashboard so we never get stuck on a
  // blank admin screen.
  const sectionRoutes = (
    <Routes>
      <Route index             element={<AdminDashboard onWeekClosed={handleWeekClosed} />} />
      <Route path="dashboard"  element={<AdminDashboard onWeekClosed={handleWeekClosed} />} />
      <Route path="scores"     element={<AdminScores    activeEventId={activeEventId} onEventChange={handleEventChange} />} />
      <Route path="standings"  element={<AdminStandings session={session} />} />
      <Route path="players/*"  element={<AdminPlayers />} />
      <Route path="league"     element={<AdminLeague />} />
      <Route path="handicap"   element={<AdminHandicap />} />
      <Route path="schedule"   element={<AdminSchedule />} />
      <Route path="subs"       element={<AdminSubs />} />
      <Route path="courses"    element={<AdminCourses />} />
      <Route path="skins"      element={<AdminSkins     activeEventId={activeEventId} onEventChange={handleEventChange} />} />
      <Route path="alerts"     element={<AdminAlerts />} />
      <Route path="*"          element={<Navigate to="/league/admin/dashboard" replace />} />
    </Routes>
  )

  const current = SECTIONS.find(s => s.id === activeSection) || SECTIONS[0]
  const CurrentIcon = current.Icon

  // ── DESKTOP LAYOUT ──────────────────────────────────────────────────────
  if (isDesktop) {
    return (
      <div style={ds.shell}>
        {/* Left sidebar */}
        <div style={ds.sidebar}>
          {/* Sidebar header */}
          <div style={ds.sidebarTop}>
            <div style={ds.sidebarLogo}>
              <Flag size={26} strokeWidth={2} color="var(--gold)" />
            </div>
            <div>
              <div style={ds.sidebarTitle}>{appName} Admin</div>
              <div style={ds.sidebarSub}>League Management</div>
            </div>
          </div>

          {/* Nav items */}
          <nav style={ds.nav}>
            {SECTIONS.map(({ id, label, Icon }) => {
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
                  onClick={() => goToSection(id)}
                >
                  <span style={ds.navIcon}>
                    <Icon size={17} strokeWidth={active ? 2.25 : 1.75} />
                  </span>
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
            <span style={ds.topBarIcon}>
              <CurrentIcon size={22} strokeWidth={2} color="var(--green-dark)" />
            </span>
            <h1 style={ds.topBarTitle}>{current.label}</h1>
            {activeEventLabel && (
              <div style={ds.activeWeekPill}>
                <span style={ds.statusDot} />
                {activeEventLabel} active
              </div>
            )}
          </div>

          {/* Scrollable content */}
          <div style={ds.content}>
            {sectionRoutes}
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
          <span style={ms.headerIcon}>
            <CurrentIcon size={18} strokeWidth={2} color="#fff" />
          </span>
          <span style={ms.headerTitle}>Admin — {current.label}</span>
        </div>
        {activeEventLabel
          ? (
            <div style={ms.activeWeekPill}>
              <span style={ms.statusDot} />
              {activeEventLabel}
            </div>
          )
          : <div style={{ width: 60 }} />
        }
      </div>

      {/* Horizontal scrolling section nav */}
      <div style={ms.navScroll}>
        <div style={ms.navInner}>
          {SECTIONS.map(({ id, label, Icon }) => {
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
                onClick={() => goToSection(id)}
              >
                <Icon size={14} strokeWidth={2} style={{ verticalAlign: '-2px', marginRight: 5 }} />
                {label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Section Content */}
      <div style={ms.content}>
        {sectionRoutes}
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
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '40px',
    height: '40px',
    borderRadius: '10px',
    background: 'rgba(255,255,255,0.08)',
    flexShrink: 0,
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
  navIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
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
  topBarIcon: {
    display: 'flex',
    alignItems: 'center',
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
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    fontWeight: 700,
    color: 'var(--green-dark)',
    background: 'var(--green-xlight)',
    padding: '5px 12px',
    borderRadius: '20px',
    border: '1px solid var(--green)',
    whiteSpace: 'nowrap',
  },
  statusDot: {
    display: 'inline-block',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: 'var(--green)',
    boxShadow: '0 0 0 2px rgba(45,106,79,0.18)',
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
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    fontSize: '10px',
    fontWeight: 700,
    color: 'var(--green-dark)',
    background: 'rgba(255,255,255,0.9)',
    padding: '3px 8px',
    borderRadius: '12px',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  statusDot: {
    display: 'inline-block',
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: 'var(--green)',
  },
  headerCenter: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  headerIcon: { display: 'flex', alignItems: 'center' },
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

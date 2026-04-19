import React, { useState, useEffect } from 'react'
import { Routes, Route, Navigate, useLocation as useRouterLocation, useNavigate } from 'react-router-dom'
import { supabase } from './lib/supabase'
import { useLocation } from './context/LocationContext'

// Pages
import ReservationsPage from './pages/ReservationsPage'
import LeaguePage from './pages/LeaguePage'
import EventsPage from './pages/EventsPage'
import AlertsPage from './pages/AlertsPage'

// Icons (inline SVGs for zero-dependency)
const Icons = {
  Reservations: ({ size = 22 }) => (
    <svg width={size} height={size} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  ),
  League: ({ size = 22 }) => (
    <svg width={size} height={size} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  ),
  Events: ({ size = 22 }) => (
    <svg width={size} height={size} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
    </svg>
  ),
  Alerts: ({ size = 22 }) => (
    <svg width={size} height={size} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 01-3.46 0" />
    </svg>
  ),
}

const TABS = [
  { id: 'reservations', label: 'Reservations', Icon: Icons.Reservations },
  { id: 'league',       label: 'League',       Icon: Icons.League },
  { id: 'events',       label: 'Events',       Icon: Icons.Events },
  { id: 'alerts',       label: 'Alerts',       Icon: Icons.Alerts },
]

// ─── Splash Screen ───────────────────────────────────────────────
function SplashScreen({ onDone, appFullName }) {
  const [phase, setPhase] = useState('in') // 'in' | 'out'

  useEffect(() => {
    // Hold for 1.8s then fade out
    const holdTimer = setTimeout(() => setPhase('out'), 1800)
    // Tell parent we're done after fade-out completes (0.5s)
    const doneTimer = setTimeout(() => onDone(), 2300)
    return () => { clearTimeout(holdTimer); clearTimeout(doneTimer) }
  }, [onDone])

  return (
    <div style={{
      ...splash.screen,
      animation: phase === 'out' ? 'splashFadeOut 0.5s ease forwards' : undefined,
    }}>
      {/* Full wordmark logo — white on the deep-green splash gradient */}
      <img
        src="/logo-full-white.png"
        alt={appFullName}
        style={splash.wordmark}
      />

      {/* Gold divider line */}
      <div style={splash.line} />

      {/* Tagline */}
      <p style={splash.sub}>Tee Time Reservations &amp; League Play</p>
    </div>
  )
}

const splash = {
  screen: {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    background: 'linear-gradient(160deg, #1b4332 0%, #1a3d2b 50%, #0d2618 100%)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
  },
  wordmark: {
    display: 'block',
    width: 'min(72vw, 320px)',
    height: 'auto',
    marginBottom: '10px',
    filter: 'drop-shadow(0 6px 24px rgba(0,0,0,0.35))',
    animation: 'splashLogoIn 0.7s cubic-bezier(0.34, 1.56, 0.64, 1) 0.1s both',
  },
  line: {
    height: '2px',
    background: 'linear-gradient(90deg, transparent, #c9a84c, transparent)',
    borderRadius: '2px',
    marginTop: '14px',
    marginBottom: '10px',
    animation: 'splashLineIn 0.5s ease 1.0s both',
  },
  sub: {
    fontFamily: "'Playfair Display', Georgia, serif",
    fontSize: '12px',
    color: 'rgba(232,201,106,0.6)',
    letterSpacing: '2.5px',
    textTransform: 'uppercase',
    animation: 'splashSubIn 0.6s ease 1.1s both',
  },
}

// Derive which bottom tab is active from the current URL path.
// Sub-routes like /league/standings should still highlight the League tab.
function activeTabFromPath(pathname) {
  if (pathname.startsWith('/reservations')) return 'reservations'
  if (pathname.startsWith('/league'))       return 'league'
  if (pathname.startsWith('/events'))       return 'events'
  if (pathname.startsWith('/alerts'))       return 'alerts'
  if (pathname.startsWith('/admin'))        return 'league' // admin lives under the league tab
  return 'reservations'
}

// ─── Main App ────────────────────────────────────────────────────
export default function App() {
  const { locationId, appName, appFullName } = useLocation()
  const routerLoc                   = useRouterLocation()
  const navigate                    = useNavigate()
  const [session, setSession]       = useState(null)
  const [loading, setLoading]       = useState(true)
  const [splashDone, setSplashDone] = useState(false)
  const [leagueName, setLeagueName] = useState('')

  const activeTab = activeTabFromPath(routerLoc.pathname)

  useEffect(() => {
    if (!locationId) return
    supabase.from('league_config').select('name')
      .eq('location_id', locationId).eq('is_active', true).limit(1).single()
      .then(({ data }) => { if (data?.name) setLeagueName(data.name) })
  }, [locationId])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
    })
    return () => subscription.unsubscribe()
  }, [])

  const isReservations = activeTab === 'reservations'

  // Show splash until both auth is resolved AND splash animation is done
  const showSplash = loading || !splashDone

  return (
    <>
      {/* Splash — renders on top of the app shell while loading */}
      {showSplash && <SplashScreen onDone={() => setSplashDone(true)} appFullName={appFullName} />}

      {/* App Shell (rendered in background while splash plays) */}
      <div style={styles.appShell}>

        {/* Header */}
        {isReservations ? (
          <header style={styles.headerGold}>
            <div style={styles.headerGoldInner}>
              <span style={styles.headerGoldFlag}>
                <img
                  src="/logo-icon-white.png"
                  alt=""
                  aria-hidden="true"
                  style={styles.headerGoldFlagImg}
                />
              </span>
              <div style={styles.headerGoldTextWrap}>
                <span style={styles.headerGoldTitle}>Reservations</span>
                <span style={styles.headerGoldSub}>{appName}</span>
              </div>
            </div>
          </header>
        ) : (
          <header style={styles.header}>
            <div style={styles.headerInner}>
              <span style={styles.headerLogo}>
                <img
                  src="/logo-icon-white.png"
                  alt=""
                  aria-hidden="true"
                  style={styles.headerLogoImg}
                />
              </span>
              <div style={styles.headerTitleWrap}>
                <span style={styles.headerTitle}>{appName}</span>
                {leagueName ? <span style={styles.headerLeague}>{leagueName}</span> : null}
              </div>
              {session && (
                <button
                  style={styles.signOutBtn}
                  onClick={() => supabase.auth.signOut()}
                  title="Sign out"
                >
                  <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>
                </button>
              )}
            </div>
          </header>
        )}

        {/* Page Content */}
        <main style={styles.main}>
          <Routes>
            <Route path="/"              element={<Navigate to="/reservations" replace />} />
            <Route path="/reservations"  element={<ReservationsPage />} />
            <Route path="/league/*"      element={<LeaguePage session={session} />} />
            <Route path="/events"        element={<EventsPage />} />
            <Route path="/alerts"        element={<AlertsPage session={session} />} />
            {/* Fallback for unknown URLs */}
            <Route path="*"              element={<Navigate to="/reservations" replace />} />
          </Routes>
        </main>

        {/* Bottom Tab Bar */}
        <nav style={styles.tabBar}>
          {TABS.map(({ id, label, Icon }) => {
            const isActive = activeTab === id
            const isRes    = id === 'reservations'
            const activeColor = isRes ? '#b8860b' : 'var(--green)'
            const activeBg    = isRes ? '#fef3c7' : 'var(--green-xlight)'
            return (
              <button
                key={id}
                style={{
                  ...styles.tabItem,
                  color: isActive ? activeColor : 'var(--gray-400)',
                }}
                onClick={() => {
                  // Avoid pushing a duplicate entry if we're already on this tab's root route
                  if (!isActive) navigate('/' + id)
                }}
              >
                <span style={{
                  ...styles.tabIconWrap,
                  backgroundColor: isActive ? activeBg : 'transparent',
                  transform: isActive ? 'scale(1.05)' : 'scale(1)',
                }}>
                  <Icon size={22} />
                </span>
                <span style={{
                  ...styles.tabLabel,
                  fontFamily: "'Playfair Display', Georgia, serif",
                  fontWeight: isActive ? 700 : 400,
                  color: isActive ? activeColor : 'var(--gray-400)',
                }}>
                  {label}
                </span>
              </button>
            )
          })}
        </nav>

      </div>
    </>
  )
}

const styles = {
  appShell: {
    display: 'flex',
    flexDirection: 'column',
    height: '100dvh',
    width: '100%',
    maxWidth: '480px',
    margin: '0 auto',
    background: 'var(--white)',
    position: 'relative',
    boxShadow: '0 0 40px rgba(0,0,0,0.15)',
  },
  // ── Standard green header (non-Reservations tabs) ──────────────
  header: {
    height: 'var(--header-height)',
    background: 'var(--green-dark)',
    color: 'var(--white)',
    flexShrink: 0,
    zIndex: 10,
    boxShadow: '0 2px 8px rgba(0,0,0,0.20)',
  },
  headerInner: {
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    padding: '0 16px',
    gap: '10px',
  },
  headerLogo: { display: 'flex', alignItems: 'center', flexShrink: 0 },
  headerLogoImg: {
    width: '28px',
    height: '28px',
    objectFit: 'contain',
    filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.35))',
  },
  headerTitleWrap: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
  },
  headerTitle: {
    fontFamily: "'Playfair Display', Georgia, serif",
    fontSize: '16px',
    fontWeight: 600,
    letterSpacing: '0.3px',
    lineHeight: 1.2,
    color: 'var(--white)',
  },
  headerLeague: {
    fontSize: '11px',
    fontWeight: 500,
    color: 'rgba(255,255,255,0.65)',
    letterSpacing: '0.2px',
    lineHeight: 1.2,
  },
  signOutBtn: {
    color: 'rgba(255,255,255,0.75)',
    padding: '6px',
    borderRadius: '8px',
    display: 'flex',
    alignItems: 'center',
  },
  // ── Gold Reservations header ────────────────────────────────────
  headerGold: {
    height: 'var(--header-height)',
    background: 'linear-gradient(135deg, #1a3d2b 0%, #1e4d35 60%, #2d6a4f 100%)',
    flexShrink: 0,
    zIndex: 10,
    boxShadow: '0 2px 12px rgba(0,0,0,0.25)',
    borderBottom: '3px solid #c9a84c',
  },
  headerGoldInner: {
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    padding: '0 18px',
    gap: '12px',
  },
  headerGoldFlag: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.3))',
  },
  headerGoldFlagImg: {
    width: '34px',
    height: '34px',
    objectFit: 'contain',
  },
  headerGoldTextWrap: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
  },
  headerGoldTitle: {
    fontFamily: "'Playfair Display', Georgia, serif",
    fontSize: '22px',
    fontWeight: 600,
    color: '#e8c96a',
    letterSpacing: '0.5px',
    lineHeight: 1.15,
    textShadow: '0 1px 4px rgba(0,0,0,0.3)',
  },
  headerGoldSub: {
    fontFamily: "'Playfair Display', Georgia, serif",
    fontSize: '11px',
    fontWeight: 500,
    color: 'rgba(232,201,106,0.65)',
    letterSpacing: '1.2px',
    textTransform: 'uppercase',
    lineHeight: 1.2,
  },
  // ── Main content area ───────────────────────────────────────────
  main: {
    flex: 1,
    overflowY: 'auto',
    overflowX: 'hidden',
    WebkitOverflowScrolling: 'touch',
  },
  // ── Bottom tab bar ──────────────────────────────────────────────
  tabBar: {
    height: 'var(--tab-height)',
    display: 'flex',
    background: 'var(--white)',
    borderTop: '1.5px solid var(--gray-200)',
    boxShadow: '0 -2px 12px rgba(0,0,0,0.06)',
    flexShrink: 0,
    zIndex: 10,
    paddingBottom: 'env(safe-area-inset-bottom)',
  },
  tabItem: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '3px',
    transition: 'color 0.2s ease',
    padding: '6px 0',
  },
  tabIconWrap: {
    padding: '4px 14px',
    borderRadius: '20px',
    transition: 'background-color 0.2s ease, transform 0.2s ease',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabLabel: {
    fontSize: '10px',
    letterSpacing: '0.2px',
    transition: 'color 0.2s ease',
  },
}

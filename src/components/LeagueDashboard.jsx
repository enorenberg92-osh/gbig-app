import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useIsAdmin } from '../hooks/useIsAdmin'
import AdminPanel from './admin/AdminPanel'
import ScoreEntry from './ScoreEntry'
import Standings from './Standings'
import PlayerProfile from './PlayerProfile'
import SubRequest from './SubRequest'
import FriendsTab from './FriendsTab'

export default function LeagueDashboard({ session }) {
  const { isAdmin, checking } = useIsAdmin(session)
  const [showAdmin, setShowAdmin]           = useState(false)
  const [showScoreEntry, setShowScoreEntry] = useState(false)
  const [showStandings, setShowStandings]   = useState(false)
  const [showProfile, setShowProfile]       = useState(false)
  const [showSubRequest, setShowSubRequest] = useState(false)
  const [showFriends, setShowFriends]       = useState(false)
  const [activeRound, setActiveRound]       = useState(null)
  const [roundChecked, setRoundChecked]     = useState(false)

  const email = session?.user?.email || 'Player'

  useEffect(() => {
    async function checkRound() {
      const today = new Date().toISOString().split('T')[0]
      const { data } = await supabase
        .from('events')
        .select('id, name, week_number')
        .eq('status', 'open')
        .lte('start_date', today)
        .gte('end_date', today)
        .limit(1)
        .single()
      setActiveRound(data || null)
      setRoundChecked(true)
    }
    checkRound()
  }, [])

  if (showAdmin && isAdmin)  return <AdminPanel    session={session} onBack={() => setShowAdmin(false)} />
  if (showScoreEntry)        return <ScoreEntry    session={session} onBack={() => setShowScoreEntry(false)} />
  if (showStandings)         return <Standings     session={session} onBack={() => setShowStandings(false)} />
  if (showProfile)           return <PlayerProfile  session={session} onBack={() => setShowProfile(false)} />
  if (showSubRequest)        return <SubRequest    session={session} onBack={() => setShowSubRequest(false)} />
  if (showFriends)           return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '12px 16px', background: 'var(--green-dark)', flexShrink: 0 }}>
        <button style={{ color: 'rgba(255,255,255,0.8)', fontSize: '13px', fontWeight: 500, cursor: 'pointer' }} onClick={() => setShowFriends(false)}>← Back</button>
        <div style={{ flex: 1, textAlign: 'center', fontSize: '17px', fontWeight: 800, color: '#fff', marginRight: '52px' }}>Friends</div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <FriendsTab session={session} />
      </div>
    </div>
  )

  const tiles = [
    { emoji: '🏆', label: 'Standings',    action: () => setShowStandings(true)  },
    { emoji: '👤', label: 'My Profile',   action: () => setShowProfile(true)    },
    { emoji: '🔄', label: 'Request Sub',  action: () => setShowSubRequest(true) },
    { emoji: '👥', label: 'Friends',      action: () => setShowFriends(true)    },
  ]

  return (
    <div style={styles.container}>

      {/* Welcome bar */}
      <div style={styles.welcome}>
        <div style={styles.avatar}>{email[0].toUpperCase()}</div>
        <div style={styles.welcomeText}>
          <p style={styles.welcomeLabel}>Welcome back!</p>
          <p style={styles.welcomeEmail}>{email}</p>
        </div>
        {!checking && isAdmin && (
          <button style={styles.adminBadge} onClick={() => setShowAdmin(true)}>
            ⚙️ Admin
          </button>
        )}
      </div>

      {/* My Scores — full-width featured banner */}
      {roundChecked && (
        <button
          style={{
            ...styles.scoresBanner,
            background: activeRound ? 'var(--green-dark)' : 'var(--gray-100)',
            cursor: activeRound ? 'pointer' : 'default',
          }}
          onClick={activeRound ? () => setShowScoreEntry(true) : undefined}
          disabled={!activeRound}
        >
          <span style={styles.scoresBannerEmoji}>{activeRound ? '⛳' : '🔒'}</span>
          <div style={styles.scoresBannerText}>
            <span style={{ ...styles.scoresBannerTitle, color: activeRound ? '#fff' : 'var(--gray-500)' }}>
              {activeRound ? `Week ${activeRound.week_number} — Submit Scores` : 'No active round this week'}
            </span>
            <span style={{ ...styles.scoresBannerSub, color: activeRound ? 'rgba(255,255,255,0.7)' : 'var(--gray-400)' }}>
              {activeRound ? 'Tap to enter your scores' : 'Check back when your next round begins'}
            </span>
          </div>
          {activeRound && <span style={styles.scoresBannerArrow}>›</span>}
        </button>
      )}

      {/* 2×2 tile grid */}
      <div style={styles.grid}>
        {tiles.map(({ emoji, label, action, soon }) => (
          <button
            key={label}
            style={{ ...styles.tile, ...(soon ? styles.tileDimmed : {}) }}
            disabled={soon || !action}
            onClick={action || undefined}
          >
            <span style={styles.tileEmoji}>{emoji}</span>
            <span style={styles.tileLabel}>{label}</span>
            {soon && <span style={styles.comingSoon}>Soon</span>}
          </button>
        ))}
      </div>

      {isAdmin && (
        <button style={styles.adminPanelBtn} onClick={() => setShowAdmin(true)}>
          ⚙️ Open Admin Panel
        </button>
      )}

      <p style={styles.note}>League season in progress! 🏌️</p>
    </div>
  )
}

const styles = {
  container:   { padding: '20px 16px 32px' },

  welcome: {
    display: 'flex', alignItems: 'center', gap: '14px',
    background: 'var(--white)', borderRadius: 'var(--radius)',
    padding: '14px 16px', marginBottom: '14px',
    boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)',
  },
  avatar:       { width: '44px', height: '44px', background: 'var(--green)', color: '#fff', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px', fontWeight: 700, flexShrink: 0 },
  welcomeText:  { flex: 1 },
  welcomeLabel: { fontSize: '12px', color: 'var(--gray-400)' },
  welcomeEmail: { fontSize: '14px', fontWeight: 600, color: 'var(--black)', wordBreak: 'break-all' },
  adminBadge:   { background: 'var(--green-dark)', color: '#fff', padding: '6px 12px', borderRadius: '20px', fontSize: '12px', fontWeight: 700, flexShrink: 0, whiteSpace: 'nowrap', cursor: 'pointer' },

  scoresBanner: {
    display: 'flex', alignItems: 'center', gap: '12px',
    width: '100%', padding: '14px 16px', marginBottom: '14px',
    borderRadius: 'var(--radius)', border: 'none', textAlign: 'left',
    boxSizing: 'border-box', boxShadow: 'var(--shadow)',
  },
  scoresBannerEmoji: { fontSize: '26px', flexShrink: 0 },
  scoresBannerText:  { flex: 1, display: 'flex', flexDirection: 'column', gap: '3px' },
  scoresBannerTitle: { fontSize: '14px', fontWeight: 700 },
  scoresBannerSub:   { fontSize: '12px' },
  scoresBannerArrow: { fontSize: '22px', color: 'rgba(255,255,255,0.5)', flexShrink: 0 },

  grid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr',
    gap: '12px', marginBottom: '16px',
  },
  tile: {
    background: 'var(--white)', border: '1px solid var(--gray-200)',
    borderRadius: 'var(--radius)', padding: '24px 16px',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: '10px', boxShadow: 'var(--shadow)', position: 'relative',
    cursor: 'pointer',
  },
  tileDimmed:  { opacity: 0.55 },
  tileEmoji:   { fontSize: '32px' },
  tileLabel:   { fontSize: '14px', fontWeight: 600, color: 'var(--green-dark)' },
  comingSoon: {
    position: 'absolute', top: '8px', right: '8px',
    background: '#fff8e1', color: '#7a5c00',
    fontSize: '9px', fontWeight: 700, padding: '2px 6px',
    borderRadius: '20px', textTransform: 'uppercase', letterSpacing: '0.4px',
  },

  adminPanelBtn: {
    width: '100%', padding: '13px', background: 'var(--green-dark)',
    color: '#fff', borderRadius: 'var(--radius-sm)', fontSize: '14px',
    fontWeight: 700, marginBottom: '16px', cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
  },
  note: { textAlign: 'center', fontSize: '13px', color: 'var(--gray-400)' },
}

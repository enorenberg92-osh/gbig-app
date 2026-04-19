import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Trophy, User, Repeat2, Users, Flag, Lock, Shield } from 'lucide-react'
import { Button, StatTile } from './ui'

export default function LeagueDashboard({
  session,
  isAdmin = false,
  adminChecking = false,
  activeRound = null,
  roundChecked = false,
}) {
  const navigate = useNavigate()
  const email = session?.user?.email || 'Player'

  const tiles = [
    { Icon: Trophy,  label: 'Standings',    path: '/league/standings'   },
    { Icon: User,    label: 'My Profile',   path: '/league/profile'     },
    { Icon: Repeat2, label: 'Request Sub',  path: '/league/sub-request' },
    { Icon: Users,   label: 'Friends',      path: '/league/friends'     },
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
        {!adminChecking && isAdmin && (
          <button style={styles.adminBadge} onClick={() => navigate('/league/admin')}>
            <Shield size={14} strokeWidth={2.25} style={{ marginRight: 4, verticalAlign: '-2px' }} />
            Admin
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
          onClick={activeRound ? () => navigate('/league/score-entry') : undefined}
          disabled={!activeRound}
        >
          <span style={styles.scoresBannerIcon}>
            {activeRound
              ? <Flag size={26} strokeWidth={2} color="#fff" />
              : <Lock size={24} strokeWidth={2} color="var(--gray-500)" />}
          </span>
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
        {tiles.map(({ Icon, label, path, soon }) => (
          <StatTile
            key={label}
            size="md"
            icon={<Icon size={30} strokeWidth={1.75} color="var(--green)" />}
            label={label}
            onClick={soon ? null : () => navigate(path)}
            disabled={!!soon}
            badge={soon ? 'Soon' : null}
          />
        ))}
      </div>

      {isAdmin && (
        <Button
          variant="primary"
          size="lg"
          fullWidth
          icon={<Shield size={16} strokeWidth={2.25} />}
          onClick={() => navigate('/league/admin')}
          style={{
            background: 'var(--green-dark)',
            borderColor: 'var(--green-dark)',
            marginBottom: '16px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          }}
        >
          Open Admin Panel
        </Button>
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
  scoresBannerIcon:  { display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  scoresBannerText:  { flex: 1, display: 'flex', flexDirection: 'column', gap: '3px' },
  scoresBannerTitle: { fontSize: '14px', fontWeight: 700 },
  scoresBannerSub:   { fontSize: '12px' },
  scoresBannerArrow: { fontSize: '22px', color: 'rgba(255,255,255,0.5)', flexShrink: 0 },

  grid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr',
    gap: '12px', marginBottom: '16px',
  },
  note: { textAlign: 'center', fontSize: '13px', color: 'var(--gray-400)' },
}

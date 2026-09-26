import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Trophy, User, Repeat2, Users, Flag, Lock, Shield, Radio, MapPin } from 'lucide-react'
import { Button, StatTile } from './ui'
import { useFeature } from '../context/FeatureContext'
import { useLocation } from '../context/LocationContext'
import { supabase } from '../lib/supabase'
import { isPlayingNow, isTodayAt } from '../lib/liveUtils'
import { LiveDot, LiveDotKeyframes } from './TonightLeaderboard'
import { bayName } from '../lib/bayUtils'

export default function LeagueDashboard({
  session,
  isAdmin = false,
  adminChecking = false,
  activeRound = null,
  roundChecked = false,
}) {
  const navigate = useNavigate()
  const friendsEnabled = useFeature('friends')
  const subsEnabled = useFeature('subs')
  const email = session?.user?.email || 'Player'
  const tonight = useTonightActivity()
  const checkin = useMyCheckin(!!activeRound)

  const tiles = [
    { Icon: Trophy,  label: 'Standings',    path: '/league/standings'   },
    { Icon: User,    label: 'My Profile',   path: '/league/profile'     },
    { Icon: Repeat2, label: 'Request Sub',  path: '/league/sub-request', enabled: subsEnabled },
    { Icon: Users,   label: 'Friends',      path: '/league/friends', enabled: friendsEnabled },
  ].filter(tile => tile.enabled !== false)

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

      {/* Bay check-in — first thing on league night. Hidden when the player
          isn't rostered this week (or before the migration is applied). */}
      {activeRound && checkin?.status === 'ok' && (
        checkin.bay ? (
          <div style={styles.bayOn}>
            <MapPin size={24} strokeWidth={2.25} color="var(--green)" />
            <div style={styles.scoresBannerText}>
              <span style={styles.bayOnTitle}>You're on {bayName(checkin.bay.label)}</span>
              <span style={styles.tonightSub}>{checkin.team?.name}</span>
            </div>
            <button style={styles.bayOnLink} onClick={() => navigate('/league/checkin')}>
              Change / Check out
            </button>
          </div>
        ) : (
          <button className="ui-pressable" style={styles.checkinBtn} onClick={() => navigate('/league/checkin')}>
            <MapPin size={26} strokeWidth={2.25} color="var(--green-dark)" />
            <div style={styles.scoresBannerText}>
              <span style={styles.checkinTitle}>Check in to a bay</span>
              <span style={styles.checkinSub}>One tap checks in {checkin.team?.name || 'your team'}</span>
            </div>
            <span style={{ ...styles.scoresBannerArrow, color: 'var(--green-dark)' }}>›</span>
          </button>
        )
      )}

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

      {/* Tonight's leaderboard — live dot while anyone is mid-round */}
      {(activeRound || tonight.today > 0) && (
        <button style={styles.tonightBanner} onClick={() => navigate('/league/tonight')}>
          <LiveDotKeyframes />
          <span style={styles.tonightIcon}>
            {tonight.playing > 0
              ? <LiveDot size={12} />
              : <Radio size={20} strokeWidth={2} color="var(--green)" />}
          </span>
          <div style={styles.scoresBannerText}>
            <span style={styles.tonightTitle}>Tonight's leaderboard</span>
            <span style={styles.tonightSub}>
              {tonight.playing > 0
                ? `${tonight.playing} playing now · live hole-by-hole`
                : tonight.today > 0
                  ? `${tonight.today} played today`
                  : 'Scores appear live as players enter them'}
            </span>
          </div>
          <span style={{ ...styles.scoresBannerArrow, color: 'var(--gray-400)' }}>›</span>
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

// The player's team and bay this week (my_checkin_status). Refreshes every
// 30s and when the app comes back to the foreground; null on any error so
// the banner simply hides.
function useMyCheckin(enabled) {
  const { locationId } = useLocation()
  const [status, setStatus] = useState(null)
  useEffect(() => {
    if (!locationId || !enabled) { setStatus(null); return undefined }
    let cancelled = false
    const load = async () => {
      const { data, error } = await supabase.rpc('my_checkin_status', { p_location_id: locationId })
      if (!cancelled) setStatus(error ? null : data)
    }
    load()
    const t = setInterval(load, 30000)
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { cancelled = true; clearInterval(t); document.removeEventListener('visibilitychange', onVisible) }
  }, [locationId, enabled])
  return status
}

// Lightweight count of today's live cards for the banner (refreshes every
// minute; the leaderboard itself is realtime).
function useTonightActivity() {
  const { locationId, timezone } = useLocation()
  const [activity, setActivity] = useState({ playing: 0, today: 0 })
  useEffect(() => {
    if (!locationId) return undefined
    let cancelled = false
    const load = async () => {
      const since = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString()
      const { data } = await supabase
        .from('live_rounds')
        .select('updated_at, holes_played, submitted')
        .eq('location_id', locationId)
        .gte('updated_at', since)
        .limit(500)
      if (cancelled || !data) return
      const now = new Date()
      setActivity({
        playing: data.filter(r => isPlayingNow(r, timezone, now)).length,
        today: data.filter(r => r.holes_played > 0 && isTodayAt(r.updated_at, timezone, now)).length,
      })
    }
    load()
    const t = setInterval(load, 60000)
    return () => { cancelled = true; clearInterval(t) }
  }, [locationId, timezone])
  return activity
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

  tonightBanner: {
    display: 'flex', alignItems: 'center', gap: '12px',
    width: '100%', padding: '12px 16px', marginBottom: '14px',
    borderRadius: 'var(--radius)', border: '1px solid var(--gray-200)', textAlign: 'left',
    boxSizing: 'border-box', boxShadow: 'var(--shadow)', background: 'var(--white)', cursor: 'pointer',
  },
  checkinBtn: {
    display: 'flex', alignItems: 'center', gap: '12px',
    width: '100%', minHeight: '72px', padding: '14px 16px', marginBottom: '14px',
    borderRadius: 'var(--radius)', border: 'none', textAlign: 'left',
    boxSizing: 'border-box', boxShadow: 'var(--shadow)', background: 'var(--gold)', cursor: 'pointer',
  },
  checkinTitle: { fontSize: '17px', fontWeight: 800, color: 'var(--green-dark)' },
  checkinSub:   { fontSize: '12px', color: 'var(--green-dark)', opacity: 0.8 },
  bayOn: {
    display: 'flex', alignItems: 'center', gap: '12px',
    width: '100%', padding: '12px 16px', marginBottom: '14px',
    borderRadius: 'var(--radius)', border: '2px solid var(--green)', background: 'var(--green-xlight)',
    boxSizing: 'border-box', boxShadow: 'var(--shadow)',
  },
  bayOnTitle: { fontSize: '17px', fontWeight: 800, color: 'var(--green-dark)' },
  bayOnLink:  { fontSize: '12px', fontWeight: 600, color: 'var(--green-dark)', textDecoration: 'underline', padding: '8px 0 8px 8px', cursor: 'pointer', flexShrink: 0 },

  tonightIcon:  { width: '26px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  tonightTitle: { fontSize: '14px', fontWeight: 700, color: 'var(--green-dark)' },
  tonightSub:   { fontSize: '12px', color: 'var(--gray-500)' },

  grid: {
    display: 'grid', gridTemplateColumns: '1fr 1fr',
    gap: '12px', marginBottom: '16px',
  },
  note: { textAlign: 'center', fontSize: '13px', color: 'var(--gray-400)' },
}

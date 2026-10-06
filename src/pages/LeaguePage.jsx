import React, { useState, useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate, useLocation as useRouterLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useLocation } from '../context/LocationContext'
import { useIsAdmin } from '../hooks/useIsAdmin'
import LoginScreen from '../components/LoginScreen'
import LeagueDashboard from '../components/LeagueDashboard'
import ScoreEntry from '../components/ScoreEntry'
import Standings from '../components/Standings'
import PlayerProfile from '../components/PlayerProfile'
import SubRequest from '../components/SubRequest'
import FriendsTab from '../components/FriendsTab'
import AdminPanel from '../components/admin/AdminPanel'
import { useFeature } from '../context/FeatureContext'
import { loadActiveRound } from '../lib/leagueUtils'

export default function LeaguePage({ session }) {
  return session ? <AuthenticatedLeaguePage key={session.user.id} session={session} /> : <LoginScreen />
}

function AuthenticatedLeaguePage({ session }) {
  const { locationId } = useLocation()
  const { isAdmin, checking } = useIsAdmin(session)
  const navigate = useNavigate()
  const { pathname } = useRouterLocation()
  const subsEnabled = useFeature('subs')
  const friendsEnabled = useFeature('friends')

  // Active-round lookup is lifted here so both the hub (to enable/disable the
  // "Submit Scores" banner) and the /score-entry route guard can share it.
  const [activeRound, setActiveRound]   = useState(null)
  const [roundChecked, setRoundChecked] = useState(false)
  const [roundError, setRoundError] = useState(null)
  const [roundRetry, setRoundRetry] = useState(0)
  const atHub = pathname === '/league' || pathname === '/league/'

  useEffect(() => {
    if (!locationId) return
    if (!atHub && roundChecked) return
    let cancelled = false
    setRoundError(null)
    setRoundChecked(false)
    // Refresh on return to the hub, including after a staff closeout.
    loadActiveRound(supabase, locationId).then(data => {
        if (cancelled) return
        setActiveRound(data)
        setRoundChecked(true)
      }).catch(error => {
        if (cancelled) return
        setActiveRound(null)
        setRoundError(error.message || 'This week could not be loaded.')
        setRoundChecked(true)
      })
    return () => { cancelled = true }
  }, [locationId, roundRetry, atHub])

  const backToHub = () => navigate('/league')
  const retryRound = () => { setRoundChecked(false); setRoundRetry(n=>n+1) }

  return (
    <Routes>
      <Route
        index
        element={
          <LeagueDashboard
            session={session}
            isAdmin={isAdmin}
            adminChecking={checking}
            activeRound={activeRound}
            roundChecked={roundChecked}
            roundError={roundError}
            onRoundRetry={retryRound}
          />
        }
      />

      {/* Score entry — gated behind an active round. Deep-linking to
          /league/score-entry when no round is open bounces back to the hub. */}
      <Route
        path="score-entry"
        element={
          !roundChecked
            ? null
            : roundError
              ? <div style={{padding:24}}><p role="alert">This week could not be loaded: {roundError}</p><button onClick={retryRound}>Try again</button></div>
            : !activeRound
              ? <Navigate to="/league" replace />
              : <ScoreEntry key={`${session.user.id}:${locationId}`} session={session} onBack={backToHub} />
        }
      />

      <Route path="standings"   element={<Standings   session={session} onBack={backToHub} />} />
      <Route path="profile"     element={<PlayerProfile session={session} onBack={backToHub} />} />
      <Route path="sub-request" element={subsEnabled ? <SubRequest session={session} onBack={backToHub} /> : <Navigate to="/league" replace />} />

      {/* Friends currently has no internal header/back button — wrap it. */}
      <Route path="friends"     element={friendsEnabled ? <FriendsScreen session={session} onBack={backToHub} /> : <Navigate to="/league" replace />} />

      {/* Admin — gated. Non-admins bounce to the hub. Wait for the role
          check to resolve before deciding so we don't flash a redirect. */}
      <Route
        path="admin/*"
        element={
          checking
            ? null
            : isAdmin
              ? <AdminPanel session={session} onBack={backToHub} />
              : <Navigate to="/league" replace />
        }
      />

      {/* Unknown /league/* URLs bounce to the hub */}
      <Route path="*" element={<Navigate to="/league" replace />} />
    </Routes>
  )
}

// ─── Friends screen wrapper ──────────────────────────────────────
// FriendsTab doesn't ship with its own header, so we keep the thin
// top bar that used to live inline in LeagueDashboard.
function FriendsScreen({ session, onBack }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '12px 16px', background: 'var(--green-dark)', flexShrink: 0,
      }}>
        <button
          style={{ color: 'rgba(255,255,255,0.8)', fontSize: '13px', fontWeight: 500, cursor: 'pointer' }}
          onClick={onBack}
        >
          ← Back
        </button>
        <div style={{
          flex: 1, textAlign: 'center', fontSize: '17px', fontWeight: 800,
          color: '#fff', marginRight: '52px',
        }}>
          Friends
        </div>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <FriendsTab session={session} />
      </div>
    </div>
  )
}

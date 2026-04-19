import React, { useState, useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
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

export default function LeaguePage({ session }) {
  // Auth gate — unauthenticated users get the login screen
  if (!session) return <LoginScreen />

  const { locationId } = useLocation()
  const { isAdmin, checking } = useIsAdmin(session)
  const navigate = useNavigate()

  // Active-round lookup is lifted here so both the hub (to enable/disable the
  // "Submit Scores" banner) and the /score-entry route guard can share it.
  const [activeRound, setActiveRound]   = useState(null)
  const [roundChecked, setRoundChecked] = useState(false)

  useEffect(() => {
    if (!locationId) return
    // Status is the single source of truth. An event is active iff an
    // admin has opened it. We intentionally don't filter by start_date /
    // end_date so admins can schedule events weeks in advance and flip
    // them open on their own timeline, independent of calendar dates.
    supabase
      .from('events')
      .select('id, name, week_number')
      .eq('location_id', locationId)
      .eq('status', 'open')
      .order('week_number', { ascending: true })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        setActiveRound(data || null)
        setRoundChecked(true)
      })
  }, [locationId])

  const backToHub = () => navigate('/league')

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
            : !activeRound
              ? <Navigate to="/league" replace />
              : <ScoreEntry session={session} onBack={backToHub} />
        }
      />

      <Route path="standings"   element={<Standings   session={session} onBack={backToHub} />} />
      <Route path="profile"     element={<PlayerProfile session={session} onBack={backToHub} />} />
      <Route path="sub-request" element={<SubRequest  session={session} onBack={backToHub} />} />

      {/* Friends currently has no internal header/back button — wrap it. */}
      <Route path="friends"     element={<FriendsScreen session={session} onBack={backToHub} />} />

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

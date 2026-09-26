import React, { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CheckCircle2, Plus, LogOut, RefreshCw, MapPin } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useLocation } from '../context/LocationContext'
import { Toast, Callout, EmptyState } from './ui'
import {
  bayName, findBayByLabel, occupantNames, playerDisplayName, checkinErrorMessage,
} from '../lib/bayUtils'

/**
 * BayCheckIn  (/league/checkin)
 *
 * League-night bay turnover is ~90 seconds, so this is one tap for the whole
 * team: the caller's team comes from the roster server-side (checkin_team).
 *
 *   ?bay=3   (QR code on the bay) one confirm screen with one big button
 *   no bay   a grid of big bay buttons — tapping one checks in
 *
 * After check-in: the bay, teammates, anyone else on the bay, and "Also check
 * in Team B?" chips for teams we often share a bay with (one tap each).
 *
 * Props:
 *   onBack  {func}  - returns to LeagueDashboard
 */
const POLL_MS = 20000

export default function BayCheckIn({ onBack }) {
  const { locationId } = useLocation()
  const [params, setParams] = useSearchParams()
  const bayParam = params.get('bay')

  const [status, setStatus]   = useState(null)   // my_checkin_status
  const [board, setBoard]     = useState(null)   // bay_board
  const [result, setResult]   = useState(null)   // last checkin_team response
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [busy, setBusy]       = useState(null)   // bay id / team id being sent
  const [changing, setChanging] = useState(false)
  const [toast, setToast]     = useState(null)
  const mounted = useRef(true)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => { if (mounted.current) setToast(null) }, 3000)
  }

  const load = useCallback(async () => {
    if (!locationId) return
    const [statusRes, boardRes] = await Promise.all([
      supabase.rpc('my_checkin_status', { p_location_id: locationId }),
      supabase.rpc('bay_board', { p_location_id: locationId }),
    ])
    if (!mounted.current) return
    const err = statusRes.error || boardRes.error
    if (err) {
      console.error('[BayCheckIn] load failed', err)
      setLoadError(checkinErrorMessage(err))
    } else {
      setStatus(statusRes.data)
      setBoard(boardRes.data)
      setLoadError(null)
    }
    setLoading(false)
  }, [locationId])

  useEffect(() => {
    load()
    const t = setInterval(load, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible) }
  }, [load])

  async function checkIn(bay, extraTeamIds = []) {
    if (!bay || busy) return
    setBusy(extraTeamIds[0] || bay.id)
    const { data, error } = await supabase.rpc('checkin_team', {
      p_bay_id: bay.id,
      p_extra_team_ids: extraTeamIds,
    })
    if (!mounted.current) return
    setBusy(null)
    if (error) {
      showToast(checkinErrorMessage(error), 'error')
      return
    }
    setResult(data)
    setChanging(false)
    if (extraTeamIds.length) {
      const added = (data.checked_in || []).filter(t => extraTeamIds.includes(t.team_id)).map(t => t.team_name)
      showToast(`${added.join(' & ') || 'Team'} checked in too`)
    }
    // Drop ?bay= so a refresh shows the success state, not the confirm again.
    if (bayParam) setParams({}, { replace: true })
    load()
  }

  async function checkOut() {
    if (busy) return
    setBusy('checkout')
    const { error } = await supabase.rpc('checkout_my_team')
    if (!mounted.current) return
    setBusy(null)
    if (error) { showToast(checkinErrorMessage(error), 'error'); return }
    setResult(null)
    setChanging(true)
    showToast('Checked out')
    load()
  }

  const bays = board?.bays || []
  const team = status?.team
  const myBay = status?.bay ? bays.find(b => b.id === status.bay.id) || status.bay : null
  const targetBay = bayParam ? findBayByLabel(bays, bayParam) : null

  // ── screens ────────────────────────────────────────────────────────────
  let body
  if (loading) {
    body = <p style={s.muted}>Loading…</p>
  } else if (loadError) {
    body = (
      <Callout tone="danger" style={{ margin: '8px 0' }}>
        {loadError}{' '}
        <button style={s.inlineLink} onClick={load}>Try again</button>
      </Callout>
    )
  } else if (status?.status !== 'ok') {
    body = <NotAvailable reason={status?.status} />
  } else if ((result || myBay) && !changing && (!targetBay || targetBay.id === (result?.bay?.id || myBay?.id))) {
    body = (
      <CheckedIn
        result={result}
        status={status}
        board={board}
        busy={busy}
        onAddTeam={teamId => checkIn(result?.bay || myBay, [teamId])}
        onChange={() => { setChanging(true); setResult(null) }}
        onCheckOut={checkOut}
      />
    )
  } else if (bayParam && !targetBay) {
    body = (
      <>
        <Callout tone="warning" style={{ marginBottom: 14 }}>
          We couldn't find {bayName(bayParam)}. Tap your bay below.
        </Callout>
        <BayGrid bays={bays} myBayId={myBay?.id} busy={busy} teamName={team?.name} onPick={checkIn} />
      </>
    )
  } else if (targetBay) {
    body = (
      <ConfirmBay
        bay={targetBay}
        teamName={team?.name}
        players={team?.players || []}
        currentBay={myBay}
        busy={busy === targetBay.id}
        onConfirm={() => checkIn(targetBay)}
        onPickOther={() => setParams({}, { replace: true })}
      />
    )
  } else {
    body = <BayGrid bays={bays} myBayId={myBay?.id} busy={busy} teamName={team?.name} onPick={checkIn} />
  }

  return (
    <div style={s.page}>
      {toast && <Toast toast={toast} />}
      <div style={s.topBar}>
        <button style={s.backBtn} onClick={onBack}>← Back</button>
        <div style={s.topTitle}>Bay check-in</div>
        <button style={s.refreshBtn} onClick={load} aria-label="Refresh">
          <RefreshCw size={16} strokeWidth={2} />
        </button>
      </div>
      <div style={s.content}>{body}</div>
    </div>
  )
}

function NotAvailable({ reason }) {
  const copy = {
    no_open_week: ['No league week is open', 'Check-in opens when the front desk opens this week\'s round.'],
    ambiguous: ['You\'re on more than one team', 'Ask the front desk to check your team in.'],
  }[reason] || ['You\'re not on a team this week', 'Only rostered players can check in. Ask the front desk to check you in.']
  return (
    <EmptyState
      icon={<MapPin size={40} strokeWidth={1.5} />}
      title={copy[0]}
      description={copy[1]}
    />
  )
}

function ConfirmBay({ bay, teamName, players, currentBay, busy, onConfirm, onPickOther }) {
  const others = occupantNames(bay)
  return (
    <div style={s.stack}>
      {currentBay && currentBay.id !== bay.id && (
        <Callout tone="info">You're on {bayName(currentBay.label)} now. This moves your team.</Callout>
      )}
      <div style={s.confirmCard}>
        <div style={s.confirmBayLabel}>{bayName(bay.label)}</div>
        <div style={s.confirmTeam}>{teamName}</div>
        <div style={s.confirmPlayers}>{players.map(p => p.name).join(' & ')}</div>
        <div style={s.confirmOthers}>
          {others ? `Already here: ${others}` : 'Nobody here yet'}
        </div>
      </div>
      <button
        className="ui-pressable"
        style={{ ...s.bigButton, opacity: busy ? 0.7 : 1 }}
        onClick={onConfirm}
        disabled={busy}
      >
        {busy ? 'Checking in…' : `Check in ${teamName} to ${bayName(bay.label)}`}
      </button>
      <button style={s.textLink} onClick={onPickOther}>Wrong bay? Pick another</button>
    </div>
  )
}

function BayGrid({ bays, myBayId, busy, teamName, onPick }) {
  if (!bays.length) {
    return (
      <EmptyState
        icon={<MapPin size={40} strokeWidth={1.5} />}
        title="No bays set up yet"
        description="Ask the front desk to check your team in."
      />
    )
  }
  return (
    <>
      <p style={s.gridHint}>Tap your bay to check in <strong>{teamName}</strong></p>
      <div style={s.grid}>
        {bays.map(bay => {
          const mine = bay.id === myBayId
          const names = occupantNames(bay)
          return (
            <button
              key={bay.id}
              className="ui-pressable"
              style={{
                ...s.bayTile,
                borderColor: mine ? 'var(--green)' : 'var(--gray-200)',
                background: mine ? 'var(--green-xlight)' : 'var(--white)',
                opacity: busy && busy !== bay.id ? 0.5 : 1,
              }}
              disabled={!!busy}
              onClick={() => onPick(bay)}
            >
              <span style={s.bayTileLabel}>{busy === bay.id ? '…' : bay.label}</span>
              <span style={s.bayTileNames}>
                {mine ? 'You\'re here' : names || 'Open'}
              </span>
            </button>
          )
        })}
      </div>
    </>
  )
}

function CheckedIn({ result, status, board, busy, onAddTeam, onChange, onCheckOut }) {
  const bayId = result?.bay?.id || status?.bay?.id
  const label = result?.bay?.label || status?.bay?.label
  const liveBay = (board?.bays || []).find(b => b.id === bayId)
  const teams = liveBay?.teams || result?.teams || []
  const myTeamId = status?.team?.id || result?.team_id
  const mine = teams.find(t => t.team_id === myTeamId)
  const others = teams.filter(t => t.team_id !== myTeamId)
  const onBoard = new Set(teams.map(t => t.team_id))
  const suggestions = (result?.suggestions || status?.suggestions || []).filter(t => !onBoard.has(t.team_id))

  return (
    <div style={s.stack}>
      <div style={s.successCard}>
        <CheckCircle2 size={40} strokeWidth={2} color="#fff" />
        <div style={s.successTitle}>You're on {bayName(label)}</div>
        <div style={s.successTeam}>{mine?.team_name || status?.team?.name}</div>
        <div style={s.successPlayers}>
          {(mine?.players || status?.team?.players || []).map(playerDisplayName).join(' & ')}
        </div>
      </div>

      {others.length > 0 && (
        <div style={s.sideCard}>
          <div style={s.sideLabel}>Also on this bay</div>
          {others.map(t => (
            <div key={t.team_id} style={s.otherRow}>
              <strong>{t.team_name}</strong>
              <span style={s.otherPlayers}>{(t.players || []).map(p => p.name).join(' & ')}</span>
            </div>
          ))}
        </div>
      )}

      {suggestions.length > 0 && (
        <div style={s.sideCard}>
          <div style={s.sideLabel}>Playing with them tonight?</div>
          <div style={s.chips}>
            {suggestions.map(t => (
              <button
                key={t.team_id}
                className="ui-pressable"
                style={{ ...s.chip, opacity: busy && busy !== t.team_id ? 0.5 : 1 }}
                disabled={!!busy}
                onClick={() => onAddTeam(t.team_id)}
              >
                <Plus size={18} strokeWidth={2.5} />
                <span>
                  {busy === t.team_id ? 'Adding…' : `Also check in ${t.team_name}`}
                  {t.players?.length > 0 && <span style={s.chipSub}>{t.players.join(' & ')}</span>}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={s.footerLinks}>
        <button style={s.textLink} onClick={onChange}>Change bay</button>
        <span style={{ color: 'var(--gray-300)' }}>·</span>
        <button style={s.textLink} onClick={onCheckOut} disabled={busy === 'checkout'}>
          <LogOut size={14} strokeWidth={2} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          {busy === 'checkout' ? 'Checking out…' : 'Check out'}
        </button>
      </div>
    </div>
  )
}

const s = {
  page:    { display: 'flex', flexDirection: 'column', minHeight: '100%', background: 'var(--off-white)' },
  topBar:  { display: 'flex', alignItems: 'center', padding: '12px 16px', background: 'var(--green-dark)', flexShrink: 0 },
  backBtn: { color: 'rgba(255,255,255,0.8)', fontSize: '13px', fontWeight: 500, cursor: 'pointer', width: 60, textAlign: 'left' },
  topTitle: { flex: 1, textAlign: 'center', fontSize: '17px', fontWeight: 800, color: '#fff' },
  refreshBtn: { color: 'rgba(255,255,255,0.8)', width: 60, display: 'flex', justifyContent: 'flex-end', cursor: 'pointer' },
  content: { padding: '16px 16px 40px', maxWidth: 560, width: '100%', margin: '0 auto', boxSizing: 'border-box' },
  muted:   { textAlign: 'center', color: 'var(--gray-500)', fontSize: '14px', padding: '40px 0' },
  stack:   { display: 'flex', flexDirection: 'column', gap: '14px' },
  inlineLink: { textDecoration: 'underline', fontWeight: 700, color: 'inherit', cursor: 'pointer' },

  confirmCard: {
    background: 'var(--white)', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow)', padding: '24px 18px', textAlign: 'center',
  },
  confirmBayLabel: { fontSize: '44px', fontWeight: 900, color: 'var(--green-dark)', lineHeight: 1.1 },
  confirmTeam:     { fontSize: '20px', fontWeight: 800, color: 'var(--black)', marginTop: '10px' },
  confirmPlayers:  { fontSize: '14px', color: 'var(--gray-600)', marginTop: '4px' },
  confirmOthers:   { fontSize: '13px', color: 'var(--gray-500)', marginTop: '12px' },
  bigButton: {
    width: '100%', minHeight: '76px', padding: '16px', borderRadius: 'var(--radius)',
    background: 'var(--green)', color: '#fff', fontSize: '20px', fontWeight: 800,
    border: 'none', cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,0.18)', lineHeight: 1.25,
  },
  textLink: {
    fontSize: '15px', fontWeight: 600, color: 'var(--green-dark)', cursor: 'pointer',
    padding: '12px 8px', background: 'none', border: 'none', textDecoration: 'underline',
  },

  gridHint: { fontSize: '15px', color: 'var(--gray-600)', margin: '4px 0 14px', textAlign: 'center' },
  grid:     { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '12px' },
  bayTile: {
    minHeight: '112px', padding: '14px 10px', borderRadius: 'var(--radius)', border: '2px solid',
    boxShadow: 'var(--shadow)', display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', gap: '6px', cursor: 'pointer', textAlign: 'center',
  },
  bayTileLabel: { fontSize: '40px', fontWeight: 900, color: 'var(--green-dark)', lineHeight: 1 },
  bayTileNames: { fontSize: '13px', color: 'var(--gray-600)', lineHeight: 1.3, wordBreak: 'break-word' },

  successCard: {
    background: 'var(--green-dark)', color: '#fff', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)',
    padding: '24px 18px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
  },
  successTitle:   { fontSize: '30px', fontWeight: 900, lineHeight: 1.15 },
  successTeam:    { fontSize: '18px', fontWeight: 700, marginTop: '4px' },
  successPlayers: { fontSize: '14px', color: 'rgba(255,255,255,0.8)' },
  sideCard: {
    background: 'var(--white)', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow)', padding: '14px 16px',
  },
  sideLabel: {
    fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px',
    color: 'var(--gray-500)', marginBottom: '8px',
  },
  otherRow:     { display: 'flex', flexDirection: 'column', padding: '6px 0', fontSize: '15px' },
  otherPlayers: { fontSize: '13px', color: 'var(--gray-500)' },
  chips: { display: 'flex', flexDirection: 'column', gap: '10px' },
  chip: {
    display: 'flex', alignItems: 'center', gap: '10px', width: '100%', minHeight: '60px',
    padding: '12px 14px', borderRadius: 'var(--radius-sm)', border: '2px solid var(--green)',
    background: 'var(--green-xlight)', color: 'var(--green-dark)', fontSize: '16px', fontWeight: 700,
    textAlign: 'left', cursor: 'pointer',
  },
  chipSub: { display: 'block', fontSize: '12px', fontWeight: 500, color: 'var(--gray-600)', marginTop: '2px' },
  footerLinks: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' },
}

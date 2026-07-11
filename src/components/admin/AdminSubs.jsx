import React, { useState, useEffect } from 'react'
import { UserCheck, Check, X, Link2, Inbox } from 'lucide-react'
import { Button, Toast, Callout, EmptyState } from '../ui'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import ConfirmDialog from '../ConfirmDialog'
import { mutationErrorMessage } from '../../lib/rpcErrors'
import { formatLocalDate } from '../../lib/dateUtils'

export default function AdminSubs() {
  const { locationId } = useLocation()
  const [subs, setSubs]         = useState([])
  const [knownSubs, setKnownSubs] = useState([])  // players with is_sub = true
  const [loading, setLoading]   = useState(true)
  const [toast, setToast]     = useState(null)
  const [filter, setFilter]   = useState('pending') // 'pending' | 'approved' | 'all'
  const [dialog, setDialog]   = useState(null)

  // Inline HCP editor state for the Sub Roster.
  // editingHcpId = the player id currently in edit mode (or null).
  // editingHcpValue = the raw string in the input (kept as a string so the
  //   user can type '-' before the digit without the value snapping).
  const [editingHcpId, setEditingHcpId]       = useState(null)
  const [editingHcpValue, setEditingHcpValue] = useState('')
  const [savingHcp, setSavingHcp]             = useState(false)

  function startEditHcp(player) {
    setEditingHcpId(player.id)
    setEditingHcpValue(String(player.handicap ?? ''))
  }
  function cancelEditHcp() {
    setEditingHcpId(null)
    setEditingHcpValue('')
  }
  async function saveEditHcp(player) {
    // Parse + clamp. Integer-only; sub handicaps can legitimately run higher
    // than league cap, so allow [-2, 40].
    const n = parseInt(editingHcpValue, 10)
    if (!Number.isFinite(n)) {
      showToast('Handicap must be a whole number.', 'error')
      return
    }
    const clamped = Math.max(-2, Math.min(40, n))
    if (clamped === player.handicap) { cancelEditHcp(); return }

    setSavingHcp(true)
    const { error } = await supabase.rpc('admin_set_player_handicap', {
      p_player_id: player.id,
      p_handicap: clamped,
    })
    setSavingHcp(false)
    if (error) { showToast('Error: ' + error.message, 'error'); return }
    showToast(`Updated ${player.name || 'sub'} to HCP ${clamped}`)
    cancelEditHcp()
    load()
  }

  useEffect(() => { if (locationId) load() }, [locationId])

  async function load() {
    // Fetch everything independently — no FK joins (avoids PostgREST relationship issues)
    let [
      { data: subRows,       error: subErr },
      { data: allPlayers },
      { data: allEvents },
      { data: subPlayerRows },
    ] = await Promise.all([
      supabase.from('subs').select('*').eq('location_id', locationId).order('created_at', { ascending: false }),
      supabase.from('players').select('id, name, email').eq('location_id', locationId),
      supabase.from('events').select('id, name, start_date').eq('location_id', locationId),
      supabase.from('players').select('id, first_name, last_name, name, handicap, email').eq('location_id', locationId).eq('is_sub', true).order('last_name', { ascending: true }),
    ])

    if (subErr) console.error('AdminSubs load error:', subErr.message)

    // ── One-time heal: flip is_sub=true on any approved sub whose linked
    // player never got the flag set (pre-fix data). We only refetch the
    // roster if we touched anything so we don't loop.
    const subPlayerIdSet = new Set((subPlayerRows || []).map(p => p.id))
    const missing = (subRows || []).filter(s => s.status === 'approved' && s.sub_player_id && !subPlayerIdSet.has(s.sub_player_id))
    if (missing.length > 0) {
      const healResults = await Promise.all(
        missing.map(s => supabase.rpc('admin_set_sub_status', { p_sub_id: s.id, p_status: 'approved' }))
      )
      const healErr = healResults.find(result => result.error)?.error
      if (healErr) {
        console.warn('AdminSubs backfill heal failed:', healErr.message)
      } else {
        // Refetch the roster so the newly-flagged players appear immediately.
        const { data: refetched } = await supabase
          .from('players')
          .select('id, first_name, last_name, name, handicap, email')
          .eq('location_id', locationId)
          .eq('is_sub', true)
          .order('last_name', { ascending: true })
        if (refetched) subPlayerRows = refetched
      }
    }

    // Build lookup maps
    const playerById = {}
    ;(allPlayers || []).forEach(p => { playerById[p.id] = p })
    const eventById = {}
    ;(allEvents || []).forEach(e => { eventById[e.id] = e })

    // Enrich subs with player + event info client-side
    const enriched = (subRows || []).map(s => ({
      ...s,
      playerName: playerById[s.player_id]?.name || 'Unknown player',
      eventName:  eventById[s.event_id]?.name  || 'Unknown event',
      eventDate:  eventById[s.event_id]?.start_date || null,
    }))

    setSubs(enriched)
    setKnownSubs(subPlayerRows || [])
    setLoading(false)
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function handleApprove(sub) {
    const { error } = await supabase.rpc('admin_set_sub_status', { p_sub_id: sub.id, p_status: 'approved' })
    if (error) { showToast('Error: ' + mutationErrorMessage(error, 'approve this substitute'), 'error'); return }
    showToast(`Sub approved for ${sub.playerName} — sub profile ready`)
    load()
  }

  // ── Retroactively sync a profile for an already-approved sub ─────────────
  async function handleSyncProfile(sub) {
    const { error } = await supabase.rpc('admin_set_sub_status', { p_sub_id: sub.id, p_status: 'approved' })
    if (error) { showToast('Error: ' + mutationErrorMessage(error, 'sync this substitute profile'), 'error'); return }
    showToast(`Profile synced for ${sub.sub_first_name} ${sub.sub_last_name}`)
    load()
  }

  function handleDeny(sub) {
    setDialog({
      message: 'Deny this sub request?',
      confirmLabel: 'Deny',
      onConfirm: async () => {
        const { error } = await supabase.rpc('admin_set_sub_status', { p_sub_id: sub.id, p_status: 'denied' })
        if (error) { showToast('Error: ' + mutationErrorMessage(error, 'deny this substitute'), 'error'); return }
        showToast('Sub request denied.')
        load()
      },
    })
  }

  function handleDelete(sub) {
    setDialog({
      message: 'Remove this sub request entirely?',
      confirmLabel: 'Remove',
      onConfirm: async () => {
        const { error } = await supabase.rpc('admin_delete_sub', { p_sub_id: sub.id })
        if (error) { showToast('Error: ' + mutationErrorMessage(error, 'remove this substitute request'), 'error'); return }
        showToast('Request removed.')
        load()
      },
    })
  }

  const filtered = subs.filter(s => {
    if (filter === 'pending')  return s.status === 'pending'
    if (filter === 'approved') return s.status === 'approved'
    return true
  })

  const pendingCount = subs.filter(s => s.status === 'pending').length

  if (loading) return <div style={styles.loading}>Loading…</div>

  return (
    <div style={styles.container}>
      {dialog && (
        <ConfirmDialog
          {...dialog}
          onConfirm={() => { dialog.onConfirm(); setDialog(null) }}
          onCancel={() => setDialog(null)}
        />
      )}
      <Toast toast={toast} />

      {/* Alert banner if pending subs exist */}
      {pendingCount > 0 && (
        <Callout tone="warning">
          <strong>{pendingCount} sub request{pendingCount !== 1 ? 's' : ''}</strong> need your attention
        </Callout>
      )}

      {/* Filter Tabs */}
      <div style={styles.filterRow}>
        {[
          { key: 'pending',  label: 'Pending',  count: subs.filter(s => s.status === 'pending').length },
          { key: 'approved', label: 'Approved', count: subs.filter(s => s.status === 'approved').length },
          { key: 'all',      label: 'All',      count: subs.length },
        ].map(({ key, label, count }) => (
          <button
            key={key}
            style={{
              ...styles.filterBtn,
              background: filter === key ? 'var(--green)' : 'var(--white)',
              color:      filter === key ? 'var(--white)' : 'var(--gray-600)',
              border:     filter === key ? '1.5px solid var(--green)' : '1.5px solid var(--gray-200)',
              fontWeight: filter === key ? 700 : 400,
            }}
            onClick={() => setFilter(key)}
          >
            {label} {count > 0 && <span style={{ ...styles.filterCount, opacity: filter === key ? 0.8 : 0.6 }}>({count})</span>}
          </button>
        ))}
      </div>

      {/* Sub Requests */}
      <div style={styles.card}>
        <div style={styles.cardTitleRow}>
          <h3 style={styles.cardTitle}>Sub Requests</h3>
          <span style={styles.count}>{filtered.length}</span>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={<Inbox size={38} strokeWidth={1.5} />}
            title={filter === 'pending' ? 'No pending sub requests' : 'No sub requests found'}
            description={filter === 'pending'
              ? "You'll see requests here when players submit them for upcoming weeks."
              : 'Try a different filter to see past requests.'}
          />
        ) : (
          filtered.map(sub => {
            const statusColors = {
              pending:  { bg: '#fff3cd', color: '#856404' },
              approved: { bg: 'var(--green-xlight)', color: 'var(--green)' },
              denied:   { bg: '#fff5f5', color: '#c53030' },
            }
            const sc = statusColors[sub.status] || statusColors.pending

            return (
              <div key={sub.id} style={styles.subCard}>
                {/* Header: who requested + when */}
                <div style={styles.subHeader}>
                  <div>
                    <div style={styles.subRequester}>
                      Requested by: <strong>{sub.playerName}</strong>
                    </div>
                    <div style={styles.subEvent}>
                      {sub.eventName}
                {sub.eventDate ? ' · ' + formatLocalDate(sub.eventDate, { month: 'short', day: 'numeric' }) : ''}
                    </div>
                    <div style={styles.subDate}>
                      Submitted {new Date(sub.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </div>
                  </div>
                  <span style={{ ...styles.statusBadge, background: sc.bg, color: sc.color }}>
                    {sub.status}
                  </span>
                </div>

                {/* Sub Player Info */}
                <div style={styles.subInfo}>
                  <div style={styles.subInfoGrid}>
                    <div style={styles.subInfoItem}>
                      <span style={styles.subInfoLabel}>Sub Name</span>
                      <span style={styles.subInfoValue}>{sub.sub_first_name} {sub.sub_last_name}</span>
                    </div>
                    <div style={styles.subInfoItem}>
                      <span style={styles.subInfoLabel}>Handicap</span>
                      <span style={styles.subInfoValue}>{sub.sub_handicap ?? 'TBD'}</span>
                    </div>
                    <div style={styles.subInfoItem}>
                      <span style={styles.subInfoLabel}>Email</span>
                      <span style={styles.subInfoValue}>{sub.sub_email || '—'}</span>
                    </div>
                    <div style={styles.subInfoItem}>
                      <span style={styles.subInfoLabel}>Phone</span>
                      <span style={styles.subInfoValue}>{sub.sub_phone || '—'}</span>
                    </div>
                  </div>
                  {sub.sub_player_id && (
                    <div style={styles.profileLinked}>
                      <UserCheck size={13} strokeWidth={2.25} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                      Sub profile on file
                    </div>
                  )}
                </div>

                {/* Actions */}
                {sub.status === 'pending' && (
                  <div style={styles.subActions}>
                    <Button
                      variant="primary"
                      icon={<Check size={14} strokeWidth={2.5} />}
                      onClick={() => handleApprove(sub)}
                      style={{ flex: 1 }}
                    >
                      Approve
                    </Button>
                    <Button
                      variant="danger"
                      icon={<X size={14} strokeWidth={2.5} />}
                      onClick={() => handleDeny(sub)}
                      style={{ flex: 1 }}
                    >
                      Deny
                    </Button>
                  </div>
                )}
                {sub.status !== 'pending' && (
                  <div style={styles.approvedActions}>
                    {/* Show sync button for approved subs missing a profile link */}
                    {sub.status === 'approved' && !sub.sub_player_id && (
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<Link2 size={14} strokeWidth={2.25} />}
                        onClick={() => handleSyncProfile(sub)}
                        style={{
                          background: 'var(--green-xlight)',
                          color: 'var(--green-dark)',
                          borderColor: 'var(--green)',
                        }}
                      >
                        Sync Profile
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(sub)}>
                      Remove
                    </Button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      {/* Sub Roster */}
      <div style={styles.card}>
        <div style={styles.cardTitleRow}>
          <h3 style={styles.cardTitle}>Sub Roster</h3>
          <span style={styles.count}>{knownSubs.length}</span>
        </div>
        {knownSubs.length === 0 ? (
          <div style={styles.rosterEmpty}>
            No sub profiles yet. Approve a sub request to add someone to the roster.
          </div>
        ) : (
          knownSubs.map(s => {
            const fullName = (`${s.first_name || ''} ${s.last_name || ''}`).trim() || s.name || 'Unknown'
            const editing = editingHcpId === s.id
            return (
              <div key={s.id} style={styles.rosterRow}>
                <div style={styles.rosterAvatar}>
                  {fullName[0]?.toUpperCase() || '?'}
                </div>
                <div style={styles.rosterInfo}>
                  <div style={styles.rosterName}>{fullName}</div>
                  {s.email && <div style={styles.rosterEmail}>{s.email}</div>}
                </div>

                {editing ? (
                  <div style={styles.rosterHcpEdit}>
                    <input
                      type="number"
                      inputMode="numeric"
                      step="1"
                      min="-2"
                      max="40"
                      autoFocus
                      value={editingHcpValue}
                      onChange={e => setEditingHcpValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') saveEditHcp(s)
                        if (e.key === 'Escape') cancelEditHcp()
                      }}
                      style={styles.rosterHcpInput}
                      disabled={savingHcp}
                    />
                    <div style={styles.rosterHcpEditBtns}>
                      <button
                        type="button"
                        onClick={() => saveEditHcp(s)}
                        disabled={savingHcp}
                        style={{ ...styles.rosterHcpBtn, ...styles.rosterHcpSave }}
                        title="Save (Enter)"
                      >
                        <Check size={14} strokeWidth={2.5} />
                      </button>
                      <button
                        type="button"
                        onClick={cancelEditHcp}
                        disabled={savingHcp}
                        style={{ ...styles.rosterHcpBtn, ...styles.rosterHcpCancel }}
                        title="Cancel (Esc)"
                      >
                        <X size={14} strokeWidth={2.5} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => startEditHcp(s)}
                    style={{ ...styles.rosterHcp, ...styles.rosterHcpButton }}
                    title="Edit handicap"
                  >
                    <span style={styles.rosterHcpLabel}>HCP</span>
                    <span style={styles.rosterHcpValue}>{s.handicap ?? '—'}</span>
                  </button>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

const styles = {
  container: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  loading: { padding: '40px', textAlign: 'center', color: 'var(--gray-400)' },
  filterRow: { display: 'flex', gap: '8px' },
  filterBtn: { flex: 1, padding: '8px 4px', borderRadius: '20px', fontSize: '13px', transition: 'all 0.15s' },
  filterCount: { fontSize: '11px' },
  card: { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  cardTitleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  cardTitle: { fontSize: '14px', fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  count: { fontSize: '13px', fontWeight: 700, color: 'var(--green)', background: 'var(--green-xlight)', padding: '2px 10px', borderRadius: '20px' },
  subCard: { border: '1px solid var(--gray-200)', borderRadius: 'var(--radius-sm)', padding: '14px', marginBottom: '10px', background: 'var(--off-white)' },
  subHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' },
  subRequester: { fontSize: '14px', color: 'var(--black)' },
  subEvent: { fontSize: '12px', color: 'var(--green-dark)', fontWeight: 500, marginTop: '2px' },
  subDate: { fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' },
  statusBadge: { fontSize: '11px', fontWeight: 700, padding: '3px 10px', borderRadius: '20px', textTransform: 'uppercase', letterSpacing: '0.3px', flexShrink: 0 },
  subInfo: { background: 'var(--white)', borderRadius: 'var(--radius-sm)', padding: '10px 12px', marginBottom: '12px', border: '1px solid var(--gray-200)' },
  subInfoGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' },
  subInfoItem: { display: 'flex', flexDirection: 'column', gap: '2px' },
  subInfoLabel: { fontSize: '10px', fontWeight: 600, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  subInfoValue: { fontSize: '13px', fontWeight: 600, color: 'var(--black)' },
  subActions: { display: 'flex', gap: '8px' },
  approvedActions: { display: 'flex', gap: '8px', alignItems: 'center' },
  profileLinked: { marginTop: '8px', fontSize: '11px', fontWeight: 600, color: 'var(--green)', background: 'var(--green-xlight)', padding: '3px 10px', borderRadius: '20px', display: 'inline-block' },
  rosterEmpty: { fontSize: '13px', color: 'var(--gray-400)', textAlign: 'center', padding: '16px 0', fontStyle: 'italic' },
  rosterRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderBottom: '1px solid var(--gray-100)' },
  rosterAvatar: { width: 36, height: 36, borderRadius: '50%', background: 'var(--green-xlight)', color: 'var(--green-dark)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 800, flexShrink: 0 },
  rosterInfo: { flex: 1 },
  rosterName: { fontSize: '14px', fontWeight: 700, color: 'var(--black)' },
  rosterEmail: { fontSize: '11px', color: 'var(--gray-400)', marginTop: '1px' },
  rosterHcp: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px', background: 'var(--gray-100)', borderRadius: '8px', padding: '5px 10px', flexShrink: 0 },
  rosterHcpButton: { border: '1px solid transparent', cursor: 'pointer', transition: 'all 0.12s ease' },
  rosterHcpLabel: { fontSize: '9px', fontWeight: 600, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  rosterHcpValue: { fontSize: '15px', fontWeight: 800, color: 'var(--green-dark)' },
  rosterHcpEdit: { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 },
  rosterHcpInput: { width: '56px', padding: '6px 8px', borderRadius: '8px', border: '1.5px solid var(--green)', fontSize: '14px', fontWeight: 700, color: 'var(--green-dark)', background: 'var(--white)', textAlign: 'center', outline: 'none', MozAppearance: 'textfield' },
  rosterHcpEditBtns: { display: 'flex', flexDirection: 'column', gap: '4px' },
  rosterHcpBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: '24px', height: '20px', borderRadius: '6px', border: 'none', cursor: 'pointer' },
  rosterHcpSave: { background: 'var(--green)', color: 'var(--white)' },
  rosterHcpCancel: { background: 'var(--gray-200)', color: 'var(--gray-600)' },
}

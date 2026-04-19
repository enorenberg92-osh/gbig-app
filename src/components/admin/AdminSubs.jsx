import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import ConfirmDialog from '../ConfirmDialog'

export default function AdminSubs() {
  const { locationId } = useLocation()
  const [subs, setSubs]         = useState([])
  const [knownSubs, setKnownSubs] = useState([])  // players with is_sub = true
  const [loading, setLoading]   = useState(true)
  const [toast, setToast]     = useState(null)
  const [filter, setFilter]   = useState('pending') // 'pending' | 'approved' | 'all'
  const [dialog, setDialog]   = useState(null)

  useEffect(() => { if (locationId) load() }, [locationId])

  async function load() {
    // Fetch everything independently — no FK joins (avoids PostgREST relationship issues)
    const [
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

  // ── Shared helper: find existing sub profile or create a new one ────────────
  async function ensureSubProfile(sub) {
    if (sub.sub_player_id) {
      // Already linked — just keep their handicap current
      await supabase.from('players').update({ handicap: sub.sub_handicap }).eq('id', sub.sub_player_id)
      return { id: sub.sub_player_id, error: null }
    }

    const firstName = (sub.sub_first_name || '').trim()
    const lastName  = (sub.sub_last_name  || '').trim()
    const fullName  = `${firstName} ${lastName}`.trim()

    // Check for an existing sub player with the same name
    const { data: existing } = await supabase
      .from('players')
      .select('id')
      .eq('is_sub', true)
      .eq('first_name', firstName)
      .eq('last_name', lastName)
      .maybeSingle()

    if (existing) {
      await supabase.from('players').update({ handicap: sub.sub_handicap }).eq('id', existing.id)
      return { id: existing.id, error: null }
    }

    // Create a brand-new sub player profile
    const { data: newPlayer, error: createErr } = await supabase
      .from('players')
      .insert({
        first_name:  firstName,
        last_name:   lastName,
        name:        fullName,
        handicap:    sub.sub_handicap,
        email:       sub.sub_email || null,
        is_sub:      true,
        location_id: locationId,
      })
      .select('id')
      .single()

    return { id: newPlayer?.id || null, error: createErr }
  }

  async function handleApprove(sub) {
    const { id: subPlayerId, error: profileErr } = await ensureSubProfile(sub)
    if (profileErr) { showToast('Error creating sub profile: ' + profileErr.message, 'error'); return }

    const { error } = await supabase
      .from('subs')
      .update({ status: 'approved', sub_player_id: subPlayerId })
      .eq('id', sub.id)
    if (error) { showToast('Error: ' + error.message, 'error'); return }
    showToast(`✓ Sub approved for ${sub.playerName} — sub profile ready`)
    load()
  }

  // ── Retroactively sync a profile for an already-approved sub ─────────────
  async function handleSyncProfile(sub) {
    const { id: subPlayerId, error: profileErr } = await ensureSubProfile(sub)
    if (profileErr) { showToast('Error syncing profile: ' + profileErr.message, 'error'); return }

    const { error } = await supabase
      .from('subs')
      .update({ sub_player_id: subPlayerId })
      .eq('id', sub.id)
    if (error) { showToast('Error: ' + error.message, 'error'); return }
    showToast(`✓ Profile synced for ${sub.sub_first_name} ${sub.sub_last_name}`)
    load()
  }

  function handleDeny(sub) {
    setDialog({
      message: 'Deny this sub request?',
      confirmLabel: 'Deny',
      onConfirm: async () => {
        const { error } = await supabase
          .from('subs')
          .update({ status: 'denied' })
          .eq('id', sub.id)
        if (error) { showToast('Error: ' + error.message, 'error'); return }
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
        const { error } = await supabase.from('subs').delete().eq('id', sub.id)
        if (error) { showToast('Error: ' + error.message, 'error'); return }
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
      {toast && (
        <div style={{ ...styles.toast, background: toast.type === 'error' ? '#c53030' : 'var(--green)' }}>
          {toast.msg}
        </div>
      )}

      {/* Alert banner if pending subs exist */}
      {pendingCount > 0 && (
        <div style={styles.alertBanner}>
          ⚠️ <strong>{pendingCount} sub request{pendingCount !== 1 ? 's' : ''}</strong> need your attention
        </div>
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
          <div style={styles.empty}>
            <span style={styles.emptyIcon}>🏌️</span>
            <p>{filter === 'pending' ? 'No pending sub requests.' : 'No sub requests found.'}</p>
          </div>
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
                      {sub.eventDate ? ' · ' + new Date(sub.eventDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
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
                    <div style={styles.profileLinked}>🧑 Sub profile on file</div>
                  )}
                </div>

                {/* Actions */}
                {sub.status === 'pending' && (
                  <div style={styles.subActions}>
                    <button style={styles.approveBtn} onClick={() => handleApprove(sub)}>
                      ✓ Approve
                    </button>
                    <button style={styles.denyBtn} onClick={() => handleDeny(sub)}>
                      ✕ Deny
                    </button>
                  </div>
                )}
                {sub.status !== 'pending' && (
                  <div style={styles.approvedActions}>
                    {/* Show sync button for approved subs missing a profile link */}
                    {sub.status === 'approved' && !sub.sub_player_id && (
                      <button style={styles.syncBtn} onClick={() => handleSyncProfile(sub)}>
                        🔗 Sync Profile
                      </button>
                    )}
                    <button style={styles.removeBtn} onClick={() => handleDelete(sub)}>
                      Remove
                    </button>
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
            return (
              <div key={s.id} style={styles.rosterRow}>
                <div style={styles.rosterAvatar}>
                  {fullName[0]?.toUpperCase() || '?'}
                </div>
                <div style={styles.rosterInfo}>
                  <div style={styles.rosterName}>{fullName}</div>
                  {s.email && <div style={styles.rosterEmail}>{s.email}</div>}
                </div>
                <div style={styles.rosterHcp}>
                  <span style={styles.rosterHcpLabel}>HCP</span>
                  <span style={styles.rosterHcpValue}>{s.handicap ?? '—'}</span>
                </div>
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
  toast: { position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', color: 'white', padding: '10px 20px', borderRadius: '20px', fontSize: '13px', fontWeight: 600, zIndex: 9999, boxShadow: 'var(--shadow-lg)' },
  alertBanner: { background: '#fff3cd', border: '1px solid #ffc107', color: '#856404', padding: '12px 16px', borderRadius: 'var(--radius-sm)', fontSize: '14px' },
  filterRow: { display: 'flex', gap: '8px' },
  filterBtn: { flex: 1, padding: '8px 4px', borderRadius: '20px', fontSize: '13px', transition: 'all 0.15s' },
  filterCount: { fontSize: '11px' },
  card: { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  cardTitleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  cardTitle: { fontSize: '14px', fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  count: { fontSize: '13px', fontWeight: 700, color: 'var(--green)', background: 'var(--green-xlight)', padding: '2px 10px', borderRadius: '20px' },
  empty: { padding: '24px', textAlign: 'center', color: 'var(--gray-400)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' },
  emptyIcon: { fontSize: '32px' },
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
  approveBtn: { flex: 1, padding: '10px', background: 'var(--green)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: '13px', fontWeight: 700 },
  denyBtn: { flex: 1, padding: '10px', background: '#fff5f5', color: '#c53030', borderRadius: 'var(--radius-sm)', fontSize: '13px', fontWeight: 700, border: '1px solid #feb2b2' },
  removeBtn: { fontSize: '12px', color: 'var(--gray-400)', padding: '6px 12px', background: 'var(--gray-100)', borderRadius: 'var(--radius-sm)' },
  approvedActions: { display: 'flex', gap: '8px', alignItems: 'center' },
  syncBtn: { fontSize: '12px', fontWeight: 700, color: 'var(--green-dark)', padding: '6px 12px', background: 'var(--green-xlight)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--green)' },
  profileLinked: { marginTop: '8px', fontSize: '11px', fontWeight: 600, color: 'var(--green)', background: 'var(--green-xlight)', padding: '3px 10px', borderRadius: '20px', display: 'inline-block' },
  rosterEmpty: { fontSize: '13px', color: 'var(--gray-400)', textAlign: 'center', padding: '16px 0', fontStyle: 'italic' },
  rosterRow: { display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 0', borderBottom: '1px solid var(--gray-100)' },
  rosterAvatar: { width: 36, height: 36, borderRadius: '50%', background: 'var(--green-xlight)', color: 'var(--green-dark)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 800, flexShrink: 0 },
  rosterInfo: { flex: 1 },
  rosterName: { fontSize: '14px', fontWeight: 700, color: 'var(--black)' },
  rosterEmail: { fontSize: '11px', color: 'var(--gray-400)', marginTop: '1px' },
  rosterHcp: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1px', background: 'var(--gray-100)', borderRadius: '8px', padding: '5px 10px', flexShrink: 0 },
  rosterHcpLabel: { fontSize: '9px', fontWeight: 600, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  rosterHcpValue: { fontSize: '15px', fontWeight: 800, color: 'var(--green-dark)' },
}

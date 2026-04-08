import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

/**
 * SubRequest
 *
 * Lets a player request a substitute for an upcoming event.
 * The player provides their sub's info (name, email, phone, handicap).
 * The admin reviews and approves/denies in AdminSubs.
 */
export default function SubRequest({ session, onBack }) {
  const [loading, setLoading]   = useState(true)
  const [player, setPlayer]     = useState(null)
  const [events, setEvents]     = useState([])
  const [myRequests, setMyRequests] = useState([])
  const [knownSubs, setKnownSubs]   = useState([])   // players with is_sub = true
  const [selectedSubId, setSelectedSubId] = useState(null) // picked known sub id
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)
  const [error, setError]       = useState(null)

  const EMPTY_FORM = { event_id: '', sub_first_name: '', sub_last_name: '', sub_email: '', sub_phone: '', sub_handicap: '', sub_player_id: null }
  const [form, setForm]         = useState(EMPTY_FORM)

  useEffect(() => { load() }, [])

  async function load() {
    // Find player record
    const { data: playerRow, error: pErr } = await supabase
      .from('players')
      .select('id, name')
      .eq('user_id', session.user.id)
      .single()

    if (pErr || !playerRow) { setError('No player record found. Ask your admin.'); setLoading(false); return }
    setPlayer(playerRow)

    // Load open events
    const { data: evts } = await supabase
      .from('events')
      .select('id, name, start_date')
      .eq('status', 'open')
      .order('start_date', { ascending: true })

    setEvents(evts || [])
    if (evts && evts.length > 0) setForm(f => ({ ...f, event_id: evts[0].id }))

    // Load my existing sub requests
    const { data: reqs } = await supabase
      .from('subs')
      .select('id, status, sub_first_name, sub_last_name, sub_handicap, events(name, start_date)')
      .eq('player_id', playerRow.id)
      .order('created_at', { ascending: false })

    setMyRequests(reqs || [])

    // Load known sub players (profiles created from past approved subs)
    const { data: subPlayers } = await supabase
      .from('players')
      .select('id, first_name, last_name, name, handicap, email')
      .eq('is_sub', true)
      .order('last_name', { ascending: true })

    setKnownSubs(subPlayers || [])
    setLoading(false)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.event_id)                { showToast('Please select an event.', 'error'); return }
    if (!form.sub_first_name.trim())   { showToast("Please enter the sub's first name.", 'error'); return }
    if (!form.sub_last_name.trim())    { showToast("Please enter the sub's last name.", 'error'); return }
    if (!form.sub_email.trim())        { showToast("Please enter the sub's email.", 'error'); return }
    if (!form.sub_phone.trim())        { showToast("Please enter the sub's phone number.", 'error'); return }
    if (form.sub_handicap === '')      { showToast("Please enter the sub's handicap.", 'error'); return }

    setSaving(true)

    const { error: insertErr } = await supabase.from('subs').insert({
      event_id:       form.event_id,
      player_id:      player.id,
      sub_first_name: form.sub_first_name.trim(),
      sub_last_name:  form.sub_last_name.trim(),
      sub_email:      form.sub_email.trim(),
      sub_phone:      form.sub_phone.trim(),
      sub_handicap:   parseFloat(form.sub_handicap),
      sub_player_id:  form.sub_player_id || null,  // link to known sub profile if selected
      status:         'pending',
    })

    setSaving(false)

    if (insertErr) {
      showToast('Error: ' + insertErr.message, 'error')
    } else {
      showToast('Sub request submitted! Your admin will review it.')
      setShowForm(false)
      setForm(EMPTY_FORM)
      setSelectedSubId(null)
      load()
    }
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  const statusStyle = {
    pending:  { bg: '#fef9c3', color: '#713f12' },
    approved: { bg: '#d8f3dc', color: '#2d6a4f' },
    denied:   { bg: '#fff5f5', color: '#c53030' },
  }

  if (loading) {
    return (
      <div style={styles.centered}>
        <div style={{ fontSize: 36 }}>⏳</div>
        <p style={{ color: 'var(--gray-400)', fontSize: 14 }}>Loading…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div style={styles.centered}>
        <p style={{ color: '#c53030', fontSize: 14 }}>{error}</p>
        <button style={styles.backBtn} onClick={onBack}>← Back</button>
      </div>
    )
  }

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <button style={styles.headerBack} onClick={onBack}>← Back</button>
        <div style={styles.headerTitle}>Request a Sub</div>
        <div style={{ width: 52 }} />
      </div>

      {/* Toast */}
      {toast && (
        <div style={{ ...styles.toast, background: toast.type === 'error' ? '#c53030' : 'var(--green)' }}>
          {toast.msg}
        </div>
      )}

      <div style={styles.content}>
        {/* Info box */}
        <div style={styles.infoBox}>
          <div style={styles.infoIcon}>ℹ️</div>
          <div style={styles.infoText}>
            Can't make it this week? Submit a sub request and your admin will review it.
            Make sure your sub has played before or has a known handicap!
          </div>
        </div>

        {/* Request form */}
        {events.length === 0 ? (
          <div style={styles.card}>
            <div style={styles.emptyText}>No open events available for sub requests right now.</div>
          </div>
        ) : showForm ? (
          <div style={styles.card}>
            <div style={styles.cardTitle}>New Sub Request</div>
            <form onSubmit={handleSubmit} style={styles.form}>

              {/* ── Known Sub Quick-Pick ── */}
              {knownSubs.length > 0 && (
                <div style={styles.fieldGroup}>
                  <label style={styles.label}>Quick-Pick a Past Sub</label>
                  <div style={styles.subPickerScroll}>
                    {/* "New person" chip */}
                    <button
                      type="button"
                      style={{ ...styles.subChip, ...(selectedSubId === null ? styles.subChipNew : {}) }}
                      onClick={() => {
                        setSelectedSubId(null)
                        setForm(f => ({ ...f, sub_first_name: '', sub_last_name: '', sub_email: '', sub_phone: '', sub_handicap: '', sub_player_id: null }))
                      }}
                    >
                      <span style={styles.subChipName}>＋ New Person</span>
                    </button>
                    {knownSubs.map(s => {
                      const sn = (`${s.first_name || ''} ${s.last_name || ''}`).trim() || s.name || 'Sub'
                      const isSelected = selectedSubId === s.id
                      return (
                        <button
                          key={s.id}
                          type="button"
                          style={{ ...styles.subChip, ...(isSelected ? styles.subChipActive : {}) }}
                          onClick={() => {
                            setSelectedSubId(s.id)
                            setForm(f => ({
                              ...f,
                              sub_first_name: s.first_name || '',
                              sub_last_name:  s.last_name  || '',
                              sub_email:      s.email      || '',
                              sub_handicap:   s.handicap   != null ? String(s.handicap) : '',
                              sub_player_id:  s.id,
                            }))
                          }}
                        >
                          <span style={styles.subChipName}>{sn}</span>
                          <span style={styles.subChipHcp}>HCP {s.handicap ?? '?'}</span>
                        </button>
                      )
                    })}
                  </div>
                  {selectedSubId && (
                    <div style={styles.subPickedNote}>
                      ✓ Details pre-filled — update handicap below if it's changed
                    </div>
                  )}
                </div>
              )}

              {/* Event */}
              <div style={styles.fieldGroup}>
                <label style={styles.label}>Event *</label>
                <select
                  style={styles.select}
                  value={form.event_id}
                  onChange={e => setForm(f => ({ ...f, event_id: e.target.value }))}
                  required
                >
                  {events.map(evt => (
                    <option key={evt.id} value={evt.id}>
                      {evt.name}
                      {evt.start_date
                        ? ` — ${new Date(evt.start_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
                        : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* Sub name — first + last */}
              <div style={styles.row}>
                <div style={{ ...styles.fieldGroup, flex: 1 }}>
                  <label style={styles.label}>First Name *</label>
                  <input
                    style={styles.input}
                    value={form.sub_first_name}
                    onChange={e => setForm(f => ({ ...f, sub_first_name: e.target.value }))}
                    placeholder="First"
                    required
                  />
                </div>
                <div style={{ ...styles.fieldGroup, flex: 1 }}>
                  <label style={styles.label}>Last Name *</label>
                  <input
                    style={styles.input}
                    value={form.sub_last_name}
                    onChange={e => setForm(f => ({ ...f, sub_last_name: e.target.value }))}
                    placeholder="Last"
                    required
                  />
                </div>
              </div>

              {/* Sub contact */}
              <div style={styles.row}>
                <div style={{ ...styles.fieldGroup, flex: 1 }}>
                  <label style={styles.label}>Sub's Email *</label>
                  <input
                    type="email"
                    style={styles.input}
                    value={form.sub_email}
                    onChange={e => setForm(f => ({ ...f, sub_email: e.target.value }))}
                    placeholder="email@example.com"
                    required
                  />
                </div>
                <div style={{ ...styles.fieldGroup, flex: 1 }}>
                  <label style={styles.label}>Sub's Phone *</label>
                  <input
                    type="tel"
                    style={styles.input}
                    value={form.sub_phone}
                    onChange={e => setForm(f => ({ ...f, sub_phone: e.target.value }))}
                    placeholder="555-555-5555"
                    required
                  />
                </div>
              </div>

              {/* Sub handicap */}
              <div style={styles.fieldGroup}>
                <label style={styles.label}>Sub's Handicap *</label>
                <input
                  type="number"
                  min="0"
                  max="27"
                  step="0.5"
                  style={styles.input}
                  value={form.sub_handicap}
                  onChange={e => setForm(f => ({ ...f, sub_handicap: e.target.value }))}
                  placeholder="0–27"
                  required
                />
              </div>

              <div style={styles.formActions}>
                <button type="submit" style={styles.submitBtn} disabled={saving}>
                  {saving ? 'Submitting…' : 'Submit Request'}
                </button>
                <button
                  type="button"
                  style={styles.cancelBtn}
                  onClick={() => { setShowForm(false); setForm(EMPTY_FORM); setSelectedSubId(null) }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        ) : (
          <button style={styles.newRequestBtn} onClick={() => setShowForm(true)}>
            + Request a Sub for This Week
          </button>
        )}

        {/* My requests */}
        {myRequests.length > 0 && (
          <div style={styles.card}>
            <div style={styles.cardTitle}>My Sub Requests</div>
            {myRequests.map(req => {
              const ss = statusStyle[req.status] || statusStyle.pending
              return (
                <div key={req.id} style={styles.requestRow}>
                  <div style={styles.requestInfo}>
                    <div style={styles.requestEvent}>{req.events?.name || 'Event'}</div>
                    <div style={styles.requestSub}>
                      Sub: <strong>{req.sub_first_name} {req.sub_last_name}</strong>
                      {req.sub_handicap != null && ` (Hcp ${req.sub_handicap})`}
                    </div>
                    {req.events?.start_date && (
                      <div style={styles.requestDate}>
                        {new Date(req.events.start_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                      </div>
                    )}
                  </div>
                  <div style={{ ...styles.statusBadge, background: ss.bg, color: ss.color }}>
                    {req.status === 'approved' ? '✓ Approved'
                      : req.status === 'denied' ? '✗ Denied'
                      : '⏳ Pending'}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--off-white)', overflowY: 'auto' },
  centered: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16, padding: 24, textAlign: 'center' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', background: 'var(--green-dark)', color: 'var(--white)', flexShrink: 0 },
  headerBack: { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: 500, width: 52 },
  headerTitle: { fontSize: 17, fontWeight: 800, color: 'var(--white)' },
  toast: { position: 'fixed', top: 16, left: '50%', transform: 'translateX(-50%)', color: 'white', padding: '10px 20px', borderRadius: 20, fontSize: 13, fontWeight: 600, zIndex: 9999, boxShadow: 'var(--shadow-lg)', whiteSpace: 'nowrap' },
  content: { display: 'flex', flexDirection: 'column', gap: 12, padding: '16px 16px 32px' },
  card: { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  cardTitle: { fontSize: 11, fontWeight: 700, color: 'var(--gray-400)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 14 },
  infoBox: { display: 'flex', gap: 12, alignItems: 'flex-start', background: 'var(--green-xlight)', border: '1px solid var(--green)', borderRadius: 'var(--radius-sm)', padding: '12px 14px' },
  infoIcon: { fontSize: 18, flexShrink: 0, marginTop: 1 },
  infoText: { fontSize: 13, color: 'var(--green-dark)', lineHeight: 1.5 },
  newRequestBtn: { width: '100%', padding: '14px', background: 'var(--green)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: 15, fontWeight: 700, boxShadow: '0 2px 8px rgba(45,106,79,0.3)' },
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 5 },
  row: { display: 'flex', gap: 10 },
  label: { fontSize: 11, fontWeight: 600, color: 'var(--gray-600)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  input: { padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: 14, background: 'var(--gray-100)', color: 'var(--black)' },
  select: { padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: 14, background: 'var(--gray-100)', color: 'var(--black)' },
  formActions: { display: 'flex', gap: 10, marginTop: 4 },
  submitBtn: { flex: 2, padding: '13px', background: 'var(--green)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: 14, fontWeight: 700 },
  cancelBtn: { flex: 1, padding: '13px', background: 'var(--gray-100)', color: 'var(--gray-600)', borderRadius: 'var(--radius-sm)', fontSize: 14 },
  requestRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--gray-100)', gap: 10 },
  requestInfo: { flex: 1 },
  requestEvent: { fontSize: 14, fontWeight: 700, color: 'var(--black)' },
  requestSub: { fontSize: 12, color: 'var(--gray-500)', marginTop: 3 },
  requestDate: { fontSize: 11, color: 'var(--gray-400)', marginTop: 2 },
  statusBadge: { fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 20, flexShrink: 0 },
  emptyText: { fontSize: 13, color: 'var(--gray-400)', textAlign: 'center', padding: '12px 0' },
  backBtn: { padding: '10px 24px', background: 'var(--green)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: 14, fontWeight: 700 },
  subPickerScroll: { display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4, WebkitOverflowScrolling: 'touch' },
  subChip: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '8px 12px', borderRadius: 10, border: '1.5px solid var(--gray-200)', background: 'var(--gray-100)', cursor: 'pointer', flexShrink: 0, minWidth: 72 },
  subChipActive: { border: '1.5px solid var(--green)', background: 'var(--green-xlight)' },
  subChipNew: { border: '1.5px solid var(--gray-300)', background: 'var(--white)', color: 'var(--gray-500)' },
  subChipName: { fontSize: 12, fontWeight: 700, color: 'var(--black)', whiteSpace: 'nowrap' },
  subChipHcp: { fontSize: 10, color: 'var(--gray-400)', fontWeight: 500 },
  subPickedNote: { fontSize: 11, color: 'var(--green-dark)', background: 'var(--green-xlight)', borderRadius: 6, padding: '4px 10px', marginTop: 4 },
}

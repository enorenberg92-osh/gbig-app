import React, { useState, useEffect, useRef } from 'react'
import { Target, Lock, Flag, Ban, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import ConfirmDialog from '../ConfirmDialog'

const EMPTY_FORM = {
  name: '',
  start_date: '',
  end_date: '',
  status: 'open',
  notes: '',
  course_id: '',
  hole_event_hole: '',
  hole_event_name: '',
  is_bye: false,
}
const STATUS_OPTIONS = ['open', 'closed', 'cancelled']

export default function AdminSchedule() {
  const { locationId } = useLocation()
  const [events, setEvents] = useState([])
  const [courses, setCourses] = useState([])
  const [league, setLeague] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)
  const [dialog, setDialog] = useState(null)
  const formRef = useRef(null)

  useEffect(() => { if (locationId) loadAll() }, [locationId])

  // Scroll the edit form into view whenever it opens
  useEffect(() => {
    if (showForm && formRef.current) {
      formRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [showForm, editing])

  async function loadAll() {
    const [{ data: evtData }, { data: crsData }, { data: leagueData }] = await Promise.all([
      supabase
        .from('events')
        .select('*, courses(id, name)')
        .eq('location_id', locationId)
        .order('week_number', { ascending: true, nullsFirst: false }),
      supabase
        .from('courses')
        .select('id, name')
        .eq('location_id', locationId)
        .order('name'),
      supabase
        .from('league_config')
        .select('*')
        .eq('location_id', locationId)
        .limit(1)
        .single(),
    ])
    setEvents(evtData || [])
    setCourses(crsData || [])
    setLeague(leagueData || null)
    setLoading(false)
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)

    const payload = {
      name: form.name.trim(),
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      status: form.is_bye ? 'closed' : form.status,
      notes: form.notes.trim() || null,
      course_id: form.is_bye ? null : (form.course_id || null),
      hole_event_hole: form.is_bye ? null : (form.hole_event_hole ? parseInt(form.hole_event_hole, 10) : null),
      hole_event_name: form.is_bye ? null : (form.hole_event_name.trim() || null),
      is_bye: form.is_bye,
    }

    let error
    if (editing) {
      ;({ error } = await supabase.from('events').update(payload).eq('id', editing.id))
    } else {
      ;({ error } = await supabase.from('events').insert({ ...payload, location_id: locationId }))
    }

    setSaving(false)
    if (error) {
      showToast('Error: ' + error.message, 'error')
    } else {
      showToast(editing ? 'Event updated!' : 'Event created!')
      setShowForm(false)
      setEditing(null)
      setForm(EMPTY_FORM)
      loadAll()
    }
  }

  async function handleStatusChange(event, newStatus) {
    // Guard: only one event can be open at a time
    if (newStatus === 'open') {
      const alreadyOpen = events.find(e => e.status === 'open' && e.id !== event.id)
      if (alreadyOpen) {
        const wkLabel = alreadyOpen.week_number != null ? `Week ${alreadyOpen.week_number}` : (alreadyOpen.name || 'another event')
        showToast(`${wkLabel} is already open. Close it first before opening this one.`, 'error')
        return
      }
    }

    const { error } = await supabase
      .from('events')
      .update({ status: newStatus })
      .eq('id', event.id)

    if (error) {
      showToast('Error: ' + error.message, 'error')
    } else {
      showToast(`Event marked as ${newStatus}`)
      loadAll()
    }
  }

  function handleDelete(event) {
    setDialog({
      message: `Delete "${event.name}"? All scores for this event will also be deleted.`,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        const { error } = await supabase.from('events').delete().eq('id', event.id)
        if (error) {
          showToast('Error: ' + error.message, 'error')
        } else {
          showToast('Event deleted.')
          loadAll()
        }
      },
    })
  }

  function startEdit(event) {
    setForm({
      name: event.name || '',
      start_date: event.start_date ? event.start_date.split('T')[0] : '',
      end_date: event.end_date ? event.end_date.split('T')[0] : '',
      status: event.status || 'open',
      notes: event.notes || '',
      course_id: event.course_id || '',
      hole_event_hole: event.hole_event_hole != null ? String(event.hole_event_hole) : '',
      hole_event_name: event.hole_event_name || '',
      is_bye: event.is_bye || false,
    })
    setEditing(event)
    setShowForm(true)
  }

  function formatDateRange(start, end) {
    if (!start && !end) return 'No dates set'
    const opts = { month: 'short', day: 'numeric' }
    const yearOpts = { month: 'short', day: 'numeric', year: 'numeric' }
    if (start && end) {
      const s = new Date(start + 'T12:00:00')
      const en = new Date(end + 'T12:00:00')
      const sameYear = s.getFullYear() === en.getFullYear()
      return `${s.toLocaleDateString('en-US', opts)} – ${en.toLocaleDateString('en-US', sameYear ? yearOpts : yearOpts)}`
    }
    if (start) {
      return new Date(start + 'T12:00:00').toLocaleDateString('en-US', yearOpts)
    }
    return new Date(end + 'T12:00:00').toLocaleDateString('en-US', yearOpts)
  }

  // An event is "upcoming" if its start_date is strictly in the future
  function isUpcoming(evt) {
    if (!evt.start_date) return false
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const start = new Date(evt.start_date + 'T00:00:00')
    return start > today
  }

  function getStatusInfo(evt) {
    if (evt.is_bye)                 return { label: 'bye',      bg: '#fff8e1', color: '#7a5c00' }
    if (evt.status === 'cancelled') return { label: 'cancelled', bg: '#fff5f5', color: '#c53030' }
    if (evt.status === 'closed')    return { label: 'closed',    bg: '#f1f3f5', color: '#6c757d' }
    if (evt.status === 'open')      return { label: 'open',      bg: '#d8f3dc', color: '#2d6a4f' }
    if (isUpcoming(evt))            return { label: 'upcoming',  bg: '#f1f3f5', color: '#6c757d' }
    return                                 { label: 'active',    bg: '#d8f3dc', color: '#2d6a4f' }
  }

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

      <button style={styles.addBtn} onClick={() => { setShowForm(true); setEditing(null); setForm(EMPTY_FORM) }}>
        + Create New Event / Round
      </button>

      {/* Form */}
      {showForm && (
        <div ref={formRef} style={styles.card}>
          <h3 style={styles.cardTitle}>{editing ? 'Edit Event' : 'New Event'}</h3>
          <form onSubmit={handleSave} style={styles.form}>

            {/* Event Name */}
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Event Name *</label>
              <input
                style={styles.input}
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Week 4 — Pebble Beach"
                required
              />
            </div>

            {/* Bye Week Toggle */}
            <div
              style={{
                ...styles.byeToggleRow,
                background: form.is_bye ? '#fff8e1' : 'var(--gray-100)',
                border: `1.5px solid ${form.is_bye ? '#f6c90e' : 'var(--gray-200)'}`,
              }}
              onClick={() => setForm(f => ({ ...f, is_bye: !f.is_bye }))}
            >
              <div style={styles.byeToggleLeft}>
                <span style={styles.byeToggleEmoji}>
                  <Ban size={20} strokeWidth={2} color={form.is_bye ? '#b45309' : 'var(--gray-500)'} />
                </span>
                <div>
                  <div style={styles.byeToggleLabel}>Bye Week</div>
                  <div style={styles.byeToggleSub}>No play this week — removes from score entry &amp; handicap</div>
                </div>
              </div>
              <div style={{
                ...styles.byeToggleSwitch,
                background: form.is_bye ? '#f6c90e' : 'var(--gray-200)',
              }}>
                <div style={{
                  ...styles.byeToggleKnob,
                  transform: form.is_bye ? 'translateX(18px)' : 'translateX(0)',
                }} />
              </div>
            </div>

            {/* Date Range */}
            <div style={styles.row}>
              <div style={{ ...styles.fieldGroup, flex: 1 }}>
                <label style={styles.label}>Start Date</label>
                <input
                  type="date"
                  style={styles.input}
                  value={form.start_date}
                  onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
                />
              </div>
              <div style={{ ...styles.fieldGroup, flex: 1 }}>
                <label style={styles.label}>End Date</label>
                <input
                  type="date"
                  style={styles.input}
                  value={form.end_date}
                  onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
                />
              </div>
            </div>

            {/* Course + Status (hidden for bye weeks) */}
            {!form.is_bye && <div style={styles.row}>
              <div style={{ ...styles.fieldGroup, flex: 2 }}>
                <label style={styles.label}>Course</label>
                <select
                  style={styles.select}
                  value={form.course_id}
                  onChange={e => setForm(f => ({ ...f, course_id: e.target.value }))}
                >
                  <option value="">— Select a course —</option>
                  {courses.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div style={{ ...styles.fieldGroup, flex: 1 }}>
                <label style={styles.label}>Status</label>
                <select
                  style={styles.select}
                  value={form.status}
                  onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                >
                  {STATUS_OPTIONS.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>}

            {/* Notes */}
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Notes (optional)</label>
              <input
                style={styles.input}
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="e.g. Scramble format, $5 skins buy-in"
              />
            </div>

            {/* Hole Event Section (hidden for bye weeks) */}
            {!form.is_bye && <div style={styles.holeEventBox}>
              <div style={styles.holeEventTitle}>
                <Target size={15} strokeWidth={2.25} style={{ verticalAlign: '-2px', marginRight: 7, color: 'var(--green-dark)' }} />
                Weekly Hole Event
              </div>
              <div style={styles.holeEventSub}>Players will see this displayed on the designated hole during score entry.</div>
              <div style={styles.row}>
                <div style={{ ...styles.fieldGroup, width: '90px' }}>
                  <label style={styles.label}>Hole #</label>
                  <select
                    style={styles.select}
                    value={form.hole_event_hole}
                    onChange={e => setForm(f => ({ ...f, hole_event_hole: e.target.value }))}
                  >
                    <option value="">—</option>
                    {[1,2,3,4,5,6,7,8,9].map(n => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
                <div style={{ ...styles.fieldGroup, flex: 1 }}>
                  <label style={styles.label}>Event Name</label>
                  <input
                    style={styles.input}
                    value={form.hole_event_name}
                    onChange={e => setForm(f => ({ ...f, hole_event_name: e.target.value }))}
                    placeholder="e.g. Closest to the Pin, Long Drive"
                  />
                </div>
              </div>
            </div>}

            <div style={styles.formActions}>
              <button type="submit" style={styles.saveBtn} disabled={saving}>
                {saving ? 'Saving…' : editing ? 'Update Event' : 'Create Event'}
              </button>
              <button type="button" style={styles.cancelBtn} onClick={() => { setShowForm(false); setEditing(null) }}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Events List */}
      <div style={styles.card}>
        <div style={styles.cardTitleRow}>
          <div>
            <h3 style={styles.cardTitle}>
              {league?.name || 'League Schedule'}
            </h3>
            {league && (
              <div style={styles.leagueMeta}>
                {league.num_weeks && <span>{league.num_weeks} weeks</span>}
                {league.start_date && (
                  <span>
                    · Starting {new Date(league.start_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </span>
                )}
              </div>
            )}
          </div>
          <span style={styles.count}>{events.filter(e => !e.is_bye).length} rounds</span>
        </div>

        {events.length === 0 ? (
          <p style={styles.empty}>No events yet — create your first round above.</p>
        ) : (
          events.map(evt => {
            const isBye     = !!evt.is_bye
            const upcoming  = !isBye && isUpcoming(evt) && evt.status !== 'open'
            const statusInfo = getStatusInfo(evt)
            const courseName = evt.courses?.name || null
            return (
              <div key={evt.id} style={{
                ...styles.eventRow,
                opacity:    isBye ? 0.65 : upcoming ? 0.72 : 1,
                background: isBye ? '#fffdf0' : 'transparent',
              }}>
                <div style={styles.eventMain}>
                  <div style={styles.eventName}>
                    {evt.week_number != null && (
                      <span style={styles.weekBadge}>Wk {evt.week_number}</span>
                    )}
                    {isBye
                      ? <span style={styles.byeLabel}>
                          <Ban size={13} strokeWidth={2.25} style={{ verticalAlign: '-2px', marginRight: 5 }} />
                          BYE WEEK
                        </span>
                      : (evt.name || 'Unnamed Event')
                    }
                    {upcoming && (
                      <span style={styles.lockIcon} title="Hidden from players until this week arrives">
                        <Lock size={13} strokeWidth={2.25} />
                      </span>
                    )}
                  </div>
                  {!isBye && (
                    <div style={styles.eventMeta}>
                      {formatDateRange(evt.start_date, evt.end_date)}
                      {courseName && !upcoming && (
                        <span style={styles.coursePill}>
                          <Flag size={11} strokeWidth={2.25} style={{ verticalAlign: '-1px', marginRight: 5 }} />
                          {courseName}
                        </span>
                      )}
                      {courseName && upcoming && (
                        <span style={styles.coursePillLocked}>
                          <Flag size={11} strokeWidth={2.25} style={{ verticalAlign: '-1px', marginRight: 5 }} />
                          {courseName} — hidden from players
                        </span>
                      )}
                    </div>
                  )}
                  {isBye && (
                    <div style={styles.eventMeta}>{formatDateRange(evt.start_date, evt.end_date)}</div>
                  )}
                  {!isBye && evt.notes && (
                    <div style={styles.notesLine}>{evt.notes}</div>
                  )}
                  {!isBye && evt.hole_event_name && (
                    <div style={styles.holeEventTag}>
                      <Target size={12} strokeWidth={2.25} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                      Hole {evt.hole_event_hole}: {evt.hole_event_name}
                    </div>
                  )}
                </div>
                <div style={styles.eventRight}>
                  <span style={{ ...styles.badge, background: statusInfo.bg, color: statusInfo.color }}>
                    {statusInfo.label}
                  </span>
                  <div style={styles.eventActions}>
                    {/* Close Out only available once the week has arrived */}
                    {!isBye && !upcoming && evt.status === 'open' && (
                      <button style={styles.closeBtn} onClick={() => handleStatusChange(evt, 'closed')}>Close Out</button>
                    )}
                    {!isBye && evt.status === 'closed' && (
                      <button style={styles.reopenBtn} onClick={() => handleStatusChange(evt, 'open')}>Reopen</button>
                    )}
                    <button style={styles.editBtn} onClick={() => startEdit(evt)}>Edit</button>
                    <button style={styles.deleteBtn} onClick={() => handleDelete(evt)} aria-label="Delete event">
                      <X size={15} strokeWidth={2.5} />
                    </button>
                  </div>
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
  addBtn: { width: '100%', padding: '13px', background: 'var(--green)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: '15px', fontWeight: 700, boxShadow: '0 2px 8px rgba(45,106,79,0.3)' },
  card: { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  cardTitleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' },
  cardTitle: { fontSize: '14px', fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '3px' },
  leagueMeta: { fontSize: '12px', color: 'var(--gray-400)', fontWeight: 400, display: 'flex', gap: '4px', textTransform: 'none', letterSpacing: 'normal' },
  count: { fontSize: '13px', fontWeight: 700, color: 'var(--green)', background: 'var(--green-xlight)', padding: '2px 10px', borderRadius: '20px' },
  form: { display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '12px' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: '5px' },
  row: { display: 'flex', gap: '12px' },
  label: { fontSize: '11px', fontWeight: 600, color: 'var(--gray-600)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  input: { padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--gray-100)', color: 'var(--black)' },
  select: { padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--gray-100)', color: 'var(--black)' },
  formActions: { display: 'flex', gap: '10px' },
  saveBtn: { flex: 1, padding: '12px', background: 'var(--green)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700 },
  cancelBtn: { flex: 1, padding: '12px', background: 'var(--gray-100)', color: 'var(--gray-600)', borderRadius: 'var(--radius-sm)', fontSize: '14px' },
  empty: { fontSize: '13px', color: 'var(--gray-400)', textAlign: 'center', padding: '16px 0' },
  eventRow: { padding: '12px 0', borderBottom: '1px solid var(--gray-100)', display: 'flex', justifyContent: 'space-between', gap: '10px' },
  eventMain: { flex: 1, minWidth: 0 },
  eventName: { fontSize: '14px', fontWeight: 600, color: 'var(--black)' },
  eventMeta: { fontSize: '12px', color: 'var(--gray-400)', marginTop: '3px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
  coursePill:       { fontSize: '11px', color: 'var(--green-dark)', fontWeight: 600, background: 'var(--green-xlight)', padding: '1px 7px', borderRadius: '10px' },
  coursePillLocked: { fontSize: '11px', color: 'var(--gray-400)', fontWeight: 500, background: 'var(--gray-100)', padding: '1px 7px', borderRadius: '10px', fontStyle: 'italic' },
  lockIcon:         { display: 'inline-flex', alignItems: 'center', marginLeft: '6px', color: 'var(--gray-500)', opacity: 0.7 },
  notesLine: { fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px', fontStyle: 'italic' },
  eventRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '6px', flexShrink: 0 },
  badge: { fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '20px', textTransform: 'uppercase', letterSpacing: '0.3px' },
  eventActions: { display: 'flex', gap: '5px' },
  closeBtn: { fontSize: '11px', color: '#7a5c00', fontWeight: 700, padding: '4px 8px', background: 'var(--gold-light)', borderRadius: '6px' },
  reopenBtn: { fontSize: '11px', color: 'var(--green)', fontWeight: 700, padding: '4px 8px', background: 'var(--green-xlight)', borderRadius: '6px' },
  editBtn: { fontSize: '11px', color: 'var(--green)', fontWeight: 600, padding: '4px 8px', background: 'var(--green-xlight)', borderRadius: '6px' },
  deleteBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: '#c53030', padding: '5px 8px', background: '#fff5f5', border: '1px solid #fecaca', borderRadius: '6px', cursor: 'pointer' },
  holeEventBox: { background: 'var(--green-xlight)', border: '1.5px solid var(--green)', borderRadius: 'var(--radius-sm)', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' },
  holeEventTitle: { fontSize: '13px', fontWeight: 700, color: 'var(--green-dark)' },
  holeEventSub: { fontSize: '11px', color: 'var(--green-dark)', opacity: 0.8, marginTop: '-6px' },
  holeEventTag: { fontSize: '11px', color: 'var(--green-dark)', fontWeight: 600, marginTop: '3px', background: 'var(--green-xlight)', display: 'inline-block', padding: '2px 8px', borderRadius: '10px' },
  weekBadge: { fontSize: '10px', fontWeight: 800, color: 'var(--white)', background: 'var(--green)', padding: '2px 7px', borderRadius: '20px', marginRight: '7px', letterSpacing: '0.3px' },
  byeLabel: { fontSize: '14px', fontWeight: 700, color: '#7a5c00', fontStyle: 'italic' },
  byeToggleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', userSelect: 'none', gap: '12px' },
  byeToggleLeft: { display: 'flex', alignItems: 'center', gap: '10px' },
  byeToggleEmoji: { display: 'flex', alignItems: 'center', flexShrink: 0 },
  byeToggleLabel: { fontSize: '13px', fontWeight: 700, color: 'var(--black)' },
  byeToggleSub: { fontSize: '11px', color: 'var(--gray-400)', marginTop: '1px' },
  byeToggleSwitch: { width: '38px', height: '20px', borderRadius: '20px', padding: '2px', flexShrink: 0, transition: 'background 0.2s', position: 'relative' },
  byeToggleKnob: { width: '16px', height: '16px', background: 'white', borderRadius: '50%', boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'transform 0.2s' },
}

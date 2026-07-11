import React, { useState, useEffect } from 'react'
import {
  CalendarDays, Plus, Pencil, Trash2, Users, ChevronDown, ChevronUp,
  CalendarX, Inbox,
} from 'lucide-react'
import { Button, Toast, Callout, EmptyState, Input } from '../ui'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import ConfirmDialog from '../ConfirmDialog'

// ─────────────────────────────────────────────────────────────────────────────
//  AdminEvents — CRUD + attendee tracking for the app_events table.
//
//  Players RSVP from EventsPage; admins manage events and capacity here.
//  We load all signups for the location in one query and bucket them per
//  event client-side (tens of events × a few signups each, not worth a
//  per-row fetch).
// ─────────────────────────────────────────────────────────────────────────────

const BLANK_FORM = {
  id:          null,
  title:       '',
  description: '',
  event_date:  '',
  capacity:    '',  // empty string = unlimited when saved
}

export default function AdminEvents() {
  const { locationId } = useLocation()

  const [events, setEvents]                 = useState([])
  const [signupsByEvent, setSignupsByEvent] = useState({}) // eventId -> [{player_id, name, email, created_at}]
  const [loading, setLoading]               = useState(true)
  const [toast, setToast]                   = useState(null)

  const [editing, setEditing]               = useState(false)   // bool — form open?
  const [form, setForm]                     = useState(BLANK_FORM)
  const [saving, setSaving]                 = useState(false)

  const [expandedId, setExpandedId]         = useState(null)    // which attendee list is open
  const [dialog, setDialog]                 = useState(null)

  useEffect(() => { if (locationId) load() }, [locationId])

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function load() {
    setLoading(true)
    const [
      { data: evRows,    error: evErr },
      { data: signups,   error: suErr },
      { data: players },
    ] = await Promise.all([
      supabase.from('app_events')
        .select('id, title, description, event_date, capacity, created_at')
        .eq('location_id', locationId)
        .order('event_date', { ascending: true }),
      supabase.from('event_signups')
        .select('id, event_id, player_id, created_at')
        .eq('location_id', locationId)
        .order('created_at', { ascending: true }),
      supabase.from('players')
        .select('id, name, first_name, last_name, email')
        .eq('location_id', locationId),
    ])

    if (evErr) console.error('AdminEvents events error:', evErr.message)
    if (suErr) console.error('AdminEvents signups error:', suErr.message)

    // Build an eventId → list-of-signups map with the player details joined in.
    const playerById = {}
    ;(players || []).forEach(p => { playerById[p.id] = p })
    const byEvent = {}
    ;(signups || []).forEach(s => {
      const p = playerById[s.player_id]
      const entry = {
        signup_id:  s.id,
        player_id:  s.player_id,
        created_at: s.created_at,
        name:       p?.name || [p?.first_name, p?.last_name].filter(Boolean).join(' ') || 'Unknown player',
        email:      p?.email || null,
      }
      if (!byEvent[s.event_id]) byEvent[s.event_id] = []
      byEvent[s.event_id].push(entry)
    })

    setEvents(evRows || [])
    setSignupsByEvent(byEvent)
    setLoading(false)
  }

  // ── Form controls ──────────────────────────────────────────────────────────
  function openNew() {
    setForm(BLANK_FORM)
    setEditing(true)
  }
  function openEdit(evt) {
    setForm({
      id:          evt.id,
      title:       evt.title || '',
      description: evt.description || '',
      // <input type="date"> wants yyyy-MM-dd. event_date is already DATE in PG.
      event_date:  evt.event_date ? String(evt.event_date).slice(0, 10) : '',
      capacity:    evt.capacity == null ? '' : String(evt.capacity),
    })
    setEditing(true)
  }
  function closeForm() {
    setEditing(false)
    setForm(BLANK_FORM)
  }

  async function saveForm() {
    const title = form.title.trim()
    if (!title)             { showToast('Event title is required.', 'error'); return }
    if (!form.event_date)   { showToast('Event date is required.', 'error'); return }

    // Capacity: empty string → null (unlimited), otherwise positive integer.
    let capacity = null
    if (form.capacity !== '' && form.capacity != null) {
      const n = parseInt(form.capacity, 10)
      if (!Number.isFinite(n) || n < 0) {
        showToast('Capacity must be a non-negative whole number.', 'error'); return
      }
      capacity = n
    }

    setSaving(true)
    const payload = {
      title,
      description: form.description.trim() || null,
      event_date:  form.event_date,
      capacity,
      location_id: locationId,
    }

    let error
    if (form.id) {
      ;({ error } = await supabase.from('app_events').update(payload).eq('id', form.id).eq('location_id', locationId))
    } else {
      ;({ error } = await supabase.from('app_events').insert(payload))
    }
    setSaving(false)

    if (error) { showToast('Error: ' + error.message, 'error'); return }
    showToast(form.id ? 'Event updated.' : 'Event created.')
    closeForm()
    load()
  }

  function deleteEvent(evt) {
    const signupCount = (signupsByEvent[evt.id] || []).length
    setDialog({
      message: signupCount > 0
        ? `Delete "${evt.title}" and its ${signupCount} RSVP${signupCount === 1 ? '' : 's'}?`
        : `Delete "${evt.title}"?`,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        // event_signups cascades via FK; just delete the parent row.
        const { error } = await supabase.from('app_events').delete().eq('id', evt.id).eq('location_id', locationId)
        if (error) { showToast('Error: ' + error.message, 'error'); return }
        showToast('Event deleted.')
        load()
      },
    })
  }

  // Remove one signup as an admin — e.g. player asked to be removed after
  // RSVPing and can no longer self-cancel (wrong account).
  function removeSignup(eventId, signup) {
    setDialog({
      message: `Remove ${signup.name} from this event?`,
      confirmLabel: 'Remove',
      onConfirm: async () => {
        const { error } = await supabase.from('event_signups').delete().eq('id', signup.signup_id).eq('location_id', locationId)
        if (error) { showToast('Error: ' + error.message, 'error'); return }
        showToast(`${signup.name} removed.`)
        load()
      },
    })
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) return <div style={styles.loading}>Loading…</div>

  const today = new Date(); today.setHours(0, 0, 0, 0)
  const upcoming = events.filter(e => e.event_date && new Date(e.event_date + 'T00:00:00') >= today)
  const past     = events.filter(e => !e.event_date || new Date(e.event_date + 'T00:00:00') <  today)

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

      {/* New / edit form — inline at top when open. Keeps admin on one page. */}
      {editing ? (
        <EventForm
          form={form}
          setForm={setForm}
          saving={saving}
          onCancel={closeForm}
          onSave={saveForm}
        />
      ) : (
        <Button
          variant="primary"
          icon={<Plus size={16} strokeWidth={2.5} />}
          onClick={openNew}
          fullWidth
        >
          New Event
        </Button>
      )}

      {events.length === 0 && !editing ? (
        <EmptyState
          icon={<CalendarX size={38} strokeWidth={1.5} />}
          title="No events yet"
          description="Create a tournament, social, or clinic to let members sign up."
        />
      ) : (
        <>
          <EventSection
            title="Upcoming"
            events={upcoming}
            signupsByEvent={signupsByEvent}
            expandedId={expandedId}
            setExpandedId={setExpandedId}
            onEdit={openEdit}
            onDelete={deleteEvent}
            onRemoveSignup={removeSignup}
            emptyText="No upcoming events."
          />

          {past.length > 0 && (
            <EventSection
              title="Past"
              events={past}
              signupsByEvent={signupsByEvent}
              expandedId={expandedId}
              setExpandedId={setExpandedId}
              onEdit={openEdit}
              onDelete={deleteEvent}
              onRemoveSignup={removeSignup}
              dimmed
            />
          )}
        </>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function EventForm({ form, setForm, saving, onCancel, onSave }) {
  const isEdit = !!form.id
  return (
    <div style={styles.formCard}>
      <div style={styles.formTitleRow}>
        <h3 style={styles.formTitle}>{isEdit ? 'Edit Event' : 'New Event'}</h3>
      </div>

      <Input
        label="Title"
        placeholder="e.g. Summer Kickoff Tournament"
        value={form.title}
        onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
        required
      />

      <div style={{ height: 12 }} />

      <Input
        label="Date"
        type="date"
        value={form.event_date}
        onChange={e => setForm(f => ({ ...f, event_date: e.target.value }))}
        required
      />

      <div style={{ height: 12 }} />

      <Input
        label="Capacity (optional)"
        type="number"
        inputMode="numeric"
        min="0"
        step="1"
        placeholder="Leave blank for unlimited"
        value={form.capacity}
        onChange={e => setForm(f => ({ ...f, capacity: e.target.value }))}
        helperText="Max number of players who can sign up. Leave blank for unlimited."
      />

      <div style={{ height: 12 }} />

      <label style={styles.formLabel}>Description</label>
      <textarea
        style={styles.formTextarea}
        rows={3}
        value={form.description}
        onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
        placeholder="Details members will see — format, entry fee, tee times, etc."
      />

      <div style={styles.formActions}>
        <Button variant="secondary" onClick={onCancel} disabled={saving} style={{ flex: 1 }}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={onSave}
          loading={saving}
          loadingText="Saving…"
          style={{ flex: 2 }}
        >
          {isEdit ? 'Save Changes' : 'Create Event'}
        </Button>
      </div>
    </div>
  )
}

function EventSection({
  title, events, signupsByEvent, expandedId, setExpandedId,
  onEdit, onDelete, onRemoveSignup, emptyText, dimmed,
}) {
  if (events.length === 0 && !emptyText) return null

  return (
    <div style={{ ...styles.section, opacity: dimmed ? 0.85 : 1 }}>
      <div style={styles.sectionHeader}>
        <h3 style={styles.sectionTitle}>{title}</h3>
        <span style={styles.sectionCount}>{events.length}</span>
      </div>

      {events.length === 0 ? (
        <div style={styles.sectionEmpty}>{emptyText}</div>
      ) : (
        events.map(evt => {
          const signups  = signupsByEvent[evt.id] || []
          const expanded = expandedId === evt.id
          const capTxt   = evt.capacity == null
            ? `${signups.length} signed up`
            : `${signups.length} / ${evt.capacity} signed up`
          const isFull   = evt.capacity != null && signups.length >= evt.capacity

          return (
            <div key={evt.id} style={styles.eventCard}>
              <div style={styles.eventTop}>
                <div style={styles.eventDateChip}>
                  <CalendarDays size={14} strokeWidth={2} style={{ marginRight: 4 }} />
                  {formatDate(evt.event_date)}
                </div>
                <div style={styles.eventActions}>
                  <button
                    type="button"
                    style={styles.iconBtn}
                    onClick={() => onEdit(evt)}
                    title="Edit event"
                  >
                    <Pencil size={14} strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    style={{ ...styles.iconBtn, color: '#c53030' }}
                    onClick={() => onDelete(evt)}
                    title="Delete event"
                  >
                    <Trash2 size={14} strokeWidth={2} />
                  </button>
                </div>
              </div>

              <div style={styles.eventTitleText}>{evt.title}</div>
              {evt.description && (
                <div style={styles.eventDesc}>{evt.description}</div>
              )}

              <button
                type="button"
                onClick={() => setExpandedId(expanded ? null : evt.id)}
                style={{
                  ...styles.attendeesToggle,
                  color: isFull ? '#c53030' : 'var(--green-dark)',
                  borderColor: isFull ? '#fecaca' : 'var(--green)',
                  background: isFull ? '#fff5f5' : 'var(--green-xlight)',
                }}
              >
                <Users size={13} strokeWidth={2.25} style={{ marginRight: 6 }} />
                {capTxt}
                {isFull && <span style={styles.fullTag}>FULL</span>}
                <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
                  {expanded
                    ? <ChevronUp   size={14} strokeWidth={2} />
                    : <ChevronDown size={14} strokeWidth={2} />}
                </span>
              </button>

              {expanded && (
                <div style={styles.attendeesList}>
                  {signups.length === 0 ? (
                    <div style={styles.attendeesEmpty}>
                      <Inbox size={14} strokeWidth={1.75} style={{ marginRight: 6, verticalAlign: '-2px' }} />
                      No RSVPs yet.
                    </div>
                  ) : (
                    signups.map(s => (
                      <div key={s.signup_id} style={styles.attendeeRow}>
                        <div style={styles.attendeeAvatar}>
                          {(s.name[0] || '?').toUpperCase()}
                        </div>
                        <div style={styles.attendeeInfo}>
                          <div style={styles.attendeeName}>{s.name}</div>
                          {s.email && <div style={styles.attendeeEmail}>{s.email}</div>}
                        </div>
                        <button
                          type="button"
                          style={styles.attendeeRemove}
                          onClick={() => onRemoveSignup(evt.id, s)}
                          title="Remove RSVP"
                        >
                          <Trash2 size={12} strokeWidth={2} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )
        })
      )}
    </div>
  )
}

function formatDate(d) {
  if (!d) return 'TBD'
  // Treat bare DATE strings as local (not UTC) so a 2026-04-25 event doesn't
  // render as Apr 24 in Central Time.
  const dt = new Date(d + 'T00:00:00')
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

const styles = {
  container: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' },
  loading:   { padding: '40px', textAlign: 'center', color: 'var(--gray-400)' },

  formCard: {
    background: 'var(--white)',
    borderRadius: 'var(--radius)',
    padding: '16px',
    boxShadow: 'var(--shadow)',
    border: '1.5px solid var(--green)',
  },
  formTitleRow: { marginBottom: 12 },
  formTitle:    { fontSize: '15px', fontWeight: 800, color: 'var(--green-dark)' },
  formLabel: {
    display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--gray-500)',
    textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: 6,
  },
  formTextarea: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 'var(--radius-sm)',
    border: '1.5px solid var(--gray-200)',
    background: 'var(--white)',
    color: 'var(--black)',
    fontFamily: 'inherit',
    fontSize: 14,
    outline: 'none',
    resize: 'vertical',
    boxSizing: 'border-box',
  },
  formActions: { display: 'flex', gap: 8, marginTop: 16 },

  section:       {},
  sectionHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, padding: '0 4px' },
  sectionTitle:  { fontSize: '13px', fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  sectionCount:  { fontSize: '12px', fontWeight: 700, color: 'var(--green)', background: 'var(--green-xlight)', padding: '2px 10px', borderRadius: '20px' },
  sectionEmpty:  { fontSize: 13, color: 'var(--gray-400)', textAlign: 'center', padding: '16px 0', fontStyle: 'italic' },

  eventCard: {
    background: 'var(--white)',
    borderRadius: 'var(--radius)',
    padding: '14px',
    marginBottom: 10,
    boxShadow: 'var(--shadow)',
    border: '1px solid var(--gray-200)',
  },
  eventTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  eventDateChip: {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 12,
    fontWeight: 700,
    color: 'var(--green-dark)',
    background: 'var(--green-xlight)',
    padding: '4px 10px',
    borderRadius: 20,
  },
  eventActions: { display: 'flex', gap: 4 },
  iconBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 28, height: 28, borderRadius: 6,
    background: 'transparent', color: 'var(--gray-600)',
    border: '1px solid var(--gray-200)',
    cursor: 'pointer', transition: 'all 0.12s ease',
  },
  eventTitleText: { fontSize: 15, fontWeight: 700, color: 'var(--black)', marginBottom: 4 },
  eventDesc:      { fontSize: 13, color: 'var(--gray-600)', marginBottom: 10, lineHeight: 1.4 },

  attendeesToggle: {
    display: 'flex', alignItems: 'center',
    width: '100%',
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    transition: 'all 0.12s ease',
  },
  fullTag: {
    marginLeft: 8,
    fontSize: 10,
    fontWeight: 800,
    padding: '2px 6px',
    borderRadius: 4,
    background: '#c53030',
    color: '#fff',
    letterSpacing: '0.3px',
  },

  attendeesList: {
    marginTop: 10,
    padding: 10,
    background: 'var(--off-white)',
    borderRadius: 8,
    border: '1px dashed var(--gray-200)',
  },
  attendeesEmpty: { fontSize: 12, color: 'var(--gray-500)', textAlign: 'center', fontStyle: 'italic' },

  attendeeRow: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '6px 4px',
    borderBottom: '1px solid var(--gray-100)',
  },
  attendeeAvatar: {
    width: 28, height: 28, borderRadius: '50%',
    background: 'var(--green-xlight)', color: 'var(--green-dark)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 12, fontWeight: 800, flexShrink: 0,
  },
  attendeeInfo:   { flex: 1, minWidth: 0 },
  attendeeName:   { fontSize: 13, fontWeight: 700, color: 'var(--black)' },
  attendeeEmail:  { fontSize: 11, color: 'var(--gray-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  attendeeRemove: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    width: 24, height: 24, borderRadius: 6,
    background: '#fff5f5', color: '#c53030',
    border: '1px solid #fecaca', cursor: 'pointer',
  },
}

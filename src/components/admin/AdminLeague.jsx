import React, { useState, useEffect } from 'react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import ConfirmDialog from '../ConfirmDialog'

const EMPTY_FORM = { name: '', num_weeks: '', start_date: '', is_active: false }

export default function AdminLeague() {
  const { locationId } = useLocation()
  const [leagues, setLeagues]       = useState([])
  const [loading, setLoading]       = useState(true)
  const [showForm, setShowForm]     = useState(false)
  const [form, setForm]             = useState(EMPTY_FORM)
  const [editing, setEditing]       = useState(null)
  const [saving, setSaving]         = useState(false)
  const [toast, setToast]           = useState(null)
  const [weekPreview, setWeekPreview] = useState([])
  const [dialog, setDialog]           = useState(null)

  useEffect(() => { if (locationId) loadLeagues() }, [locationId])

  // Rebuild week preview whenever form dates/weeks change
  useEffect(() => {
    const n = parseInt(form.num_weeks)
    if (!form.start_date || !n || n < 1) { setWeekPreview([]); return }
    const weeks = []
    for (let i = 0; i < n; i++) {
      const start = new Date(form.start_date + 'T12:00:00')
      start.setDate(start.getDate() + i * 7)
      const end = new Date(start)
      end.setDate(end.getDate() + 6)
      weeks.push({
        week:  i + 1,
        start: start.toISOString().split('T')[0],
        end:   end.toISOString().split('T')[0],
      })
    }
    setWeekPreview(weeks)
  }, [form.num_weeks, form.start_date])

  async function loadLeagues() {
    const { data } = await supabase
      .from('league_config')
      .select('*')
      .eq('location_id', locationId)
      .order('start_date', { ascending: false })
    setLeagues(data || [])
    setLoading(false)
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  // ── Set "working with" league ─────────────────────────────────────────────
  async function handleSetWorking(league) {
    // Clear all, then set this one
    const ids = leagues.map(l => l.id)
    await supabase.from('league_config').update({ is_working: false }).in('id', ids)
    await supabase.from('league_config').update({ is_working: true }).eq('id', league.id)
    showToast(`Now working with "${league.name}"`)
    loadLeagues()
  }

  // ── Toggle "display on website" ───────────────────────────────────────────
  async function handleToggleActive(league) {
    const newVal = !league.is_active
    // If activating, deactivate all others first (only one active at a time)
    if (newVal) {
      const ids = leagues.map(l => l.id)
      await supabase.from('league_config').update({ is_active: false }).in('id', ids)
    }
    await supabase.from('league_config').update({ is_active: newVal }).eq('id', league.id)
    showToast(newVal ? `"${league.name}" is now live for players` : `"${league.name}" hidden from players`)
    loadLeagues()
  }

  // ── Save (create or update) ───────────────────────────────────────────────
  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    const payload = {
      name:       form.name.trim(),
      num_weeks:  parseInt(form.num_weeks) || null,
      start_date: form.start_date || null,
      is_active:  form.is_active,
    }
    let error
    if (editing) {
      ;({ error } = await supabase.from('league_config').update(payload).eq('id', editing.id))
    } else {
      // New league — if marked active, deactivate all others first
      if (payload.is_active) {
        const ids = leagues.map(l => l.id)
        if (ids.length) await supabase.from('league_config').update({ is_active: false }).in('id', ids)
      }
      ;({ error } = await supabase.from('league_config').insert({ ...payload, location_id: locationId }))
    }
    setSaving(false)
    if (error) { showToast('Error: ' + error.message, 'error'); return }
    showToast(editing ? 'League updated!' : 'League created!')
    setShowForm(false)
    setEditing(null)
    setForm(EMPTY_FORM)
    loadLeagues()
  }

  function handleDelete(league) {
    setDialog({
      message: `Delete "${league.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        const { error } = await supabase.from('league_config').delete().eq('id', league.id)
        if (error) { showToast('Error: ' + error.message, 'error'); return }
        showToast('League deleted.')
        loadLeagues()
      },
    })
  }

  function handleGenerateSchedule(league) {
    if (!weekPreview.length) return
    setDialog({
      message: `Create ${weekPreview.length} events for "${league?.name || 'this league'}"?\n\nExisting weeks won't be duplicated.`,
      confirmLabel: 'Create Events',
      destructive: false,
      onConfirm: async () => {
        const { data: existing } = await supabase
          .from('events')
          .select('week_number')
          .eq('location_id', locationId)
          .not('week_number', 'is', null)

        const existingWeeks = new Set((existing || []).map(e => e.week_number))
        const toInsert = weekPreview
          .filter(w => !existingWeeks.has(w.week))
          .map(w => ({
            name:        `Week ${w.week}`,
            week_number: w.week,
            start_date:  w.start,
            end_date:    w.end,
            status:      'draft',
            location_id: locationId,
          }))

        if (toInsert.length === 0) {
          showToast('All weeks already exist in the schedule.', 'error')
          return
        }
        const { error } = await supabase.from('events').insert(toInsert)
        if (error) { showToast('Error: ' + error.message, 'error'); return }
        showToast(`✓ ${toInsert.length} week${toInsert.length !== 1 ? 's' : ''} added to Schedule!`)
      },
    })
  }

  function startEdit(league) {
    setForm({
      name:       league.name || '',
      num_weeks:  String(league.num_weeks || ''),
      start_date: league.start_date || '',
      is_active:  league.is_active || false,
    })
    setEditing(league)
    setShowForm(true)
  }

  function formatDate(d) {
    if (!d) return '—'
    return new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  const workingLeague = leagues.find(l => l.is_working)

  if (loading) return <div style={s.loading}>Loading…</div>

  return (
    <div style={s.page}>
      {dialog && (
        <ConfirmDialog
          {...dialog}
          onConfirm={() => { dialog.onConfirm(); setDialog(null) }}
          onCancel={() => setDialog(null)}
        />
      )}
      {toast && (
        <div style={{ ...s.toast, background: toast.type === 'error' ? '#c53030' : 'var(--green)' }}>
          {toast.msg}
        </div>
      )}

      {/* ── Header row ────────────────────────────────────────────────────── */}
      <div style={s.headerRow}>
        <div>
          <div style={s.headerTitle}>
            {workingLeague
              ? <>Working with: <span style={s.workingName}>{workingLeague.name}</span></>
              : 'No league selected'}
          </div>
          <div style={s.headerSub}>{leagues.length} league{leagues.length !== 1 ? 's' : ''} total</div>
        </div>
        <button
          style={s.addBtn}
          onClick={() => { setShowForm(true); setEditing(null); setForm(EMPTY_FORM) }}
        >
          + Add League
        </button>
      </div>

      {/* ── League list ───────────────────────────────────────────────────── */}
      <div style={s.card}>
        {leagues.length === 0 ? (
          <p style={s.empty}>No leagues yet — click "+ Add League" to get started.</p>
        ) : (
          <>
            {/* Table header */}
            <div style={s.tableHeader}>
              <div style={{ flex: 1 }}>League</div>
              <div style={s.colWorking}>Working with</div>
              <div style={s.colDisplay}>Display on website</div>
              <div style={s.colActions} />
            </div>

            {/* Rows */}
            {leagues.map(league => {
              const isWorking = !!league.is_working
              const isActive  = !!league.is_active
              return (
                <div
                  key={league.id}
                  style={{
                    ...s.tableRow,
                    background: isWorking ? 'var(--green-xlight)' : '#fff',
                    borderLeft: isWorking ? '3px solid var(--green)' : '3px solid transparent',
                  }}
                >
                  {/* League info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={s.leagueName}>{league.name}</div>
                    <div style={s.leagueMeta}>
                      {league.num_weeks ? `${league.num_weeks} weeks` : 'No weeks set'}
                      {league.start_date ? ` · Starting ${formatDate(league.start_date)}` : ''}
                    </div>
                  </div>

                  {/* Working with column */}
                  <div style={s.colWorking}>
                    {isWorking ? (
                      <span style={s.workingCheck}>✓</span>
                    ) : (
                      <button style={s.loadBtn} onClick={() => handleSetWorking(league)}>
                        Load League
                      </button>
                    )}
                  </div>

                  {/* Display on website column */}
                  <div style={s.colDisplay}>
                    <button
                      style={s.radioWrap}
                      onClick={() => handleToggleActive(league)}
                      title={isActive ? 'Hide from players' : 'Show to players'}
                    >
                      <div style={{
                        ...s.radio,
                        border: isActive ? '2px solid var(--green)' : '2px solid var(--gray-300)',
                      }}>
                        {isActive && <div style={s.radioDot} />}
                      </div>
                    </button>
                  </div>

                  {/* Actions */}
                  <div style={s.colActions}>
                    <button style={s.editBtn} onClick={() => startEdit(league)}>Edit</button>
                    <button style={s.deleteBtn} onClick={() => handleDelete(league)}>✕</button>
                  </div>
                </div>
              )
            })}
          </>
        )}
      </div>

      {/* ── Create / Edit form ────────────────────────────────────────────── */}
      {showForm && (
        <div style={s.card}>
          <h3 style={s.formTitle}>{editing ? `Edit — ${editing.name}` : 'New League'}</h3>
          <form onSubmit={handleSave} style={s.form}>

            <div style={s.fieldGroup}>
              <label style={s.label}>League Name *</label>
              <input
                style={s.input}
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. GBIG Winter League '26"
                required
              />
            </div>

            <div style={s.row}>
              <div style={{ ...s.fieldGroup, flex: 1 }}>
                <label style={s.label}>Number of Weeks</label>
                <input
                  type="number"
                  min="1"
                  max="52"
                  style={s.input}
                  value={form.num_weeks}
                  onChange={e => setForm(f => ({ ...f, num_weeks: e.target.value }))}
                  placeholder="e.g. 12"
                />
              </div>
              <div style={{ ...s.fieldGroup, flex: 2 }}>
                <label style={s.label}>Season Start Date</label>
                <input
                  type="date"
                  style={s.input}
                  value={form.start_date}
                  onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
                />
              </div>
            </div>
            <div style={s.hint}>The start date is Week 1. Each subsequent week begins 7 days later.</div>

            {/* Display on website toggle */}
            <div
              style={{
                ...s.toggleRow,
                background: form.is_active ? 'var(--green-xlight)' : 'var(--gray-100)',
                border: `1.5px solid ${form.is_active ? 'var(--green)' : 'var(--gray-200)'}`,
              }}
              onClick={() => setForm(f => ({ ...f, is_active: !f.is_active }))}
            >
              <div style={s.toggleLeft}>
                <span style={{ fontSize: '18px' }}>🌐</span>
                <div>
                  <div style={s.toggleLabel}>Display on Website</div>
                  <div style={s.toggleSub}>
                    {form.is_active
                      ? 'This league is visible to players in the app'
                      : 'Hidden from players — only visible in admin'}
                  </div>
                </div>
              </div>
              <div style={{ ...s.switch, background: form.is_active ? 'var(--green)' : 'var(--gray-300)' }}>
                <div style={{ ...s.knob, transform: form.is_active ? 'translateX(18px)' : 'translateX(0)' }} />
              </div>
            </div>

            {/* Schedule preview (only when dates are set) */}
            {weekPreview.length > 0 && (
              <div style={s.previewBox}>
                <div style={s.previewTitle}>📅 Schedule Preview — {weekPreview.length} Weeks</div>
                <p style={s.previewNote}>
                  Click <strong>Generate Schedule</strong> to add these weeks to the Schedule tab.
                </p>
                <div style={s.weekGrid}>
                  {weekPreview.map(w => (
                    <div key={w.week} style={s.weekChip}>
                      <span style={s.weekNum}>Wk {w.week}</span>
                      <span style={s.weekDate}>{formatDate(w.start)}</span>
                      <span style={s.weekArrow}>→</span>
                      <span style={s.weekDate}>{formatDate(w.end)}</span>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  style={s.generateBtn}
                  onClick={() => handleGenerateSchedule(editing)}
                >
                  📅 Generate {weekPreview.length}-Week Schedule
                </button>
              </div>
            )}

            <div style={s.formActions}>
              <button type="submit" style={s.saveBtn} disabled={saving}>
                {saving ? 'Saving…' : editing ? 'Update League' : 'Create League'}
              </button>
              <button
                type="button"
                style={s.cancelBtn}
                onClick={() => { setShowForm(false); setEditing(null); setForm(EMPTY_FORM) }}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Legend */}
      <div style={s.legend}>
        <span style={s.legendItem}><span style={s.legendDot} />Working with = the league you're managing in admin</span>
        <span style={s.legendItem}><span style={{ ...s.legendRadio }} />Display on website = visible to players in the app</span>
      </div>
    </div>
  )
}

const s = {
  page:    { padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '860px' },
  loading: { padding: '60px', textAlign: 'center', color: 'var(--gray-400)' },
  toast:   { position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', color: '#fff', padding: '10px 22px', borderRadius: '20px', fontSize: '13px', fontWeight: 600, zIndex: 9999, boxShadow: 'var(--shadow-lg)', whiteSpace: 'nowrap' },

  // header
  headerRow:   { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  headerTitle: { fontSize: '15px', fontWeight: 600, color: 'var(--black)' },
  workingName: { color: 'var(--green-dark)', fontWeight: 800 },
  headerSub:   { fontSize: '12px', color: 'var(--gray-400)', marginTop: '2px' },
  addBtn:      { padding: '10px 20px', background: 'var(--green)', color: '#fff', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700, cursor: 'pointer', boxShadow: '0 2px 6px rgba(45,106,79,0.25)' },

  // card
  card: { background: '#fff', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)', overflow: 'hidden' },
  empty: { padding: '32px', textAlign: 'center', fontSize: '14px', color: 'var(--gray-400)' },

  // table
  tableHeader: { display: 'flex', alignItems: 'center', padding: '10px 16px', background: 'var(--off-white)', borderBottom: '1px solid var(--gray-200)', fontSize: '11px', fontWeight: 700, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.4px', gap: '12px' },
  tableRow:    { display: 'flex', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid var(--gray-100)', gap: '12px', transition: 'background 0.15s' },
  colWorking:  { width: '120px', flexShrink: 0, textAlign: 'center' },
  colDisplay:  { width: '130px', flexShrink: 0, textAlign: 'center' },
  colActions:  { width: '90px', flexShrink: 0, display: 'flex', gap: '6px', justifyContent: 'flex-end' },

  leagueName:  { fontSize: '14px', fontWeight: 700, color: 'var(--black)' },
  leagueMeta:  { fontSize: '12px', color: 'var(--gray-400)', marginTop: '3px' },

  workingCheck: { fontSize: '20px', color: 'var(--green)', fontWeight: 800 },
  loadBtn:      { fontSize: '12px', fontWeight: 600, color: 'var(--green-dark)', background: 'var(--green-xlight)', padding: '5px 10px', borderRadius: '6px', cursor: 'pointer', border: '1px solid var(--green)', whiteSpace: 'nowrap' },

  radioWrap: { background: 'transparent', cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '4px' },
  radio:     { width: '20px', height: '20px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'border 0.15s', flexShrink: 0 },
  radioDot:  { width: '10px', height: '10px', borderRadius: '50%', background: 'var(--green)' },

  editBtn:   { fontSize: '12px', color: 'var(--green)', fontWeight: 600, padding: '4px 8px', background: 'var(--green-xlight)', borderRadius: '6px', cursor: 'pointer' },
  deleteBtn: { fontSize: '12px', color: '#c53030', fontWeight: 700, padding: '4px 8px', background: '#fff5f5', borderRadius: '6px', cursor: 'pointer' },

  // form
  formTitle:   { fontSize: '15px', fontWeight: 800, color: 'var(--green-dark)', padding: '18px 20px 0', letterSpacing: '-0.1px' },
  form:        { display: 'flex', flexDirection: 'column', gap: '14px', padding: '16px 20px 20px' },
  fieldGroup:  { display: 'flex', flexDirection: 'column', gap: '5px' },
  row:         { display: 'flex', gap: '12px' },
  label:       { fontSize: '11px', fontWeight: 600, color: 'var(--gray-600)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  hint:        { fontSize: '11px', color: 'var(--gray-400)', marginTop: '-6px' },
  input:       { padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--gray-100)', color: 'var(--black)' },

  // toggle
  toggleRow:   { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', userSelect: 'none', gap: '12px' },
  toggleLeft:  { display: 'flex', alignItems: 'center', gap: '10px' },
  toggleLabel: { fontSize: '13px', fontWeight: 700, color: 'var(--black)' },
  toggleSub:   { fontSize: '11px', color: 'var(--gray-500)', marginTop: '2px' },
  switch:      { width: '38px', height: '20px', borderRadius: '20px', padding: '2px', flexShrink: 0, transition: 'background 0.2s', position: 'relative' },
  knob:        { width: '16px', height: '16px', background: '#fff', borderRadius: '50%', boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'transform 0.2s' },

  // schedule preview (inside form)
  previewBox:   { background: 'var(--off-white)', border: '1px solid var(--gray-200)', borderRadius: 'var(--radius-sm)', padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: '10px' },
  previewTitle: { fontSize: '13px', fontWeight: 700, color: 'var(--green-dark)' },
  previewNote:  { fontSize: '12px', color: 'var(--gray-500)', margin: 0, lineHeight: 1.5 },
  weekGrid:     { display: 'flex', flexDirection: 'column', gap: '5px', maxHeight: '200px', overflowY: 'auto' },
  weekChip:     { display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px', background: '#fff', borderRadius: '8px', border: '1px solid var(--gray-200)', fontSize: '12px' },
  weekNum:      { fontWeight: 800, color: 'var(--green-dark)', width: '40px', flexShrink: 0 },
  weekDate:     { color: 'var(--gray-600)', flex: 1 },
  weekArrow:    { color: 'var(--gray-300)', flexShrink: 0 },
  generateBtn:  { padding: '11px', background: 'var(--green-dark)', color: '#fff', borderRadius: 'var(--radius-sm)', fontSize: '13px', fontWeight: 700, cursor: 'pointer', textAlign: 'center' },

  formActions: { display: 'flex', gap: '10px', paddingTop: '4px' },
  saveBtn:     { flex: 1, padding: '12px', background: 'var(--green)', color: '#fff', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700, cursor: 'pointer' },
  cancelBtn:   { flex: 1, padding: '12px', background: 'var(--gray-100)', color: 'var(--gray-600)', borderRadius: 'var(--radius-sm)', fontSize: '14px', cursor: 'pointer' },

  // legend
  legend:      { display: 'flex', gap: '20px', flexWrap: 'wrap' },
  legendItem:  { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--gray-400)' },
  legendDot:   { width: '10px', height: '10px', borderRadius: '50%', background: 'var(--green)', display: 'inline-block', flexShrink: 0 },
  legendRadio: { width: '14px', height: '14px', borderRadius: '50%', border: '2px solid var(--green)', display: 'inline-block', flexShrink: 0 },
}

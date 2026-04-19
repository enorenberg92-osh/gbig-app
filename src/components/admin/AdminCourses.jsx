import React, { useState, useEffect } from 'react'
import { Plus, X, Flag } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import { Button, Toast, EmptyState } from '../ui'
import ConfirmDialog from '../ConfirmDialog'

const DEFAULT_HOLES = 9

function emptyPars(n) {
  return Array(n).fill('')
}

export default function AdminCourses() {
  const { locationId } = useLocation()
  const [courses, setCourses]     = useState([])
  const [loading, setLoading]     = useState(true)
  const [showForm, setShowForm]   = useState(false)
  const [editing, setEditing]     = useState(null)
  const [saving, setSaving]       = useState(false)
  const [toast, setToast]         = useState(null)
  const [expandedId, setExpandedId] = useState(null)
  const [dialog, setDialog]         = useState(null)

  // Form state
  const [courseName, setCourseName] = useState('')
  const [numHoles, setNumHoles]     = useState(DEFAULT_HOLES)
  const [pars, setPars]             = useState(emptyPars(DEFAULT_HOLES))
  const [startHole, setStartHole]   = useState(1) // 1 for front 9, 10 for back 9

  useEffect(() => { if (locationId) load() }, [locationId])

  async function load() {
    const { data } = await supabase
      .from('courses')
      .select('*')
      .eq('location_id', locationId)
      .order('name')
    setCourses(data || [])
    setLoading(false)
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  function handleNumHolesChange(n) {
    setNumHoles(n)
    setPars(emptyPars(n))
    setStartHole(n === 9 ? 1 : 1)
  }

  function updatePar(idx, val) {
    setPars(prev => {
      const updated = [...prev]
      updated[idx] = val
      return updated
    })
  }

  function totalPar() {
    return pars.reduce((sum, p) => sum + (parseInt(p) || 0), 0)
  }

  function resetForm() {
    setCourseName('')
    setNumHoles(DEFAULT_HOLES)
    setPars(emptyPars(DEFAULT_HOLES))
    setStartHole(1)
    setEditing(null)
    setShowForm(false)
  }

  function startEdit(course) {
    setCourseName(course.name || '')
    const hp = course.hole_pars || []
    setNumHoles(hp.length || DEFAULT_HOLES)
    setPars(hp.map(String))
    setStartHole(course.start_hole || 1)
    setEditing(course)
    setShowForm(true)
  }

  async function handleSave(e) {
    e.preventDefault()
    if (!courseName.trim()) return

    const parsedPars = pars.map(p => parseInt(p) || 4) // default par 4
    setSaving(true)

    const payload = {
      name:       courseName.trim(),
      num_holes:  numHoles,
      start_hole: startHole,
      hole_pars:  parsedPars,
      total_par:  parsedPars.reduce((s, p) => s + p, 0),
    }

    let error
    if (editing) {
      ;({ error } = await supabase.from('courses').update(payload).eq('id', editing.id))
    } else {
      ;({ error } = await supabase.from('courses').insert({ ...payload, location_id: locationId }))
    }

    setSaving(false)
    if (error) {
      showToast('Error: ' + error.message, 'error')
    } else {
      showToast(editing ? 'Course updated!' : 'Course created!')
      resetForm()
      load()
    }
  }

  function handleDelete(course) {
    setDialog({
      message: `Delete "${course.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        const { error } = await supabase.from('courses').delete().eq('id', course.id)
        if (error) {
          showToast('Error: ' + error.message, 'error')
        } else {
          showToast('Course deleted.')
          load()
        }
      },
    })
  }

  const parCounts = pars.reduce((acc, p) => {
    const n = parseInt(p)
    if (n) acc[n] = (acc[n] || 0) + 1
    return acc
  }, {})

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

      <Button
        variant="primary"
        size="lg"
        fullWidth
        icon={<Plus size={16} strokeWidth={2.5} />}
        onClick={() => { resetForm(); setShowForm(true) }}
        style={{
          fontSize: '15px',
          boxShadow: '0 2px 8px rgba(45,106,79,0.3)',
        }}
      >
        Add New Course
      </Button>

      {/* Course Form */}
      {showForm && (
        <div style={styles.card}>
          <h3 style={styles.cardTitle}>{editing ? 'Edit Course' : 'New Course'}</h3>
          <form onSubmit={handleSave} style={styles.form}>

            {/* Course Name */}
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Course Name *</label>
              <input
                style={styles.input}
                value={courseName}
                onChange={e => setCourseName(e.target.value)}
                placeholder="e.g. Pebble Beach, Augusta National"
                required
              />
            </div>

            {/* Holes Configuration */}
            <div style={styles.row}>
              <div style={{ ...styles.fieldGroup, flex: 1 }}>
                <label style={styles.label}>Number of Holes</label>
                <select
                  style={styles.select}
                  value={numHoles}
                  onChange={e => handleNumHolesChange(parseInt(e.target.value))}
                >
                  <option value={9}>9 holes</option>
                  <option value={18}>18 holes</option>
                </select>
              </div>
              <div style={{ ...styles.fieldGroup, flex: 1 }}>
                <label style={styles.label}>Starting Hole</label>
                <select
                  style={styles.select}
                  value={startHole}
                  onChange={e => setStartHole(parseInt(e.target.value))}
                >
                  <option value={1}>Hole 1 (Front 9)</option>
                  {numHoles === 9 && <option value={10}>Hole 10 (Back 9)</option>}
                </select>
              </div>
            </div>

            {/* Hole-by-Hole Par Entry */}
            <div style={styles.fieldGroup}>
              <div style={styles.holeLabelRow}>
                <label style={styles.label}>Par per Hole</label>
                <span style={styles.totalParDisplay}>
                  Total Par: <strong>{totalPar() || '—'}</strong>
                  {Object.keys(parCounts).length > 0 && (
                    <span style={styles.parBreakdown}>
                      {[3, 4, 5].filter(p => parCounts[p]).map(p => `${parCounts[p]}×Par ${p}`).join(' · ')}
                    </span>
                  )}
                </span>
              </div>
              <div style={styles.holeGrid}>
                {pars.map((par, idx) => {
                  const holeNum = startHole + idx
                  return (
                    <div key={idx} style={styles.holeCell}>
                      <div style={styles.holeCellNum}>H{holeNum}</div>
                      <input
                        type="number"
                        min="3"
                        max="5"
                        value={par}
                        onChange={e => updatePar(idx, e.target.value)}
                        placeholder="4"
                        style={{
                          ...styles.holeInput,
                          borderColor: par ? 'var(--green)' : 'var(--gray-200)',
                          color: parseInt(par) === 3 ? '#2d6a4f' : parseInt(par) === 5 ? '#c05621' : 'var(--black)',
                          fontWeight: par ? 700 : 400,
                        }}
                      />
                    </div>
                  )
                })}
              </div>
              <p style={styles.holeHint}>
                Tap each hole to set the par (3, 4, or 5). Default is 4 if left blank.
              </p>
            </div>

            <div style={styles.formActions}>
              <Button
                type="submit"
                variant="primary"
                loading={saving}
                loadingText="Saving…"
                style={{ flex: 1 }}
              >
                {editing ? 'Update Course' : 'Save Course'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={resetForm}
                style={{ flex: 1 }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </div>
      )}

      {/* Course List */}
      <div style={styles.card}>
        <div style={styles.cardTitleRow}>
          <h3 style={styles.cardTitle}>All Courses</h3>
          <span style={styles.count}>{courses.length}</span>
        </div>

        {courses.length === 0 ? (
          <EmptyState
            icon={<Flag size={36} strokeWidth={1.5} />}
            title="No courses yet"
            description="Add your first course above to start tracking pars per hole."
          />
        ) : (
          courses.map(course => {
            const isExpanded = expandedId === course.id
            const hp = course.hole_pars || []
            const par3 = hp.filter(p => p === 3).length
            const par4 = hp.filter(p => p === 4).length
            const par5 = hp.filter(p => p === 5).length

            return (
              <div key={course.id} style={styles.courseRow}>
                <div
                  style={styles.courseHeader}
                  onClick={() => setExpandedId(isExpanded ? null : course.id)}
                >
                  <div style={styles.courseInfo}>
                    <div style={styles.courseName}>{course.name}</div>
                    <div style={styles.courseMeta}>
                      {course.num_holes || hp.length || 9} holes
                      {' · '}Par {course.total_par || hp.reduce((s, p) => s + p, 0)}
                      {par3 > 0 && ` · ${par3}×Par 3`}
                      {par4 > 0 && ` · ${par4}×Par 4`}
                      {par5 > 0 && ` · ${par5}×Par 5`}
                    </div>
                  </div>
                  <div style={styles.courseActions}>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={e => { e.stopPropagation(); startEdit(course) }}
                      style={{
                        background: 'var(--green-xlight)',
                        borderColor: 'var(--green-xlight)',
                        color: 'var(--green)',
                        padding: '4px 10px',
                      }}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      icon={<X size={13} strokeWidth={2.5} />}
                      onClick={e => { e.stopPropagation(); handleDelete(course) }}
                      style={{ padding: '4px 8px' }}
                    />
                    <span style={styles.chevron}>{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {/* Expanded hole par view */}
                {isExpanded && hp.length > 0 && (
                  <div style={styles.holePreview}>
                    <div style={styles.holePreviewGrid}>
                      {hp.map((par, i) => (
                        <div key={i} style={styles.holePreviewCell}>
                          <div style={styles.holePreviewNum}>H{(course.start_hole || 1) + i}</div>
                          <div style={{
                            ...styles.holePreviewPar,
                            background: par === 3 ? '#d8f3dc' : par === 5 ? '#fff3cd' : 'var(--gray-100)',
                            color: par === 3 ? 'var(--green)' : par === 5 ? '#856404' : 'var(--gray-800)',
                          }}>
                            {par}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
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
  card: { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  cardTitleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  cardTitle: { fontSize: '14px', fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  count: { fontSize: '13px', fontWeight: 700, color: 'var(--green)', background: 'var(--green-xlight)', padding: '2px 10px', borderRadius: '20px' },
  form: { display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '12px' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: '6px' },
  row: { display: 'flex', gap: '12px' },
  label: { fontSize: '11px', fontWeight: 600, color: 'var(--gray-600)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  input: { padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--gray-100)', color: 'var(--black)' },
  select: { padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--gray-100)', color: 'var(--black)' },
  holeLabelRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '6px' },
  totalParDisplay: { fontSize: '13px', color: 'var(--green-dark)', fontWeight: 600 },
  parBreakdown: { fontSize: '11px', color: 'var(--gray-400)', fontWeight: 400, marginLeft: '8px' },
  holeGrid: { display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: '6px', marginTop: '4px' },
  holeCell: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' },
  holeCellNum: { fontSize: '10px', color: 'var(--gray-400)', fontWeight: 600 },
  holeInput: { width: '100%', minWidth: '28px', height: '36px', borderRadius: '6px', border: '1.5px solid', textAlign: 'center', fontSize: '15px', background: 'var(--gray-100)', outline: 'none', transition: 'border-color 0.15s', padding: 0 },
  holeHint: { fontSize: '11px', color: 'var(--gray-400)', marginTop: '4px' },
  formActions: { display: 'flex', gap: '10px' },
  courseRow: { borderBottom: '1px solid var(--gray-100)', paddingBottom: '10px', marginBottom: '10px' },
  courseHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' },
  courseInfo: {},
  courseName: { fontSize: '15px', fontWeight: 600, color: 'var(--black)' },
  courseMeta: { fontSize: '12px', color: 'var(--gray-400)', marginTop: '2px' },
  courseActions: { display: 'flex', gap: '6px', alignItems: 'center' },
  chevron: { fontSize: '10px', color: 'var(--gray-400)', marginLeft: '4px' },
  holePreview: { marginTop: '10px', padding: '10px', background: 'var(--gray-100)', borderRadius: 'var(--radius-sm)' },
  holePreviewGrid: { display: 'grid', gridTemplateColumns: 'repeat(9, 1fr)', gap: '6px' },
  holePreviewCell: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '3px' },
  holePreviewNum: { fontSize: '9px', color: 'var(--gray-400)', fontWeight: 600 },
  holePreviewPar: { width: '28px', height: '28px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '14px', fontWeight: 700 },
}

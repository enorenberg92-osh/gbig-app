import React, { useState, useRef } from 'react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'

// ── CSV helpers ───────────────────────────────────────────────────────────────

function parseCSVLine(line) {
  const result = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}

function splitName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/)
  return {
    firstName: parts[0] || '',
    lastName:  parts.slice(1).join(' ') || '',
  }
}

function parseHandicap(val) {
  const n = parseFloat(val)
  return isNaN(n) ? null : n
}

// WPForms column layout (0-indexed):
//  0  Name*          (P1)
//  1  Phone Number*  (P1)
//  2  Email*         (P1)
//  3  9 Hole Handicap* (P1)
//  4  Day*
//  5  Time*
//  6,7,8  blank
//  9  Name*          (P2)
// 10  Phone Number*  (P2)
// 11  Email*         (P2)
// 12  9 Hole Handicap* (P2)
// 13  Message
// 14+ metadata

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2) return { rows: [], error: 'CSV appears empty.' }

  const parsed = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const cols = parseCSVLine(line)

    const p1Name = cols[0] || ''
    if (!p1Name) continue  // skip empty rows

    const { firstName: p1First, lastName: p1Last } = splitName(p1Name)
    const { firstName: p2First, lastName: p2Last } = splitName(cols[9] || '')

    const lastName1 = p1Last || p1First
    const lastName2 = p2Last || p2First
    const teamName  = lastName1 && lastName2
      ? `${lastName1}/${lastName2}`
      : p1Name

    parsed.push({
      p1: {
        firstName: p1First,
        lastName:  p1Last,
        fullName:  p1Name,
        phone:     cols[1] || '',
        email:     cols[2] || '',
        handicap:  parseHandicap(cols[3]),
      },
      p2: {
        firstName: p2First,
        lastName:  p2Last,
        fullName:  cols[9] || '',
        phone:     cols[10] || '',
        email:     cols[11] || '',
        handicap:  parseHandicap(cols[12]),
      },
      day:      cols[4] || '',
      time:     cols[5] || '',
      teamName,
      slot:     [cols[4], cols[5]].filter(Boolean).join(' '),
      submissionId: cols[15] || '',
      submittedAt:  cols[16] || '',
    })
  }

  return { rows: parsed, error: null }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AdminImport() {
  const { locationId } = useLocation()
  const [rows, setRows]         = useState([])
  const [selected, setSelected] = useState(new Set())
  const [importing, setImporting] = useState(false)
  const [results, setResults]   = useState(null)
  const [parseError, setParseError] = useState(null)
  const [toast, setToast]       = useState(null)
  const [fileName, setFileName] = useState(null)
  const fileRef = useRef()

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 4000)
  }

  function handleFile(e) {
    const file = e.target.files[0]
    if (!file) return
    setFileName(file.name)
    const reader = new FileReader()
    reader.onload = (ev) => {
      const { rows: parsed, error } = parseCSV(ev.target.result)
      if (error) { setParseError(error); setRows([]); return }
      setParseError(null)
      setRows(parsed)
      setSelected(new Set(parsed.map((_, i) => i)))
      setResults(null)
    }
    reader.readAsText(file)
  }

  function toggleRow(idx) {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }

  function toggleAll() {
    if (selected.size === rows.length) setSelected(new Set())
    else setSelected(new Set(rows.map((_, i) => i)))
  }

  async function handleImport() {
    setImporting(true)
    const toImport = rows.filter((_, i) => selected.has(i))
    const successes = [], errors = []

    for (const row of toImport) {
      try {
        // ── Insert Player 1 ──
        const p1Payload = {
          first_name:       row.p1.firstName,
          last_name:        row.p1.lastName,
          name:             row.p1.fullName,
          email:            row.p1.email || null,
          handicap:         row.p1.handicap,
          in_skins:         false,
          handicap_locked:  false,
          location_id:      locationId,
        }
        const { data: p1Data, error: p1Err } = await supabase
          .from('players').insert(p1Payload).select('id').single()

        if (p1Err) {
          errors.push({ team: row.teamName, msg: `Player 1 (${row.p1.fullName}): ${p1Err.message}` })
          continue
        }

        // ── Insert Player 2 ──
        let p2Id = null
        if (row.p2.firstName) {
          const p2Payload = {
            first_name:      row.p2.firstName,
            last_name:       row.p2.lastName,
            name:            row.p2.fullName,
            email:           row.p2.email || null,
            handicap:        row.p2.handicap,
            in_skins:        false,
            handicap_locked: false,
            location_id:     locationId,
          }
          const { data: p2Data, error: p2Err } = await supabase
            .from('players').insert(p2Payload).select('id').single()

          if (p2Err) {
            errors.push({ team: row.teamName, msg: `Player 2 (${row.p2.fullName}): ${p2Err.message}` })
          } else {
            p2Id = p2Data.id
          }
        }

        // ── Create Team ──
        const { error: teamErr } = await supabase
          .from('teams')
          .insert({ name: row.teamName, player1_id: p1Data.id, player2_id: p2Id, location_id: locationId })

        if (teamErr) {
          errors.push({ team: row.teamName, msg: `Team: ${teamErr.message}` })
        } else {
          successes.push(row.teamName)
        }
      } catch (e) {
        errors.push({ team: row.teamName, msg: e.message })
      }
    }

    setImporting(false)
    setResults({ successes, errors })
    if (errors.length === 0) {
      showToast(`✓ ${successes.length} team${successes.length !== 1 ? 's' : ''} imported!`)
    } else {
      showToast(`${successes.length} imported, ${errors.length} failed`, 'error')
    }
  }

  function reset() {
    setRows([]); setSelected(new Set()); setResults(null)
    setParseError(null); setFileName(null)
    if (fileRef.current) fileRef.current.value = ''
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={styles.container}>
      {toast && (
        <div style={{ ...styles.toast, background: toast.type === 'error' ? '#c53030' : 'var(--green)' }}>
          {toast.msg}
        </div>
      )}

      <div style={styles.sectionHeader}>
        <h2 style={styles.sectionTitle}>📥 Import Players from CSV</h2>
      </div>

      {/* Instructions */}
      <div style={styles.card}>
        <div style={styles.instructions}>
          <div style={styles.step}><span style={styles.stepNum}>1</span> Go to <strong>WPForms → Entries → League Sign Up Form</strong></div>
          <div style={styles.step}><span style={styles.stepNum}>2</span> Click <strong>Export</strong> and download the CSV</div>
          <div style={styles.step}><span style={styles.stepNum}>3</span> Upload it below — players and teams are created automatically</div>
        </div>
      </div>

      {/* File Upload */}
      <div style={styles.card}>
        <label style={styles.uploadLabel}>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            onChange={handleFile}
            style={{ display: 'none' }}
          />
          <div style={styles.uploadBox}>
            <div style={styles.uploadIcon}>📂</div>
            <div style={styles.uploadText}>
              {fileName ? fileName : 'Click to upload your WPForms CSV'}
            </div>
            <div style={styles.uploadSub}>
              {fileName ? 'Click to choose a different file' : '.csv files only'}
            </div>
          </div>
        </label>

        {parseError && (
          <div style={styles.errorBanner}>{parseError}</div>
        )}
      </div>

      {/* Preview Table */}
      {rows.length > 0 && !results && (
        <div style={styles.card}>
          <div style={styles.previewHeader}>
            <div>
              <div style={styles.cardTitle}>Preview — {rows.length} submission{rows.length !== 1 ? 's' : ''}</div>
              <div style={styles.previewSub}>{selected.size} selected for import</div>
            </div>
            <button style={styles.toggleAllBtn} onClick={toggleAll}>
              {selected.size === rows.length ? 'Deselect All' : 'Select All'}
            </button>
          </div>

          {rows.map((row, idx) => {
            const isSelected = selected.has(idx)
            return (
              <div
                key={idx}
                style={{ ...styles.previewRow, ...(isSelected ? {} : styles.previewRowDimmed) }}
                onClick={() => toggleRow(idx)}
              >
                <div style={styles.previewCheck}>
                  <div style={{ ...styles.checkbox, ...(isSelected ? styles.checkboxChecked : {}) }}>
                    {isSelected && '✓'}
                  </div>
                </div>
                <div style={styles.previewContent}>
                  {/* Team name + slot */}
                  <div style={styles.previewTeamRow}>
                    <span style={styles.previewTeamName}>{row.teamName}</span>
                    {row.slot && <span style={styles.slotBadge}>{row.slot}</span>}
                  </div>
                  {/* Player 1 */}
                  <div style={styles.previewPlayer}>
                    <span style={styles.p1Dot} />
                    <span style={styles.previewPlayerName}>{row.p1.fullName}</span>
                    <span style={styles.previewMeta}>{row.p1.email}</span>
                    {row.p1.handicap != null && (
                      <span style={styles.hcpBadge}>HCP {row.p1.handicap}</span>
                    )}
                  </div>
                  {/* Player 2 */}
                  {row.p2.firstName && (
                    <div style={styles.previewPlayer}>
                      <span style={styles.p2Dot} />
                      <span style={styles.previewPlayerName}>{row.p2.fullName}</span>
                      <span style={styles.previewMeta}>{row.p2.email}</span>
                      {row.p2.handicap != null && (
                        <span style={styles.hcpBadge}>HCP {row.p2.handicap}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          <div style={styles.importActions}>
            <button
              style={{ ...styles.importBtn, opacity: selected.size === 0 ? 0.5 : 1 }}
              onClick={handleImport}
              disabled={importing || selected.size === 0}
            >
              {importing
                ? 'Importing…'
                : `Import ${selected.size} Team${selected.size !== 1 ? 's' : ''}`}
            </button>
            <button style={styles.cancelBtn} onClick={reset}>Clear</button>
          </div>
        </div>
      )}

      {/* Results */}
      {results && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Import Complete</div>

          {results.successes.length > 0 && (
            <div style={styles.successSection}>
              <div style={styles.resultCount}>
                ✓ {results.successes.length} team{results.successes.length !== 1 ? 's' : ''} created
              </div>
              {results.successes.map(name => (
                <div key={name} style={styles.successRow}>🤝 {name}</div>
              ))}
            </div>
          )}

          {results.errors.length > 0 && (
            <div style={styles.errorSection}>
              <div style={styles.errorCount}>
                ✕ {results.errors.length} failed
              </div>
              {results.errors.map((e, i) => (
                <div key={i} style={styles.errorRow}>
                  <strong>{e.team}:</strong> {e.msg}
                </div>
              ))}
            </div>
          )}

          <button style={styles.importBtn} onClick={reset}>Import Another File</button>
        </div>
      )}
    </div>
  )
}

const styles = {
  container:      { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  toast:          { position: 'fixed', top: '16px', left: '50%', transform: 'translateX(-50%)', color: 'white', padding: '10px 20px', borderRadius: '20px', fontSize: '13px', fontWeight: 600, zIndex: 9999, boxShadow: '0 4px 16px rgba(0,0,0,0.2)', whiteSpace: 'nowrap' },
  sectionHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  sectionTitle:   { fontSize: '15px', fontWeight: 700, color: 'var(--green-dark)' },
  card:           { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  cardTitle:      { fontSize: '13px', fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.4px', marginBottom: '8px' },

  // Instructions
  instructions:   { display: 'flex', flexDirection: 'column', gap: '10px' },
  step:           { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', color: 'var(--gray-800)' },
  stepNum:        { width: '24px', height: '24px', borderRadius: '50%', background: 'var(--green)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, flexShrink: 0 },

  // Upload
  uploadLabel:    { cursor: 'pointer', display: 'block' },
  uploadBox:      { border: '2px dashed var(--gray-200)', borderRadius: 'var(--radius)', padding: '28px 16px', textAlign: 'center', transition: 'border-color 0.15s' },
  uploadIcon:     { fontSize: '32px', marginBottom: '8px' },
  uploadText:     { fontSize: '14px', fontWeight: 600, color: 'var(--black)', marginBottom: '4px' },
  uploadSub:      { fontSize: '12px', color: 'var(--gray-400)' },
  errorBanner:    { marginTop: '12px', padding: '10px 14px', background: '#fff5f5', border: '1px solid #fecaca', borderRadius: '8px', color: '#c53030', fontSize: '13px' },

  // Preview
  previewHeader:  { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' },
  previewSub:     { fontSize: '12px', color: 'var(--gray-400)', marginTop: '2px' },
  toggleAllBtn:   { fontSize: '12px', color: 'var(--green)', fontWeight: 600, padding: '4px 10px', background: 'var(--green-xlight)', borderRadius: '6px', flexShrink: 0 },
  previewRow:     { display: 'flex', gap: '12px', padding: '12px 0', borderBottom: '1px solid var(--gray-100)', cursor: 'pointer', transition: 'opacity 0.15s' },
  previewRowDimmed: { opacity: 0.4 },
  previewCheck:   { paddingTop: '2px' },
  checkbox:       { width: '20px', height: '20px', borderRadius: '6px', border: '2px solid var(--gray-200)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: 700, color: 'white', flexShrink: 0 },
  checkboxChecked:{ background: 'var(--green)', borderColor: 'var(--green)' },
  previewContent: { flex: 1, minWidth: 0 },
  previewTeamRow: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flexWrap: 'wrap' },
  previewTeamName:{ fontSize: '14px', fontWeight: 700, color: 'var(--black)' },
  slotBadge:      { fontSize: '11px', color: 'var(--green-dark)', background: 'var(--green-xlight)', padding: '2px 8px', borderRadius: '20px', fontWeight: 600 },
  previewPlayer:  { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '3px', flexWrap: 'wrap' },
  p1Dot:          { width: '7px', height: '7px', borderRadius: '50%', background: 'var(--green)', flexShrink: 0 },
  p2Dot:          { width: '7px', height: '7px', borderRadius: '50%', background: 'var(--gold)', flexShrink: 0 },
  previewPlayerName: { fontSize: '13px', fontWeight: 600, color: 'var(--black)' },
  previewMeta:    { fontSize: '11px', color: 'var(--gray-400)' },
  hcpBadge:       { fontSize: '10px', color: 'var(--green-dark)', background: 'var(--green-xlight)', padding: '1px 6px', borderRadius: '10px', fontWeight: 600 },

  // Actions
  importActions:  { display: 'flex', gap: '10px', marginTop: '16px' },
  importBtn:      { flex: 1, padding: '13px', background: 'var(--green)', color: 'var(--white)', borderRadius: 'var(--radius-sm)', fontSize: '14px', fontWeight: 700 },
  cancelBtn:      { padding: '13px 20px', background: 'var(--gray-100)', color: 'var(--gray-600)', borderRadius: 'var(--radius-sm)', fontSize: '14px' },

  // Results
  successSection: { background: '#f0fdf4', borderRadius: '10px', padding: '12px 14px', marginBottom: '12px', border: '1px solid #bbf7d0' },
  resultCount:    { fontSize: '14px', fontWeight: 700, color: '#166534', marginBottom: '8px' },
  successRow:     { fontSize: '13px', color: '#166534', padding: '3px 0' },
  errorSection:   { background: '#fff5f5', borderRadius: '10px', padding: '12px 14px', marginBottom: '12px', border: '1px solid #fecaca' },
  errorCount:     { fontSize: '14px', fontWeight: 700, color: '#c53030', marginBottom: '8px' },
  errorRow:       { fontSize: '12px', color: '#c53030', padding: '3px 0', lineHeight: 1.4 },
}

import React, { useState, useEffect } from 'react'
import { Trophy, Plus, X, Shuffle, UserPlus } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import { mutationErrorMessage } from '../../lib/rpcErrors'
import { Button, Toast, EmptyState } from '../ui'
import ConfirmDialog from '../ConfirmDialog'

// ─────────────────────────────────────────────────────────────────────────────
//  AdminTournaments — standalone scored events with sign-ups.
//  Lifecycle: signup → scoring → complete. Field building (teams), score
//  entry, and the server-computed leaderboard all live here.
// ─────────────────────────────────────────────────────────────────────────────

const FORMATS = [
  ['stroke',     'Stroke play (net)'],
  ['scramble',   'Scramble'],
  ['best_ball',  'Best ball'],
  ['stableford', 'Stableford'],
]
const EMPTY_FORM = {
  name: '', tournament_date: '', course_id: '', format: 'stroke',
  team_size: '1', capacity: '', notes: '', status: 'signup',
  team_handicap_pct: '35', balls_counted: '1', allowance_pct: '100', quota_basis: 'none',
}

function buildConfig(f) {
  const cfg = { version: 1 }
  if (f.format !== 'stroke') cfg.no_show = 'forfeit'
  if (f.format === 'scramble') cfg.team_handicap_pct = parseFloat(f.team_handicap_pct) || 35
  if (f.format === 'best_ball') {
    cfg.balls_counted = parseInt(f.balls_counted, 10) || 1
    cfg.allowance_pct = parseFloat(f.allowance_pct) || 100
  }
  if (f.format === 'stableford') cfg.quota_basis = f.quota_basis
  return cfg
}

export default function AdminTournaments() {
  const { locationId } = useLocation()
  const [tournaments, setTournaments] = useState([])
  const [players, setPlayers]         = useState([])
  const [courses, setCourses]         = useState([])
  const [selected, setSelected]       = useState(null)
  const [entries, setEntries]         = useState([])
  const [board, setBoard]             = useState([])
  const [loading, setLoading]         = useState(true)
  const [toast, setToast]             = useState(null)
  const [dialog, setDialog]           = useState(null)

  const [showForm, setShowForm] = useState(false)
  const [form, setForm]         = useState(EMPTY_FORM)
  const [editing, setEditing]   = useState(null)

  const [guestName, setGuestName] = useState('')
  const [guestHcp, setGuestHcp]   = useState('')
  const [addPlayerId, setAddPlayerId] = useState('')
  const [scoringEntry, setScoringEntry] = useState(null) // player_id being scored
  const [holeDraft, setHoleDraft]       = useState([])
  const [hcpDraft, setHcpDraft]         = useState('')

  useEffect(() => { if (locationId) load() }, [locationId])
  useEffect(() => { if (selected) loadDetail(selected) }, [selected])

  const t = tournaments.find(x => x.id === selected)
  const course = courses.find(c => c.id === t?.course_id)

  async function load() {
    const [tRes, pRes, cRes] = await Promise.all([
      supabase.from('tournaments').select('*').eq('location_id', locationId).order('created_at', { ascending: false }),
      supabase.from('players').select('id, name, handicap, is_sub').eq('location_id', locationId).order('name'),
      supabase.from('courses').select('id, name, num_holes').eq('location_id', locationId).order('name'),
    ])
    setTournaments(tRes.data || [])
    setPlayers(pRes.data || [])
    setCourses(cRes.data || [])
    if ((tRes.data || []).length && !selected) setSelected(tRes.data[0].id)
    setLoading(false)
  }

  async function loadDetail(tid) {
    const [{ data: eRows }, { data: boardData, error: boardErr }] = await Promise.all([
      supabase.from('tournament_entries').select('*').eq('tournament_id', tid).order('created_at'),
      supabase.rpc('tournament_leaderboard', { p_tournament_id: tid }),
    ])
    setEntries(eRows || [])
    if (boardErr) console.error('leaderboard:', boardErr.message)
    setBoard(Array.isArray(boardData) ? boardData : [])
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const playerName = id => players.find(p => p.id === id)?.name || '?'

  // ── Tournament CRUD ────────────────────────────────────────────────────────
  function startEdit(tt) {
    const cfg = tt.format_config || {}
    setForm({
      name: tt.name || '', tournament_date: tt.tournament_date || '',
      course_id: tt.course_id || '', format: tt.format || 'stroke',
      team_size: String(tt.team_size ?? 1), capacity: tt.capacity == null ? '' : String(tt.capacity),
      notes: tt.notes || '', status: tt.status || 'signup',
      team_handicap_pct: String(cfg.team_handicap_pct ?? 35),
      balls_counted: String(cfg.balls_counted ?? 1),
      allowance_pct: String(cfg.allowance_pct ?? 100),
      quota_basis: cfg.quota_basis || 'none',
    })
    setEditing(tt)
    setShowForm(true)
  }

  async function saveTournament(e) {
    e.preventDefault()
    const payload = {
      name: form.name.trim(),
      tournament_date: form.tournament_date || null,
      course_id: form.course_id || null,
      format: form.format,
      format_config: buildConfig(form),
      team_size: parseInt(form.team_size, 10) || 1,
      capacity: form.capacity === '' ? null : parseInt(form.capacity, 10),
      notes: form.notes.trim() || null,
      status: form.status,
    }
    const { data, error } = await supabase.rpc('admin_upsert_tournament', {
      p_tournament_id: editing?.id || null,
      p_location_id: locationId,
      p_payload: payload,
    })
    if (error) { showToast(mutationErrorMessage(error, 'save the tournament'), 'error'); return }
    showToast(editing ? 'Tournament updated.' : 'Tournament created.')
    setShowForm(false); setEditing(null); setForm(EMPTY_FORM)
    setSelected(data)
    load()
  }

  function deleteTournament(tt) {
    setDialog({
      message: `Delete "${tt.name}" and all its entries?`,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        const { error } = await supabase.rpc('admin_delete_tournament', { p_tournament_id: tt.id })
        if (error) { showToast(mutationErrorMessage(error, 'delete the tournament'), 'error'); return }
        showToast('Tournament deleted.')
        setSelected(null)
        load()
      },
    })
  }

  async function setStatus(status) {
    const cfg = t.format_config || {}
    const { error } = await supabase.rpc('admin_upsert_tournament', {
      p_tournament_id: t.id, p_location_id: locationId,
      p_payload: { ...t, status, format_config: cfg },
    })
    if (error) { showToast(mutationErrorMessage(error, 'change status'), 'error'); return }
    showToast(`Tournament is now ${status}.`)
    load(); loadDetail(t.id)
  }

  // ── Entries ────────────────────────────────────────────────────────────────
  async function addEntry(playerId) {
    const { error } = await supabase.rpc('admin_set_tournament_entry', {
      p_tournament_id: selected, p_player_id: playerId, p_add: true,
    })
    if (error) { showToast(mutationErrorMessage(error, 'add the player'), 'error'); return }
    setAddPlayerId('')
    loadDetail(selected)
  }

  async function removeEntry(playerId) {
    const { error } = await supabase.rpc('admin_set_tournament_entry', {
      p_tournament_id: selected, p_player_id: playerId, p_add: false,
    })
    if (error) { showToast(mutationErrorMessage(error, 'remove the player'), 'error'); return }
    loadDetail(selected)
  }

  // Guest = a player profile flagged is_sub (same pattern as league subs).
  async function addGuest() {
    const name = guestName.trim()
    if (!name) return
    const [first, ...rest] = name.split(' ')
    const { data: newId, error } = await supabase.rpc('admin_create_player', {
      p_location_id: locationId,
      p_payload: {
        first_name: first, last_name: rest.join(' ') || '—', name,
        email: null, handicap: parseInt(guestHcp, 10) || 0, is_sub: true,
      },
    })
    if (error) { showToast(mutationErrorMessage(error, 'create the guest'), 'error'); return }
    await addEntry(newId)
    setGuestName(''); setGuestHcp('')
    load() // refresh player list to include the guest
  }

  // ── Teams ──────────────────────────────────────────────────────────────────
  async function saveTeams(assignments) {
    const { error } = await supabase.rpc('admin_set_tournament_teams', {
      p_tournament_id: selected, p_assignments: assignments,
    })
    if (error) { showToast(mutationErrorMessage(error, 'assign teams'), 'error'); return }
    loadDetail(selected)
  }

  function shuffleTeams() {
    const size = t.team_size || 1
    const shuffled = [...entries].sort(() => Math.random() - 0.5)
    saveTeams(shuffled.map((e, i) => ({ player_id: e.player_id, team_no: Math.floor(i / size) + 1 })))
  }

  // ── Scores ─────────────────────────────────────────────────────────────────
  function startScoring(entry) {
    const n = course?.num_holes || 9
    setHoleDraft(entry.hole_scores?.length ? entry.hole_scores.map(String) : Array(n).fill(''))
    setHcpDraft(entry.handicap_used != null ? String(entry.handicap_used)
      : String(Math.round(players.find(p => p.id === entry.player_id)?.handicap ?? 0)))
    setScoringEntry(entry.player_id)
  }

  async function saveScore() {
    const holes = holeDraft.map(v => parseInt(v, 10))
    if (holes.some(v => !Number.isInteger(v) || v < 1 || v > 20)) {
      showToast(`Enter all ${holeDraft.length} hole scores (1–20).`, 'error'); return
    }
    const { error } = await supabase.rpc('admin_enter_tournament_score', {
      p_tournament_id: selected, p_player_id: scoringEntry,
      p_hole_scores: holes, p_handicap: parseInt(hcpDraft, 10) || 0,
    })
    if (error) { showToast(mutationErrorMessage(error, 'save the score'), 'error'); return }
    setScoringEntry(null)
    loadDetail(selected)
  }

  const isTeamFormat = t && ['scramble', 'best_ball'].includes(t.format)

  if (loading) return <div style={st.loading}>Loading…</div>

  return (
    <div style={st.container}>
      {dialog && (
        <ConfirmDialog {...dialog}
          onConfirm={() => { dialog.onConfirm(); setDialog(null) }}
          onCancel={() => setDialog(null)} />
      )}
      <Toast toast={toast} />

      <Button variant="primary" fullWidth icon={<Plus size={16} strokeWidth={2.5} />}
        onClick={() => { setForm(EMPTY_FORM); setEditing(null); setShowForm(true) }}>
        New Tournament
      </Button>

      {/* Form */}
      {showForm && (
        <form onSubmit={saveTournament} style={st.card}>
          <h3 style={st.cardTitle}>{editing ? 'Edit Tournament' : 'New Tournament'}</h3>
          <div style={st.fieldGroup}>
            <label style={st.label}>Name *</label>
            <input style={st.input} value={form.name} required placeholder="e.g. Summer Scramble Open"
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          </div>
          <div style={st.row}>
            <div style={{ ...st.fieldGroup, flex: 1 }}>
              <label style={st.label}>Date</label>
              <input type="date" style={st.input} value={form.tournament_date}
                onChange={e => setForm(f => ({ ...f, tournament_date: e.target.value }))} />
            </div>
            <div style={{ ...st.fieldGroup, flex: 1 }}>
              <label style={st.label}>Course</label>
              <select style={st.input} value={form.course_id}
                onChange={e => setForm(f => ({ ...f, course_id: e.target.value }))}>
                <option value="">— select —</option>
                {courses.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          </div>
          <div style={st.row}>
            <div style={{ ...st.fieldGroup, flex: 2 }}>
              <label style={st.label}>Format</label>
              <select style={st.input} value={form.format}
                onChange={e => setForm(f => ({ ...f, format: e.target.value, team_size: ['scramble', 'best_ball'].includes(e.target.value) && f.team_size === '1' ? '2' : f.team_size }))}>
                {FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div style={{ ...st.fieldGroup, flex: 1 }}>
              <label style={st.label}>Team size</label>
              <select style={st.input} value={form.team_size}
                onChange={e => setForm(f => ({ ...f, team_size: e.target.value }))}>
                {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div style={{ ...st.fieldGroup, flex: 1 }}>
              <label style={st.label}>Capacity</label>
              <input type="number" min="1" style={st.input} value={form.capacity} placeholder="∞"
                onChange={e => setForm(f => ({ ...f, capacity: e.target.value }))} />
            </div>
          </div>
          {form.format === 'scramble' && (
            <div style={{ ...st.fieldGroup, maxWidth: 140 }}>
              <label style={st.label}>Team hcp %</label>
              <input type="number" min="0" max="100" style={st.input} value={form.team_handicap_pct}
                onChange={e => setForm(f => ({ ...f, team_handicap_pct: e.target.value }))} />
            </div>
          )}
          {form.format === 'best_ball' && (
            <div style={st.row}>
              <div style={{ ...st.fieldGroup, flex: 1 }}>
                <label style={st.label}>Balls counted</label>
                <select style={st.input} value={form.balls_counted}
                  onChange={e => setForm(f => ({ ...f, balls_counted: e.target.value }))}>
                  <option value="1">Best 1</option>
                  <option value="2">Aggregate</option>
                </select>
              </div>
              <div style={{ ...st.fieldGroup, flex: 1 }}>
                <label style={st.label}>Hcp %</label>
                <input type="number" min="0" max="100" style={st.input} value={form.allowance_pct}
                  onChange={e => setForm(f => ({ ...f, allowance_pct: e.target.value }))} />
              </div>
            </div>
          )}
          {form.format === 'stableford' && (
            <div style={{ ...st.fieldGroup, maxWidth: 220 }}>
              <label style={st.label}>Quota basis</label>
              <select style={st.input} value={form.quota_basis}
                onChange={e => setForm(f => ({ ...f, quota_basis: e.target.value }))}>
                <option value="none">Raw points</option>
                <option value="handicap">Vs handicap quota</option>
              </select>
            </div>
          )}
          <div style={st.fieldGroup}>
            <label style={st.label}>Notes</label>
            <input style={st.input} value={form.notes} placeholder="Entry fee, prizes, tee time…"
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Button type="submit" variant="primary" style={{ flex: 1 }}>{editing ? 'Update' : 'Create'}</Button>
            <Button type="button" variant="secondary" style={{ flex: 1 }} onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {tournaments.length === 0 && !showForm ? (
        <EmptyState icon={<Trophy size={38} strokeWidth={1.5} />} title="No tournaments yet"
          description="Create a standalone scored event — members sign up, you build the field, enter scores, done." />
      ) : tournaments.length > 0 && (
        <>
          {/* Selector + status */}
          <div style={st.card}>
            <select style={st.input} value={selected || ''} onChange={e => setSelected(e.target.value)}>
              {tournaments.map(x => <option key={x.id} value={x.id}>{x.name} ({x.status})</option>)}
            </select>
            {t && (
              <>
                <div style={{ fontSize: 12, color: 'var(--gray-400)' }}>
                  {FORMATS.find(([v]) => v === t.format)?.[1]} · team of {t.team_size}
                  {t.capacity ? ` · cap ${t.capacity}` : ''} · {course?.name || 'no course'}
                  {t.tournament_date ? ` · ${t.tournament_date}` : ''}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {t.status === 'signup' && (
                    <Button variant="primary" size="sm" onClick={() => setStatus('scoring')}>Close sign-ups → scoring</Button>
                  )}
                  {t.status === 'scoring' && (
                    <Button variant="primary" size="sm" onClick={() => setStatus('complete')}>Mark complete</Button>
                  )}
                  {t.status !== 'signup' && t.status !== 'cancelled' && (
                    <Button variant="secondary" size="sm" onClick={() => setStatus('signup')}>Reopen sign-ups</Button>
                  )}
                  <Button variant="secondary" size="sm" onClick={() => startEdit(t)}>Edit</Button>
                  <Button variant="danger" size="sm" icon={<X size={13} strokeWidth={2.5} />} onClick={() => deleteTournament(t)} />
                </div>
              </>
            )}
          </div>

          {t && (
            <>
              {/* Leaderboard */}
              {board.length > 0 && (
                <div style={st.card}>
                  <h3 style={st.cardTitle}>Leaderboard</h3>
                  {board.map((r, i) => (
                    <div key={i} style={st.boardRow}>
                      <span style={st.boardRank}>{i + 1}</span>
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>
                        {r.team_no != null && isTeamFormat ? `T${r.team_no} — ` : ''}{r.name}
                      </span>
                      {r.gross != null && <span style={{ fontSize: 11, color: 'var(--gray-400)' }}>gross {r.gross}</span>}
                      <span style={st.boardScore}>{Number(r.result)}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Field / entries */}
              <div style={st.card}>
                <div style={st.cardTitleRow}>
                  <h3 style={st.cardTitle}>Field ({entries.length}{t.capacity ? `/${t.capacity}` : ''})</h3>
                  {isTeamFormat && entries.length > 1 && (
                    <Button variant="secondary" size="sm" icon={<Shuffle size={13} strokeWidth={2.25} />} onClick={shuffleTeams}>
                      Shuffle into teams of {t.team_size}
                    </Button>
                  )}
                </div>

                {entries.map(e => (
                  <div key={e.id} style={st.entryRow}>
                    <span style={{ flex: 1, fontSize: 13 }}>
                      {playerName(e.player_id)}
                      {players.find(p => p.id === e.player_id)?.is_sub && <span style={st.guestPill}>guest</span>}
                      {e.hole_scores && <span style={st.scoredPill}>scored</span>}
                    </span>
                    {isTeamFormat && (
                      <select style={{ ...st.input, width: 90, padding: '5px 8px' }} value={e.team_no ?? ''}
                        onChange={ev => saveTeams([{ player_id: e.player_id, team_no: ev.target.value || null }])}>
                        <option value="">no team</option>
                        {Array.from({ length: Math.ceil(entries.length / (t.team_size || 1)) }, (_, i) => i + 1).map(n =>
                          <option key={n} value={n}>Team {n}</option>)}
                      </select>
                    )}
                    {t.status !== 'signup' && (
                      <Button variant="secondary" size="sm" onClick={() => startScoring(e)}>
                        {e.hole_scores ? 'Edit score' : 'Score'}
                      </Button>
                    )}
                    <button type="button" style={st.removeBtn} onClick={() => removeEntry(e.player_id)}>✕</button>
                  </div>
                ))}

                {/* Score editor */}
                {scoringEntry && (
                  <div style={st.scoreBox}>
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{playerName(scoringEntry)}</div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {holeDraft.map((v, i) => (
                        <input key={i} type="number" min="1" max="20" value={v} placeholder={String(i + 1)}
                          style={st.holeInput}
                          onChange={ev => setHoleDraft(d => d.map((x, j) => j === i ? ev.target.value : x))} />
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <label style={st.label}>Hcp</label>
                      <input type="number" style={{ ...st.input, width: 70 }} value={hcpDraft}
                        onChange={ev => setHcpDraft(ev.target.value)} />
                      <Button variant="primary" size="sm" onClick={saveScore}>Save</Button>
                      <Button variant="secondary" size="sm" onClick={() => setScoringEntry(null)}>Cancel</Button>
                    </div>
                  </div>
                )}

                {/* Add member / guest */}
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <select style={{ ...st.input, flex: 1 }} value={addPlayerId} onChange={e => setAddPlayerId(e.target.value)}>
                    <option value="">— add member —</option>
                    {players.filter(p => !entries.some(e => e.player_id === p.id)).map(p =>
                      <option key={p.id} value={p.id}>{p.name}{p.is_sub ? ' (guest)' : ''}</option>)}
                  </select>
                  <Button variant="secondary" size="sm" disabled={!addPlayerId} onClick={() => addEntry(addPlayerId)}>Add</Button>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input style={{ ...st.input, flex: 1 }} placeholder="Walk-in guest name" value={guestName}
                    onChange={e => setGuestName(e.target.value)} />
                  <input type="number" style={{ ...st.input, width: 80 }} placeholder="hcp" value={guestHcp}
                    onChange={e => setGuestHcp(e.target.value)} />
                  <Button variant="secondary" size="sm" icon={<UserPlus size={13} strokeWidth={2.25} />}
                    disabled={!guestName.trim()} onClick={addGuest}>Guest</Button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

const st = {
  container: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  loading: { padding: '40px', textAlign: 'center', color: 'var(--gray-400)' },
  card: { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)', display: 'flex', flexDirection: 'column', gap: 10 },
  cardTitleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
  cardTitle: { fontSize: '14px', fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 5 },
  row: { display: 'flex', gap: 10 },
  label: { fontSize: '11px', fontWeight: 600, color: 'var(--gray-600)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  input: { padding: '9px 11px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '13px', background: 'var(--gray-100)', color: 'var(--black)', width: '100%' },
  entryRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--gray-100)' },
  guestPill: { fontSize: 9, fontWeight: 700, background: '#fff3cd', color: '#7a5c00', padding: '1px 6px', borderRadius: 8, marginLeft: 6, textTransform: 'uppercase' },
  scoredPill: { fontSize: 9, fontWeight: 700, background: 'var(--green-xlight)', color: 'var(--green-dark)', padding: '1px 6px', borderRadius: 8, marginLeft: 6, textTransform: 'uppercase' },
  removeBtn: { background: 'transparent', border: 'none', color: '#c53030', cursor: 'pointer', fontSize: 13, padding: '0 4px' },
  scoreBox: { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, background: 'var(--gray-100)', borderRadius: 8 },
  holeInput: { width: 40, height: 34, borderRadius: 6, border: '1.5px solid var(--gray-200)', textAlign: 'center', fontSize: 13, background: 'var(--white)' },
  boardRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--gray-100)' },
  boardRank: { width: 22, fontSize: 13, fontWeight: 800, color: 'var(--gray-400)', textAlign: 'center' },
  boardScore: { fontSize: 15, fontWeight: 800, color: 'var(--green-dark)', width: 44, textAlign: 'right' },
}

import React, { useState, useEffect } from 'react'
import { Trophy, Plus, X } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import { loadWorkingLeague } from '../../lib/leagueUtils'
import { mutationErrorMessage } from '../../lib/rpcErrors'
import { Button, Toast, EmptyState } from '../ui'
import ConfirmDialog from '../ConfirmDialog'

// ─────────────────────────────────────────────────────────────────────────────
//  AdminCup — Ryder Cup module (Phase 3.6).
//  One cup at a time in practice: qualification list from league results,
//  sessions of fourball/foursomes/singles matches, 1/½/0 running score.
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_CUP = {
  name: '', team_a_name: 'Team Red', team_b_name: 'Team Blue',
  start_date: '', end_date: '', status: 'setup',
  win: '2', tie: '1', loss: '0', weeks: '12',
}
const SESSIONS = ['fourball', 'foursomes', 'singles']

export default function AdminCup() {
  const { locationId } = useLocation()
  const [league, setLeague]     = useState(null)
  const [cups, setCups]         = useState([])
  const [players, setPlayers]   = useState([])
  const [selected, setSelected] = useState(null)   // cup id
  const [matches, setMatches]   = useState([])
  const [qual, setQual]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [toast, setToast]       = useState(null)
  const [dialog, setDialog]     = useState(null)

  const [showCupForm, setShowCupForm] = useState(false)
  const [cupForm, setCupForm]         = useState(EMPTY_CUP)
  const [editingCup, setEditingCup]   = useState(null)

  const [matchForm, setMatchForm] = useState(null) // { id, session, a:[], b:[] }

  useEffect(() => { if (locationId) load() }, [locationId])
  useEffect(() => { if (selected) loadCupDetail(selected) }, [selected])

  const cup = cups.find(c => c.id === selected)

  async function load() {
    let lg
    try { lg = await loadWorkingLeague(supabase, locationId) }
    catch (e) { showToast(e.message, 'error'); setLoading(false); return }
    setLeague(lg)
    const [{ data: cupRows }, { data: playerRows }] = await Promise.all([
      supabase.from('cups').select('*').eq('location_id', locationId).eq('league_id', lg.id).order('created_at', { ascending: false }),
      supabase.from('players').select('id, name').eq('location_id', locationId).neq('is_sub', true).order('name'),
    ])
    setCups(cupRows || [])
    setPlayers(playerRows || [])
    if ((cupRows || []).length && !selected) setSelected(cupRows[0].id)
    setLoading(false)
  }

  async function loadCupDetail(cupId) {
    const [{ data: matchRows }, { data: qualRows, error: qualErr }] = await Promise.all([
      supabase.from('cup_matches').select('*').eq('cup_id', cupId).eq('location_id', locationId).order('session').order('match_order'),
      supabase.rpc('cup_qualification', { p_cup_id: cupId }),
    ])
    setMatches(matchRows || [])
    if (qualErr) console.error('cup_qualification:', qualErr.message)
    setQual(qualRows || [])
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  // ── Cup CRUD ───────────────────────────────────────────────────────────────
  function startEditCup(c) {
    const r = c.point_rules || {}
    setCupForm({
      name: c.name || '', team_a_name: c.team_a_name || 'Team Red', team_b_name: c.team_b_name || 'Team Blue',
      start_date: c.start_date || '', end_date: c.end_date || '', status: c.status || 'setup',
      win: String(r.win ?? 2), tie: String(r.tie ?? 1), loss: String(r.loss ?? 0), weeks: String(r.weeks ?? 12),
    })
    setEditingCup(c)
    setShowCupForm(true)
  }

  async function saveCup(e) {
    e.preventDefault()
    const payload = {
      name: cupForm.name.trim(),
      team_a_name: cupForm.team_a_name.trim(),
      team_b_name: cupForm.team_b_name.trim(),
      start_date: cupForm.start_date || null,
      end_date: cupForm.end_date || null,
      status: cupForm.status,
      point_rules: {
        version: 1,
        win: parseFloat(cupForm.win) || 0,
        tie: parseFloat(cupForm.tie) || 0,
        loss: parseFloat(cupForm.loss) || 0,
        weeks: parseInt(cupForm.weeks, 10) || 12,
      },
    }
    const { data, error } = await supabase.rpc('admin_upsert_cup', {
      p_cup_id: editingCup?.id || null,
      p_league_id: league.id,
      p_payload: payload,
    })
    if (error) { showToast(mutationErrorMessage(error, 'save the cup'), 'error'); return }
    showToast(editingCup ? 'Cup updated.' : 'Cup created.')
    setShowCupForm(false); setEditingCup(null); setCupForm(EMPTY_CUP)
    setSelected(data)
    load()
  }

  function deleteCup(c) {
    setDialog({
      message: `Delete "${c.name}" and all its matches?`,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        const { error } = await supabase.rpc('admin_delete_cup', { p_cup_id: c.id })
        if (error) { showToast(mutationErrorMessage(error, 'delete the cup'), 'error'); return }
        showToast('Cup deleted.')
        setSelected(null)
        load()
      },
    })
  }

  // ── Match CRUD ─────────────────────────────────────────────────────────────
  async function saveMatch() {
    const size = matchForm.session === 'singles' ? 1 : 2
    const a = matchForm.a.filter(Boolean)
    const b = matchForm.b.filter(Boolean)
    if (a.length !== size || b.length !== size) {
      showToast(`${matchForm.session} needs ${size} player${size > 1 ? 's' : ''} per side.`, 'error'); return
    }
    const { error } = await supabase.rpc('admin_upsert_cup_match', {
      p_match_id: matchForm.id || null,
      p_cup_id: selected,
      p_payload: {
        session: matchForm.session,
        match_order: matches.length,
        team_a_players: a,
        team_b_players: b,
      },
    })
    if (error) { showToast(mutationErrorMessage(error, 'save the match'), 'error'); return }
    showToast('Match saved.')
    setMatchForm(null)
    loadCupDetail(selected)
  }

  async function setResult(match, result) {
    const { error } = await supabase.rpc('admin_set_cup_match_result', {
      p_match_id: match.id, p_result: result,
    })
    if (error) { showToast(mutationErrorMessage(error, 'set the result'), 'error'); return }
    loadCupDetail(selected)
  }

  async function deleteMatch(match) {
    const { error } = await supabase.rpc('admin_delete_cup_match', { p_match_id: match.id })
    if (error) { showToast(mutationErrorMessage(error, 'delete the match'), 'error'); return }
    loadCupDetail(selected)
  }

  const playerName = id => players.find(p => p.id === id)?.name || '?'
  const scoreA = matches.reduce((s, m) => s + (m.result === 'team_a' ? 1 : m.result === 'halved' ? 0.5 : 0), 0)
  const scoreB = matches.reduce((s, m) => s + (m.result === 'team_b' ? 1 : m.result === 'halved' ? 0.5 : 0), 0)

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
        onClick={() => { setCupForm(EMPTY_CUP); setEditingCup(null); setShowCupForm(true) }}>
        New Cup
      </Button>

      {/* Cup form */}
      {showCupForm && (
        <form onSubmit={saveCup} style={st.card}>
          <h3 style={st.cardTitle}>{editingCup ? 'Edit Cup' : 'New Cup'}</h3>
          <div style={st.fieldGroup}>
            <label style={st.label}>Cup Name *</label>
            <input style={st.input} value={cupForm.name} required
              onChange={e => setCupForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. GBIG Cup 2026" />
          </div>
          <div style={st.row}>
            {[['team_a_name', 'Team A'], ['team_b_name', 'Team B']].map(([k, label]) => (
              <div key={k} style={{ ...st.fieldGroup, flex: 1 }}>
                <label style={st.label}>{label}</label>
                <input style={st.input} value={cupForm[k]}
                  onChange={e => setCupForm(f => ({ ...f, [k]: e.target.value }))} />
              </div>
            ))}
          </div>
          <div style={st.row}>
            {[['start_date', 'Start'], ['end_date', 'End']].map(([k, label]) => (
              <div key={k} style={{ ...st.fieldGroup, flex: 1 }}>
                <label style={st.label}>{label}</label>
                <input type="date" style={st.input} value={cupForm[k]}
                  onChange={e => setCupForm(f => ({ ...f, [k]: e.target.value }))} />
              </div>
            ))}
            <div style={{ ...st.fieldGroup, flex: 1 }}>
              <label style={st.label}>Status</label>
              <select style={st.input} value={cupForm.status}
                onChange={e => setCupForm(f => ({ ...f, status: e.target.value }))}>
                <option value="setup">setup</option>
                <option value="active">active</option>
                <option value="complete">complete</option>
              </select>
            </div>
          </div>
          <div style={st.row}>
            {[['win', 'Win pts'], ['tie', 'Tie pts'], ['loss', 'Loss pts'], ['weeks', 'Qual. weeks']].map(([k, label]) => (
              <div key={k} style={{ ...st.fieldGroup, flex: 1 }}>
                <label style={st.label}>{label}</label>
                <input type="number" min="0" style={st.input} value={cupForm[k]}
                  onChange={e => setCupForm(f => ({ ...f, [k]: e.target.value }))} />
              </div>
            ))}
          </div>
          <p style={st.hint}>Qualification points: league match results over the last N weeks earn win/tie/loss points per player.</p>
          <div style={{ display: 'flex', gap: 10 }}>
            <Button type="submit" variant="primary" style={{ flex: 1 }}>{editingCup ? 'Update Cup' : 'Create Cup'}</Button>
            <Button type="button" variant="secondary" style={{ flex: 1 }} onClick={() => setShowCupForm(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {cups.length === 0 && !showCupForm ? (
        <EmptyState icon={<Trophy size={38} strokeWidth={1.5} />} title="No cups yet"
          description="Create a Ryder Cup–style competition. Qualification comes from league match results." />
      ) : cups.length > 0 && (
        <>
          {/* Cup selector */}
          <div style={st.card}>
            <label style={st.label}>Cup</label>
            <select style={st.input} value={selected || ''} onChange={e => setSelected(e.target.value)}>
              {cups.map(c => <option key={c.id} value={c.id}>{c.name} ({c.status})</option>)}
            </select>
            {cup && (
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <Button variant="secondary" size="sm" onClick={() => startEditCup(cup)}>Edit</Button>
                <Button variant="danger" size="sm" icon={<X size={13} strokeWidth={2.5} />} onClick={() => deleteCup(cup)} />
              </div>
            )}
          </div>

          {cup && (
            <>
              {/* Running score */}
              <div style={st.scoreBoard}>
                <div style={st.scoreSide}>
                  <div style={st.scoreTeam}>{cup.team_a_name}</div>
                  <div style={st.scoreNum}>{scoreA}</div>
                </div>
                <div style={st.scoreVs}>—</div>
                <div style={st.scoreSide}>
                  <div style={st.scoreTeam}>{cup.team_b_name}</div>
                  <div style={st.scoreNum}>{scoreB}</div>
                </div>
              </div>

              {/* Matches */}
              <div style={st.card}>
                <div style={st.cardTitleRow}>
                  <h3 style={st.cardTitle}>Matches</h3>
                  <Button variant="secondary" size="sm"
                    onClick={() => setMatchForm({ id: null, session: 'fourball', a: ['', ''], b: ['', ''] })}>
                    + Add Match
                  </Button>
                </div>

                {matchForm && (
                  <div style={st.matchForm}>
                    <select style={st.input} value={matchForm.session}
                      onChange={e => {
                        const session = e.target.value
                        const size = session === 'singles' ? 1 : 2
                        setMatchForm(f => ({ ...f, session, a: Array(size).fill(''), b: Array(size).fill('') }))
                      }}>
                      {SESSIONS.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    {['a', 'b'].map(side => (
                      <div key={side} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ ...st.label, width: 60 }}>{side === 'a' ? cup.team_a_name : cup.team_b_name}</span>
                        {matchForm[side].map((v, i) => (
                          <select key={i} style={{ ...st.input, flex: 1 }} value={v}
                            onChange={e => setMatchForm(f => ({
                              ...f, [side]: f[side].map((x, j) => j === i ? e.target.value : x),
                            }))}>
                            <option value="">— player —</option>
                            {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                          </select>
                        ))}
                      </div>
                    ))}
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Button variant="primary" size="sm" onClick={saveMatch}>Save Match</Button>
                      <Button variant="secondary" size="sm" onClick={() => setMatchForm(null)}>Cancel</Button>
                    </div>
                  </div>
                )}

                {matches.length === 0 && !matchForm && (
                  <p style={st.hint}>No matches yet. Add fourball, foursomes, and singles sessions.</p>
                )}
                {SESSIONS.filter(s => matches.some(m => m.session === s)).map(session => (
                  <div key={session}>
                    <div style={st.sessionTitle}>{session}</div>
                    {matches.filter(m => m.session === session).map(m => (
                      <div key={m.id} style={st.matchRow}>
                        <div style={{ flex: 1, fontSize: 13 }}>
                          <span style={{ fontWeight: m.result === 'team_a' ? 800 : 400 }}>
                            {m.team_a_players.map(playerName).join(' / ')}
                          </span>
                          <span style={{ color: 'var(--gray-400)' }}> vs </span>
                          <span style={{ fontWeight: m.result === 'team_b' ? 800 : 400 }}>
                            {m.team_b_players.map(playerName).join(' / ')}
                          </span>
                          {m.result === 'halved' && <span style={st.halvedPill}>½</span>}
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                          {[['team_a', 'A'], ['halved', '½'], ['team_b', 'B'], ['pending', '·']].map(([r, label]) => (
                            <button key={r} type="button"
                              onClick={() => setResult(m, r)}
                              style={{ ...st.resultBtn, ...(m.result === r ? st.resultActive : {}) }}>
                              {label}
                            </button>
                          ))}
                          <button type="button" style={st.matchDelete} onClick={() => deleteMatch(m)}>✕</button>
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {/* Qualification */}
              <div style={st.card}>
                <h3 style={st.cardTitle}>Qualification Standings</h3>
                <p style={st.hint}>
                  Points from league match results over the last {cup.point_rules?.weeks ?? 12} weeks
                  (win {cup.point_rules?.win ?? 2} / tie {cup.point_rules?.tie ?? 1} / loss {cup.point_rules?.loss ?? 0}).
                </p>
                {qual.length === 0 ? (
                  <p style={st.hint}>No scored league matchups in the window yet.</p>
                ) : (
                  qual.map((q, i) => (
                    <div key={q.player_id} style={st.qualRow}>
                      <span style={st.qualRank}>{i + 1}</span>
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{q.player_name}</span>
                      <span style={{ fontSize: 11, color: 'var(--gray-400)' }}>{q.wins}–{q.ties}–{q.losses}</span>
                      <span style={st.qualPts}>{Number(q.points)}</span>
                    </div>
                  ))
                )}
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
  cardTitleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: '14px', fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 5 },
  row: { display: 'flex', gap: 10 },
  label: { fontSize: '11px', fontWeight: 600, color: 'var(--gray-600)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  input: { padding: '9px 11px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '13px', background: 'var(--gray-100)', color: 'var(--black)', width: '100%' },
  hint: { fontSize: 11, color: 'var(--gray-400)', lineHeight: 1.5 },
  scoreBoard: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 18, background: 'var(--green-dark)', borderRadius: 'var(--radius)', padding: '16px' },
  scoreSide: { textAlign: 'center' },
  scoreTeam: { fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.8)', textTransform: 'uppercase', letterSpacing: '0.5px' },
  scoreNum: { fontSize: 34, fontWeight: 800, color: '#fff' },
  scoreVs: { fontSize: 20, color: 'rgba(255,255,255,0.5)' },
  matchForm: { display: 'flex', flexDirection: 'column', gap: 8, padding: 10, background: 'var(--gray-100)', borderRadius: 8 },
  sessionTitle: { fontSize: 11, fontWeight: 800, color: 'var(--gray-500)', textTransform: 'uppercase', letterSpacing: '0.5px', margin: '8px 0 4px' },
  matchRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--gray-100)' },
  resultBtn: { width: 26, height: 26, borderRadius: 6, border: '1px solid var(--gray-200)', background: 'var(--white)', color: 'var(--gray-600)', fontSize: 12, fontWeight: 700, cursor: 'pointer' },
  resultActive: { background: 'var(--green)', color: '#fff', borderColor: 'var(--green)' },
  matchDelete: { width: 26, height: 26, borderRadius: 6, border: 'none', background: 'transparent', color: '#c53030', fontSize: 12, cursor: 'pointer' },
  halvedPill: { marginLeft: 6, fontSize: 10, fontWeight: 800, background: 'var(--gold-light, #fff3cd)', color: '#7a5c00', padding: '1px 6px', borderRadius: 10 },
  qualRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--gray-100)' },
  qualRank: { width: 22, fontSize: 12, fontWeight: 700, color: 'var(--gray-400)', textAlign: 'center' },
  qualPts: { fontSize: 14, fontWeight: 800, color: 'var(--green-dark)', width: 40, textAlign: 'right' },
}

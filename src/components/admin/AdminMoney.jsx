import React, { useState, useEffect } from 'react'
import { DollarSign, Trash2 } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import { loadWorkingLeague } from '../../lib/leagueUtils'
import { mutationErrorMessage } from '../../lib/rpcErrors'
import { calcSkins } from '../../lib/skinsUtils'
import { Button, Toast, EmptyState } from '../ui'

// ─────────────────────────────────────────────────────────────────────────────
//  AdminMoney — money list (ledger only, Phase 5.2). No payment processing:
//  the ledger tracks who's owed what; cash moves outside the app.
//  Sign convention: positive = credit to player/team, negative = paid out/fee.
// ─────────────────────────────────────────────────────────────────────────────

const TYPES = ['skins', 'match_points', 'event_prize', 'entry_fee', 'payout', 'adjustment']
const EMPTY_ENTRY = { player_id: '', team_id: '', type: 'skins', amount: '', note: '' }

export default function AdminMoney() {
  const { locationId } = useLocation()
  const [league, setLeague]   = useState(null)
  const [entries, setEntries] = useState([])
  const [players, setPlayers] = useState([])
  const [teams, setTeams]     = useState([])
  const [events, setEvents]   = useState([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast]     = useState(null)

  const [form, setForm] = useState(EMPTY_ENTRY)

  // Weekly suggestion state
  const [suggestEvent, setSuggestEvent]   = useState('')
  const [skinValue, setSkinValue]         = useState('5')
  const [pointValue, setPointValue]       = useState('2')
  const [suggestions, setSuggestions]     = useState(null) // [{...entry, include}]

  useEffect(() => { if (locationId) load() }, [locationId])

  async function load() {
    let lg
    try { lg = await loadWorkingLeague(supabase, locationId) }
    catch (e) { showToast(e.message, 'error'); setLoading(false); return }
    setLeague(lg)
    const [led, pl, tm, ev] = await Promise.all([
      supabase.from('ledger').select('*').eq('location_id', locationId).eq('league_id', lg.id).order('created_at', { ascending: false }),
      supabase.from('players').select('id, name, in_skins').eq('location_id', locationId).order('name'),
      supabase.from('teams').select('id, name').eq('location_id', locationId).eq('league_id', lg.id).order('created_at'),
      supabase.from('events').select('id, name, week_number, status, course_id').eq('location_id', locationId).eq('league_id', lg.id).neq('is_bye', true).order('week_number'),
    ])
    setEntries(led.data || [])
    setPlayers(pl.data || [])
    setTeams(tm.data || [])
    setEvents((ev.data || []).filter(e => e.status === 'closed'))
    setLoading(false)
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const playerName = id => players.find(p => p.id === id)?.name
  const teamName = id => teams.find(t => t.id === id)?.name
  const whoName = e => playerName(e.player_id) || teamName(e.team_id) || '?'

  async function addEntries(list) {
    const { error } = await supabase.rpc('admin_add_ledger_entries', {
      p_league_id: league.id,
      p_entries: list,
    })
    if (error) { showToast(mutationErrorMessage(error, 'add ledger entries'), 'error'); return false }
    load()
    return true
  }

  async function handleManualAdd(e) {
    e.preventDefault()
    const amount = parseFloat(form.amount)
    if (!amount) { showToast('Enter a non-zero amount.', 'error'); return }
    if (!form.player_id && !form.team_id) { showToast('Pick a player or a team.', 'error'); return }
    const ok = await addEntries([{
      player_id: form.player_id || null,
      team_id: form.player_id ? null : (form.team_id || null),
      type: form.type,
      amount,
      note: form.note.trim() || null,
    }])
    if (ok) { showToast('Entry added.'); setForm(EMPTY_ENTRY) }
  }

  async function handleDelete(entry) {
    const { error } = await supabase.rpc('admin_delete_ledger_entry', { p_entry_id: entry.id })
    if (error) { showToast(mutationErrorMessage(error, 'delete the entry'), 'error'); return }
    load()
  }

  // ── Weekly auto-suggest: skins winners + match points from results ─────────
  async function buildSuggestions() {
    if (!suggestEvent) return
    const evt = events.find(e => e.id === suggestEvent)
    const perSkin = parseFloat(skinValue) || 0
    const perPoint = parseFloat(pointValue) || 0
    const out = []

    if (perSkin > 0) {
      const [{ data: evtScores }, { data: courseRow }] = await Promise.all([
        supabase.from('scores').select('player_id, hole_scores')
          .eq('event_id', suggestEvent).eq('location_id', locationId)
          .eq('entry_type', 'played').eq('status', 'verified'),
        evt.course_id
          ? supabase.from('courses').select('num_holes').eq('id', evt.course_id).single()
          : Promise.resolve({ data: null }),
      ])
      const inSkins = new Set(players.filter(p => p.in_skins).map(p => p.id))
      const scoreMap = {}
      ;(evtScores || []).forEach(s => {
        if (inSkins.has(s.player_id) && Array.isArray(s.hole_scores)) scoreMap[s.player_id] = s.hole_scores
      })
      const numHoles = courseRow?.num_holes || 9
      const skins = calcSkins(scoreMap, numHoles)
      const skinCount = {}
      Object.values(skins).forEach(pid => { if (pid) skinCount[pid] = (skinCount[pid] || 0) + 1 })
      Object.entries(skinCount).forEach(([pid, n]) => {
        out.push({
          include: true, player_id: pid, team_id: null, type: 'skins',
          amount: n * perSkin, event_id: suggestEvent,
          note: `${n} skin${n > 1 ? 's' : ''} — Wk ${evt.week_number ?? ''}`.trim(),
        })
      })
    }

    if (perPoint > 0) {
      const { data: mus } = await supabase.from('matchups')
        .select('home_team_id, away_team_id, points_home, points_away, status')
        .eq('event_id', suggestEvent).eq('status', 'scored')
      ;(mus || []).forEach(m => {
        if (!m.home_team_id) return
        if (Number(m.points_home) > 0) out.push({
          include: true, player_id: null, team_id: m.home_team_id, type: 'match_points',
          amount: Number(m.points_home) * perPoint, event_id: suggestEvent,
          note: `${Number(m.points_home)} pts — Wk ${evt.week_number ?? ''}`.trim(),
        })
        if (Number(m.points_away) > 0) out.push({
          include: true, player_id: null, team_id: m.away_team_id, type: 'match_points',
          amount: Number(m.points_away) * perPoint, event_id: suggestEvent,
          note: `${Number(m.points_away)} pts — Wk ${evt.week_number ?? ''}`.trim(),
        })
      })
    }

    setSuggestions(out)
    if (!out.length) showToast('Nothing to suggest for that week.', 'error')
  }

  async function confirmSuggestions() {
    const list = suggestions.filter(s => s.include).map(({ include, ...rest }) => rest)
    if (!list.length) { setSuggestions(null); return }
    const ok = await addEntries(list)
    if (ok) { showToast(`Added ${list.length} entr${list.length === 1 ? 'y' : 'ies'}.`); setSuggestions(null) }
  }

  // ── Who's owed: net balance per player/team ─────────────────────────────────
  const balances = {}
  entries.forEach(e => {
    const key = e.player_id ? `p:${e.player_id}` : `t:${e.team_id}`
    balances[key] = (balances[key] || 0) + Number(e.amount)
  })
  const owed = Object.entries(balances)
    .map(([key, amt]) => ({
      name: key.startsWith('p:') ? playerName(key.slice(2)) : teamName(key.slice(2)),
      amt,
    }))
    .filter(x => x.name && x.amt !== 0)
    .sort((a, b) => b.amt - a.amt)

  if (loading) return <div style={st.loading}>Loading…</div>

  return (
    <div style={st.container}>
      <Toast toast={toast} />

      {/* Who's owed */}
      <div style={st.card}>
        <h3 style={st.cardTitle}>Who's Owed</h3>
        {owed.length === 0 ? (
          <p style={st.hint}>All settled — no outstanding balances.</p>
        ) : owed.map(x => (
          <div key={x.name} style={st.owedRow}>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{x.name}</span>
            <span style={{ fontSize: 14, fontWeight: 800, color: x.amt > 0 ? 'var(--green-dark)' : '#c53030' }}>
              {x.amt > 0 ? '+' : ''}{x.amt.toFixed(2)}
            </span>
          </div>
        ))}
      </div>

      {/* Weekly suggest */}
      <div style={st.card}>
        <h3 style={st.cardTitle}>Suggest From Week Results</h3>
        <div style={st.row}>
          <select style={{ ...st.input, flex: 2 }} value={suggestEvent} onChange={e => { setSuggestEvent(e.target.value); setSuggestions(null) }}>
            <option value="">— closed week —</option>
            {events.map(e => <option key={e.id} value={e.id}>{e.week_number != null ? `Wk ${e.week_number} — ` : ''}{e.name}</option>)}
          </select>
          <div style={{ ...st.fieldGroup, width: 80 }}>
            <label style={st.label}>$/skin</label>
            <input type="number" min="0" style={st.input} value={skinValue} onChange={e => setSkinValue(e.target.value)} />
          </div>
          <div style={{ ...st.fieldGroup, width: 80 }}>
            <label style={st.label}>$/point</label>
            <input type="number" min="0" style={st.input} value={pointValue} onChange={e => setPointValue(e.target.value)} />
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={buildSuggestions} disabled={!suggestEvent}>
          Build suggestions
        </Button>
        {suggestions && suggestions.length > 0 && (
          <>
            {suggestions.map((s, i) => (
              <label key={i} style={st.suggestRow}>
                <input type="checkbox" checked={s.include}
                  onChange={() => setSuggestions(prev => prev.map((x, j) => j === i ? { ...x, include: !x.include } : x))} />
                <span style={{ flex: 1, fontSize: 12 }}>
                  {whoName(s)} · {s.type} · {s.note}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--green-dark)' }}>${Number(s.amount).toFixed(2)}</span>
              </label>
            ))}
            <Button variant="primary" size="sm" onClick={confirmSuggestions}>
              Add {suggestions.filter(s => s.include).length} to ledger
            </Button>
          </>
        )}
      </div>

      {/* Manual entry */}
      <form onSubmit={handleManualAdd} style={st.card}>
        <h3 style={st.cardTitle}>Add Entry</h3>
        <div style={st.row}>
          <select style={{ ...st.input, flex: 1 }} value={form.player_id}
            onChange={e => setForm(f => ({ ...f, player_id: e.target.value, team_id: '' }))}>
            <option value="">— player —</option>
            {players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select style={{ ...st.input, flex: 1 }} value={form.team_id}
            onChange={e => setForm(f => ({ ...f, team_id: e.target.value, player_id: '' }))}>
            <option value="">— or team —</option>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div style={st.row}>
          <select style={{ ...st.input, flex: 1 }} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
            {TYPES.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
          </select>
          <input type="number" step="0.01" placeholder="Amount (− = paid out)" style={{ ...st.input, flex: 1 }}
            value={form.amount} onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
        </div>
        <input placeholder="Note (optional)" style={st.input}
          value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} />
        <Button type="submit" variant="primary" size="sm">Add to Ledger</Button>
      </form>

      {/* Ledger */}
      <div style={st.card}>
        <h3 style={st.cardTitle}>Ledger ({entries.length})</h3>
        {entries.length === 0 ? (
          <EmptyState icon={<DollarSign size={36} strokeWidth={1.5} />} title="No entries yet"
            description="Add entries manually or build them from a week's results." />
        ) : entries.map(e => (
          <div key={e.id} style={st.entryRow}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{whoName(e)} <span style={st.typePill}>{e.type.replace('_', ' ')}</span></div>
              {e.note && <div style={{ fontSize: 11, color: 'var(--gray-400)' }}>{e.note}</div>}
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, color: Number(e.amount) > 0 ? 'var(--green-dark)' : '#c53030' }}>
              {Number(e.amount) > 0 ? '+' : ''}{Number(e.amount).toFixed(2)}
            </span>
            <button type="button" style={st.deleteBtn} onClick={() => handleDelete(e)}>
              <Trash2 size={13} strokeWidth={2} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

const st = {
  container: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  loading: { padding: '40px', textAlign: 'center', color: 'var(--gray-400)' },
  card: { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)', display: 'flex', flexDirection: 'column', gap: 10 },
  cardTitle: { fontSize: '14px', fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 4 },
  row: { display: 'flex', gap: 8, alignItems: 'flex-end' },
  label: { fontSize: '10px', fontWeight: 600, color: 'var(--gray-600)', textTransform: 'uppercase' },
  input: { padding: '9px 11px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '13px', background: 'var(--gray-100)', color: 'var(--black)', width: '100%' },
  hint: { fontSize: 11, color: 'var(--gray-400)' },
  owedRow: { display: 'flex', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--gray-100)' },
  suggestRow: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', borderBottom: '1px dashed var(--gray-100)', cursor: 'pointer' },
  entryRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--gray-100)' },
  typePill: { fontSize: 9, fontWeight: 700, background: 'var(--gray-100)', color: 'var(--gray-500)', padding: '1px 6px', borderRadius: 8, marginLeft: 6, textTransform: 'uppercase' },
  deleteBtn: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 6, background: '#fff5f5', color: '#c53030', border: '1px solid #fecaca', cursor: 'pointer' },
}

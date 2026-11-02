import React, { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import { loadWorkingLeague } from '../../lib/leagueUtils'
import { Button, Input } from '../ui'
import { mutationErrorMessage } from '../../lib/rpcErrors'
import './admin-reminders.css'

const empty = { sub_first_name: '', sub_last_name: '', sub_email: '', sub_phone: '', sub_handicap: '' }
export default function AdminAddSub({ knownSubs, onAdded }) {
  const { locationId } = useLocation()
  const [expanded, setExpanded] = useState(false)
  const [events, setEvents] = useState([])
  const [roster, setRoster] = useState([])
  const [eventId, setEventId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [playerId, setPlayerId] = useState('')
  const [subId, setSubId] = useState('')
  const [form, setForm] = useState(empty)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!expanded) return
    let cancelled = false
    setLoading(true); setError(''); setEventId(''); setRoster([])
    loadWorkingLeague(supabase, locationId).then(async league => {
      const { data, error } = await supabase.from('events').select('id,name,week_number').eq('location_id', locationId).eq('league_id', league.id).eq('status', 'open').eq('is_bye', false).order('week_number')
      if (error) throw error
      if (!cancelled) { setEvents(data || []); setEventId(data?.[0]?.id || '') }
    }).catch(e => { if (!cancelled) setError(e.message) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [expanded, locationId])
  useEffect(() => {
    setRoster([]); setTeamId(''); setPlayerId('')
    if (!eventId) return
    let cancelled = false
    supabase.from('roster_at').select('team_id,team_name,player_id,player_name').eq('location_id', locationId).eq('event_id', eventId).order('team_name')
      .then(({ data, error }) => { if (cancelled) return; if (error) setError(error.message); else setRoster(data || []) })
    return () => { cancelled = true }
  }, [eventId, locationId])
  const teams = [...new Map(roster.map(r => [r.team_id, r])).values()]
  async function submit(e) {
    e.preventDefault(); setError('')
    if (!eventId || !playerId) { setError('Choose a week, team, and player to cover.'); return }
    setBusy(true)
    try {
      const { error } = await supabase.rpc('admin_add_sub', {
        p_event_id: eventId, p_player_id: playerId,
        p_sub: subId ? { sub_player_id: subId } : { ...form, sub_handicap: Number(form.sub_handicap) },
      })
      if (error) throw error
      setForm(empty); setSubId(''); setExpanded(false); onAdded()
    } catch (e) { setError(mutationErrorMessage(e, 'add this substitute')) }
    finally { setBusy(false) }
  }
  return <section className="admin-task">
    <div className="admin-task-heading"><div><h3>Add a sub for a team</h3><p>Assign a substitute directly. The assignment is approved immediately.</p></div>
      <Button variant={expanded ? 'secondary' : 'primary'} onClick={() => setExpanded(v => !v)} disabled={busy}>{expanded ? 'Cancel' : 'Add sub'}</Button></div>
    {expanded && <form onSubmit={submit} className="admin-task-form">
      {loading ? <p role="status">Loading open weeks…</p> : !events.length && !error ? <p>No open playing week. Open a week in Schedule first.</p> : null}
      <fieldset disabled={busy || loading}>
        <div className="admin-task-grid">
          <div className="admin-task-field"><label htmlFor="admin-sub-week">Week</label><select id="admin-sub-week" required value={eventId} onChange={e => setEventId(e.target.value)}><option value="">Choose a week</option>{events.map(e => <option key={e.id} value={e.id}>{e.name || `Week ${e.week_number}`}</option>)}</select></div>
          <div className="admin-task-field"><label htmlFor="admin-sub-team">Team</label><select id="admin-sub-team" required value={teamId} onChange={e => { setTeamId(e.target.value); setPlayerId('') }}><option value="">Choose a team</option>{teams.map(r => <option key={r.team_id} value={r.team_id}>{r.team_name}</option>)}</select></div>
          <div className="admin-task-field"><label htmlFor="admin-sub-player">Player being covered</label><select id="admin-sub-player" required value={playerId} onChange={e => setPlayerId(e.target.value)}><option value="">Choose a player</option>{roster.filter(r => r.team_id === teamId).map(r => <option key={r.player_id} value={r.player_id}>{r.player_name}</option>)}</select></div>
          <div className="admin-task-field"><label htmlFor="admin-sub-profile">Substitute</label><select id="admin-sub-profile" value={subId} onChange={e => setSubId(e.target.value)}><option value="">Enter a new substitute</option>{knownSubs.map(s => <option key={s.id} value={s.id}>{s.name || `${s.first_name} ${s.last_name}`}</option>)}</select></div>
        </div>
        {!subId && <div className="admin-task-grid">
          <Input id="admin-sub-first" label="Sub first name" required maxLength={100} value={form.sub_first_name} onChange={e => setForm(f => ({ ...f, sub_first_name: e.target.value }))} />
          <Input id="admin-sub-last" label="Sub last name" required maxLength={100} value={form.sub_last_name} onChange={e => setForm(f => ({ ...f, sub_last_name: e.target.value }))} />
          <Input id="admin-sub-email" label="Email (optional)" type="email" value={form.sub_email} onChange={e => setForm(f => ({ ...f, sub_email: e.target.value }))} />
          <Input id="admin-sub-phone" label="Phone (optional)" type="tel" value={form.sub_phone} onChange={e => setForm(f => ({ ...f, sub_phone: e.target.value }))} />
          <Input id="admin-sub-handicap" label="9-hole handicap" type="number" min={-2} max={40} step={1} required value={form.sub_handicap} onChange={e => setForm(f => ({ ...f, sub_handicap: e.target.value }))} />
        </div>}
        <Button type="submit" disabled={busy || !eventId || !playerId}>{busy ? 'Adding…' : 'Add approved sub'}</Button>
      </fieldset>
      {error && <p className="admin-task-error" role="alert">{error}</p>}
    </form>}
  </section>
}

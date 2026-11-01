import React, { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import { loadWorkingLeague } from '../../lib/leagueUtils'
import { Button } from '../ui'
import { mutationErrorMessage } from '../../lib/rpcErrors'
import './admin-reminders.css'

const weekdays = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
export default function AdminScoreReminders() {
  const { locationId, timezone } = useLocation()
  const [league, setLeague] = useState(null)
  const [schedules, setSchedules] = useState([])
  const [weekday, setWeekday] = useState('0')
  const [time, setTime] = useState('18:00')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(''); setMessage(''); setLeague(null); setSchedules([])
    loadWorkingLeague(supabase, locationId).then(async league => {
      const { data, error } = await supabase.from('score_reminder_schedules').select('*').eq('location_id', locationId).eq('league_id', league.id).order('created_at', { ascending: false }).limit(20)
      if (error) throw error
      if (cancelled) return
      setLeague(league); setSchedules(data || [])
      const current = data?.find(s => s.enabled)
      if (current) { setWeekday(String(current.weekday)); setTime(current.local_time.slice(0,5)) }
    }).catch(e => { if (!cancelled) setError(e.message) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [locationId, retry])
  async function refresh() {
    const { data, error } = await supabase.from('score_reminder_schedules').select('*').eq('location_id', locationId).eq('league_id', league.id).order('created_at', { ascending: false }).limit(20)
    if (error) throw error
    setSchedules(data || [])
  }
  async function save(e) {
    e.preventDefault(); setBusy(true); setError(''); setMessage('')
    try {
      const { error } = await supabase.rpc('admin_schedule_score_reminder', {
        p_league_id: league.id, p_config: { weekday: Number(weekday), local_time: time, timezone },
      })
      if (error) throw error
      await refresh(); setMessage('Weekly score reminder saved.')
    } catch (e) { setError(mutationErrorMessage(e, 'schedule score reminders')) }
    finally { setBusy(false) }
  }
  async function cancel(id) {
    setBusy(true); setError(''); setMessage('')
    try {
      const { error } = await supabase.rpc('admin_cancel_score_reminder', { p_id: id })
      if (error) throw error
      await refresh(); setMessage('Weekly reminder turned off.')
    } catch (e) { setError(mutationErrorMessage(e, 'turn off this reminder')) }
    finally { setBusy(false) }
  }
  const current = schedules.find(s => s.enabled)
  const format = (value, zone = timezone) => new Date(value).toLocaleString('en-US', { timeZone: zone, weekday:'short', month:'short', day:'numeric', hour:'numeric', minute:'2-digit', timeZoneName:'short' })
  return <div className="admin-reminders">
    <section className="admin-task">
      <h3>Weekly score reminder</h3>
      <p>Remind players who still need to enter a score for the open week. Each player receives a private account alert and a phone notification if enabled.</p>
      {loading ? <p role="status">Loading reminder settings…</p> : league ? <>
        <p><strong>{league.name}</strong> · Times shown in {timezone.replaceAll('_',' ')}.</p>
        <form onSubmit={save} className="admin-task-form">
          <fieldset disabled={busy}><div className="admin-task-grid">
            <div className="admin-task-field"><label htmlFor="score-reminder-weekday">Every week on</label><select id="score-reminder-weekday" value={weekday} onChange={e => setWeekday(e.target.value)}>{weekdays.map((day,i) => <option key={day} value={i}>{day}</option>)}</select></div>
            <label>At<input type="time" required value={time} onChange={e => setTime(e.target.value)} /></label>
          </div><Button type="submit" disabled={busy}>{busy ? 'Saving…' : current ? 'Update weekly reminder' : 'Schedule weekly reminder'}</Button></fieldset>
        </form>
        <p>We check scores when the reminder runs. Submitted and substitute-covered scores count as entered. Closed weeks, future weeks, and byes are skipped.</p>
        <p>Players need a linked app account to receive a private reminder. Phone delivery also requires notifications to be enabled on their device.</p>
      </> : <Button variant="secondary" onClick={() => setRetry(n => n+1)}>Try again</Button>}
      {error && <p role="alert" className="admin-task-error">{error}</p>}
      {message && <p role="status" className="admin-reminders-status">{message}</p>}
    </section>
    {!loading && league && <section className="admin-task">
      <div className="admin-task-heading"><h3>Reminder schedule</h3><Button variant="ghost" size="sm" disabled={busy} onClick={() => refresh().catch(e => setError(e.message))}>Refresh</Button></div>
      {!schedules.length ? <p>No reminders scheduled. Choose a weekday and time above to begin.</p> : schedules.map(s => <div className="admin-reminder-row" key={s.id}>
        <div><strong>Every {weekdays[s.weekday]} at {new Date(`2000-01-01T${s.local_time}`).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})} · {s.enabled ? 'On' : 'Off'}</strong>
          {s.enabled && <p>Next reminder: {format(s.next_run_at,s.timezone)}</p>}
          {s.last_run_at && <p>Last run: {format(s.last_run_at,s.timezone)}. {s.last_recipient_count} account alert{s.last_recipient_count === 1 ? '' : 's'} created.{s.last_unlinked_count > 0 ? ` ${s.last_unlinked_count} player${s.last_unlinked_count === 1 ? '' : 's'} could not be reached because no app account is linked.` : ''}</p>}
          {!s.last_run_at && <p>{s.enabled ? 'Waiting for the first scheduled run.' : 'Turned off before its first run.'}</p>}
        </div>{s.enabled && <Button variant="secondary" size="sm" disabled={busy} onClick={() => cancel(s.id)}>Turn off</Button>}
      </div>)}
    </section>}
  </div>
}

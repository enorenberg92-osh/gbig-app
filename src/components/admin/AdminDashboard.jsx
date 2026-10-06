import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle2, RefreshCw, Lock, Clipboard, Mail } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import { useFeature } from '../../context/FeatureContext'
import { loadWorkingLeague } from '../../lib/leagueUtils'
import { hasCompleteCoursePars } from '../../lib/holeUtils'
import { closeoutStatus, closeoutSkins, closeoutResults, penaltyNet, recapText } from '../../lib/closeoutUtils'
import { mutationErrorMessage } from '../../lib/rpcErrors'
import ConfirmDialog from '../ConfirmDialog'
import { Button } from '../ui'
import './closeout.css'

async function checked(query) {
  const result = await query
  if (result.error) throw result.error
  return result.data
}

export default function AdminDashboard({ onWeekClosed = () => {} }) {
  const { locationId, appName } = useLocation()
  const skinsEnabled = useFeature('skins')
  const [snapshot, setSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reviewed, setReviewed] = useState(false)
  const [penaltiesAccepted, setPenaltiesAccepted] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [email, setEmail] = useState('')
  const [step, setStep] = useState('review')
  const sequence = useRef(0)

  useEffect(() => {
    load()
    return () => { sequence.current++ }
  }, [locationId])

  async function readSnapshot(eventId) {
    const league = await loadWorkingLeague(supabase, locationId)
    let event
    if (eventId) {
      event = await checked(supabase.from('events').select('*').eq('id', eventId).eq('location_id', locationId).eq('league_id', league.id).single())
    } else {
      event = await checked(supabase.from('events').select('*').eq('location_id', locationId).eq('league_id', league.id).eq('status', 'open').order('week_number').limit(1).maybeSingle())
      if (!event) event = await checked(supabase.from('events').select('*').eq('location_id', locationId).eq('league_id', league.id).eq('status', 'closed').order('week_number', { ascending: false }).limit(1).maybeSingle())
    }
    if (!event) return null
    const [scores, roster, teams, players, course, matchups] = await Promise.all([
      checked(supabase.from('scores').select('id, player_id, team_id, status, entry_type, net_total, gross_total, hole_scores, format_points, created_at').eq('event_id', event.id).eq('location_id', locationId)),
      checked(supabase.from('roster_at').select('player_id, team_id').eq('event_id', event.id)),
      checked(supabase.from('teams').select('id, name').eq('league_id', league.id).eq('location_id', locationId)),
      checked(supabase.from('players').select('id, name, email, handicap, in_skins').eq('location_id', locationId)),
      event.course_id ? checked(supabase.from('courses').select('id, name, num_holes, total_par, hole_pars, start_hole').eq('id', event.course_id).eq('location_id', locationId).single()) : null,
      checked(supabase.from('matchups').select('*').eq('event_id', event.id)),
    ])
    return { event, league, scores, roster, teams, players, course, matchups, skinsEnabled }
  }

  async function load(eventId) {
    const request = ++sequence.current
    setLoading(true)
    setError('')
    try {
      const next = await readSnapshot(eventId)
      if (request !== sequence.current) return
      setSnapshot(next)
      setReviewed(false)
      setPenaltiesAccepted(false)
      setEmail(next ? recapText(next, appName) : '')
      setStep(next?.event.status === 'closed' ? 'recap' : 'review')
    } catch (err) {
      if (request === sequence.current) setError(mutationErrorMessage(err, 'load closeout details'))
    } finally {
      if (request === sequence.current) setLoading(false)
    }
  }

  async function publish() {
    if (busy) return
    setConfirm(false)
    setBusy(true)
    setError('')
    let published = false
    try {
      const result = await checked(supabase.rpc('publish_week', { p_event_id: snapshot.event.id }))
      published = true
      onWeekClosed(result?.next_event_id || null)
      // Keep the completed event in view; never compose a recap for next week.
      const final = await readSnapshot(snapshot.event.id)
      if (final.event.status !== 'closed') throw new Error('Publication status could not be confirmed. Refresh before trying again.')
      setSnapshot(final)
      setEmail(recapText(final, appName))
      setStep('recap')
      setNotice('Event closed. The recap below uses finalized results.')
    } catch (err) {
      setError(published
        ? 'The event was published, but its recap could not be loaded. Refresh this event to retrieve it; do not publish again.'
        : mutationErrorMessage(err, 'publish this week'))
      if (published) setSnapshot(previous => ({ ...previous, event: { ...previous.event, status: 'closed' } }))
    } finally { setBusy(false) }
  }

  async function copyRecap() {
    try { await navigator.clipboard.writeText(email); setNotice('Recap copied. It has not been emailed.') }
    catch { setNotice('Copy was blocked. Select the recap text and copy it manually.') }
  }

  if (loading) return <div className="closeout"><p role="status">Loading closeout details…</p></div>
  // A failed refresh must never leave stale data actionable.
  if (error && !snapshot) return <div className="closeout"><p role="alert">{error}</p><Button onClick={() => load()}>Try again</Button></div>
  if (!snapshot) return <div className="closeout"><h2>No round to close</h2><p>Open a round in Schedule when you’re ready to begin.</p><Link to="/league/admin/schedule">Go to Schedule</Link></div>

  const { event, course, players, scores, roster, teams, matchups } = snapshot
  const status = closeoutStatus(roster, scores)
  const closed = event.status === 'closed'
  const courseValid = hasCompleteCoursePars(course) && course.total_par === course.hole_pars.reduce((a,b) => a+b,0)
  const hasPending = status.pending.length > 0
  const canPublish = !closed && !error && status.rosterValid && courseValid && !hasPending && reviewed && (!status.missing.length || penaltiesAccepted)
  const name = id => players.find(p => p.id === id)?.name || 'Unknown player'
  const results = closeoutResults(event, scores, roster, teams, players, matchups)
  const skins = closeoutSkins(scores, players, course, roster)
  const rosterIds = new Set(roster.map(row => row.player_id))
  const recipients = [...new Set(players.filter(p => rosterIds.has(p.id) && p.email).map(p => p.email.trim().toLowerCase()))]

  return <div className="closeout" aria-busy={busy}>
    <header className="closeout-header">
      <div><p>{snapshot.league.name} · {course?.name || 'Course not set'}</p><h2>{event.name || `Week ${event.week_number}`}</h2></div>
      <span className="closeout-status">{closed ? 'Closed' : 'Open for scores'}</span>
    </header>
    <div className="closeout-toolbar">
      <nav aria-label="Closeout steps">{[['review','1. Review'],['publish','2. Close round'],['recap','3. Share recap']].map(([id,label]) =>
        <button key={id} disabled={busy || (id === 'recap' && !closed)} aria-current={step === id ? 'step' : undefined} onClick={() => setStep(id)}>{label}</button>)}</nav>
      <Button variant="secondary" disabled={busy} icon={<RefreshCw size={15}/>} onClick={() => load(event.id)}>Refresh</Button>
    </div>
    {notice && <p className="closeout-notice" role="status">{notice}</p>}
    {error && <p className="closeout-warning" role="alert">{error}</p>}
    <div className="closeout-counts" aria-label="Score status">
      {[['Verified played',status.verified.length],['Awaiting review',status.pending.length],['Missing',status.missing.length],['Existing penalties',status.penalties.length]].map(([label,value]) => <div key={label}><strong>{value}</strong><span>{label}</span></div>)}
    </div>
    <p className="closeout-muted">{status.completeTeams.length} of {status.teamIds.length} teams have both results verified. {status.expected} rostered players.</p>
    {!status.rosterValid && <p className="closeout-warning">The roster needs attention. Each team must have exactly two different players before closing.</p>}
    {!courseValid && <p className="closeout-warning">Check the assigned course, hole pars, and total par before closing.</p>}

    {step === 'review' && <>
      {hasPending && <section><h3>Awaiting review</h3><p>Approve or reject these scores before closing. Pending scores are not missing rounds.</p><ul>{status.pending.map(row => <li key={row.id}>{name(row.player_id)}</li>)}</ul><Link to="/league/admin/scores">Review scores →</Link></section>}
      {!!status.missing.length && <section><h3>Missing scores</h3><p>Confirm these players did not play. Closing will apply your missed-week rule.</p><ul>{status.missing.map(id => <li key={id}>{name(id)} <span>{courseValid ? `Penalty net ${penaltyNet(course, players.find(p => p.id === id)?.handicap)}` : 'Course setup required'}</span></li>)}</ul><Link to="/league/admin/scores">Enter or correct scores →</Link></section>}
      <section><h3>{closed ? 'Final results' : 'Results preview'}</h3>{!closed && <p>Verified scores only. Missing-round penalties and format results are finalized when the round closes.</p>}
        {results.map(row => <div className="closeout-result" key={row.id}><span>{row.name}</span><strong>{row.result}</strong></div>)}
      </section>
      {skinsEnabled && <section><h3>Skins {closed ? '' : 'preview'}</h3>{skins.length ? skins.map(s => <div className="closeout-result" key={s.hole}><span>Hole {s.hole} · {s.player.name}</span><strong>{s.score}</strong></div>) : <p>{hasPending || status.missing.length ? 'No winners in the verified scores so far. Resolve outstanding scores before confirming.' : 'No skins won. Tied holes are a completed result.'}</p>}</section>}
      {!closed && <Button disabled={busy || hasPending || !status.rosterValid || !courseValid || !!error} onClick={() => { setReviewed(true); setStep('publish') }}>Review complete — close round</Button>}
    </>}

    {step === 'publish' && <section>
      <h3>{closed ? 'This round is closed' : 'Close this round'}</h3>
      <p>Closing locks the round, applies missed-week penalties, computes format results, and opens the next scheduled playable week. The email recap comes afterward.</p>
      {hasPending && <p className="closeout-warning">Resolve {status.pending.length} pending score(s) before publishing.</p>}
      {!closed && !reviewed && <p className="closeout-warning">Complete the Review step before closing.</p>}
      {!!status.missing.length && !closed && <label className="closeout-confirm"><input type="checkbox" checked={penaltiesAccepted} onChange={e => setPenaltiesAccepted(e.target.checked)}/><span>I reviewed the {status.missing.length} missing player(s). Apply net penalties of course par + rounded handicap + 7.</span></label>}
      {!closed && <Button fullWidth icon={<Lock size={16}/>} disabled={!canPublish || busy} loading={busy} onClick={() => setConfirm(true)}>Lock &amp; publish round</Button>}
      {closed && <Button onClick={() => setStep('recap')}>View finalized recap</Button>}
    </section>}

    {step === 'recap' && closed && <section>
      <h3><CheckCircle2 size={20}/> Ready to share</h3><p>These results were reloaded after publishing. Copying or opening your mail app does not send the message.</p>
      <label htmlFor="closeout-recap">Weekly recap</label><textarea id="closeout-recap" value={email} onChange={e => setEmail(e.target.value)} rows={16}/>
      <div className="closeout-actions"><Button icon={<Clipboard size={15}/>} disabled={!email || !!error} onClick={copyRecap}>Copy recap</Button>
        {email && !error && <a href={`mailto:?bcc=${encodeURIComponent(recipients.join(','))}&subject=${encodeURIComponent(`${event.name || 'League'} — Results`)}&body=${encodeURIComponent(email)}`}><Mail size={15}/> Open mail app</a>}</div>
      <p className="closeout-muted">{recipients.length} unique email address(es) from this round’s roster. No other leagues are included.</p>
    </section>}
    {confirm && <ConfirmDialog destructive={false} message={`Close ${event.name || 'this round'}? ${status.missing.length} missing player(s) will receive penalties. This locks the round and opens the next playable week.`} confirmLabel="Lock & publish" onCancel={() => setConfirm(false)} onConfirm={publish}/>}
  </div>
}

import React, { useEffect, useId, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Button } from '../ui'
import './player-login.css'

export async function invokePlayerLogin(playerId, action, extra = {}) {
  const { data, error: requestError } = await supabase.functions.invoke('update-player-login', {
    body: { action, player_id: playerId, ...extra },
  })
  if (requestError) {
    let message = 'Could not reach login management. Refresh and try again.'
    try { message = (await requestError.context.json()).error || message } catch { /* No server response. */ }
    throw new Error(message)
  }
  if (data?.error) throw new Error(data.error)
  if (!data?.player || data.player.id !== playerId) throw new Error('The player details could not be verified. Refresh and try again.')
  return data
}

export default function PlayerLoginEditor({ playerId, onClose, onSaved }) {
  const [details, setDetails] = useState(null)
  const [email, setEmail] = useState('')
  const [review, setReview] = useState(null)
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const inputId = useId()
  const heading = useRef(null)
  const inFlight = useRef(false)
  const mounted = useRef(true)

  const invoke = (action, extra) => invokePlayerLogin(playerId, action, extra)

  useEffect(() => {
    mounted.current = true
    heading.current?.focus()
    setBusy(true)
    invoke('status').then(data => {
      if (!mounted.current) return
      setDetails(data)
      setEmail(data.player.email || data.auth_email || '')
    }).catch(err => {
      if (mounted.current) setError(err.message)
    }).finally(() => { if (mounted.current) setBusy(false) })
    return () => { mounted.current = false }
  }, [playerId])

  async function preview(event) {
    event.preventDefault()
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true); setError(''); setSuccess(''); setReview(null); setConfirmed(false)
    try {
      const data = await invoke('preview', { email })
      if (mounted.current) { setReview(data); setDetails(data) }
    } catch (err) { if (mounted.current) setError(err.message) }
    finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }

  async function apply() {
    if (inFlight.current || !review || !confirmed) return
    inFlight.current = true
    setBusy(true); setError('')
    try {
      const data = await invoke('apply', { review: review.review, confirmed: true })
      if (!mounted.current) return
      setDetails(data); setEmail(data.player.email); setReview(null); setConfirmed(false)
      setSuccess(data.email_confirmed
        ? 'Roster and login emails verified. The player can use the corrected email with their existing password.'
        : 'Roster and login emails verified. This account still needs the normal email verification step before sign-in.')
      onSaved()
    } catch (err) {
      if (mounted.current) {
        setError(err.message)
        setReview(null); setConfirmed(false)
        // Do not offer a blind retry after an ambiguous Auth/roster result.
        setDetails(current => current ? { ...current, blocked: 'Refresh login details before making another correction.' } : current)
      }
    } finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }

  async function refresh() {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true); setReview(null); setConfirmed(false); setError(''); setSuccess('')
    try {
      const data = await invoke('status')
      if (mounted.current) { setDetails(data); setEmail(data.player.email || data.auth_email || '') }
    } catch (err) { if (mounted.current) setError(err.message) }
    finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }

  return (
    <section className="player-login" aria-labelledby={inputId + '-heading'} aria-busy={busy}>
      <div className="player-login-heading">
        <h3 id={inputId + '-heading'} tabIndex={-1} ref={heading}>Manage player login</h3>
        <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>Close</Button>
      </div>
      {!details && busy && <p role="status">Loading the existing login…</p>}
      {error && <p className="player-login-error" role="alert">{error}</p>}
      {success && <p className="player-login-success" role="status">{success}</p>}
      {details && <>
        <p className="player-login-person"><strong>{details.player.name}</strong> · {details.venue}</p>
        <dl className="player-login-details">
          <div><dt>Roster email</dt><dd>{details.player.email || 'No roster email'}</dd></div>
          <div><dt>Login email</dt><dd>{details.auth_email || 'No linked login'}</dd></div>
          <div><dt>Last sign-in</dt><dd>{details.last_sign_in_at ? new Date(details.last_sign_in_at).toLocaleString() : 'No sign-in recorded'}</dd></div>
          <div><dt>Email confirmation</dt><dd>{details.email_confirmed ? 'Already confirmed' : 'Not confirmed'}</dd></div>
        </dl>
        {details.blocked ? <p role="status" className="player-login-error">{details.blocked}</p> : <form onSubmit={preview}>
          <label htmlFor={inputId}>Corrected email address</label>
          <input id={inputId} type="email" required maxLength={254} value={email} disabled={busy}
            autoComplete="off" spellCheck={false} aria-describedby={inputId + '-help'}
            onChange={event => { setEmail(event.target.value); setReview(null); setConfirmed(false); setError(''); setSuccess('') }} />
          <p className="player-login-help" id={inputId + '-help'}>Use the address confirmed by this player. Both the roster and the existing login will use it.</p>
          <Button type="submit" variant="secondary" disabled={busy} loading={busy && !review} loadingText="Checking…">Review email correction</Button>
        </form>}
        {review && <div className="player-login-review">
          <h4>Review before updating</h4>
          <dl className="player-login-details">
            <div><dt>Roster email</dt><dd>{review.player.email || 'None'} → <strong>{review.new_email}</strong></dd></div>
            <div><dt>Login email</dt><dd>{review.auth_email} → <strong>{review.new_email}</strong></dd></div>
          </dl>
          <p className="player-login-help">{review.notice}</p>
          {!review.email_confirmed && <p className="player-login-help">This account will still need its normal email verification before sign-in. This correction does not mark it verified.</p>}
          <label className="player-login-confirm">
            <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />
            <span>I confirmed this address and player identity, and approve changing this existing login.</span>
          </label>
          <Button type="button" variant="primary" onClick={apply} disabled={!confirmed || busy} loading={busy} loadingText="Updating…">Update roster and login email</Button>
        </div>}
      </>}
      <div className="player-login-footer">
        <Button type="button" variant="secondary" size="sm" onClick={refresh} disabled={busy}>Refresh login details</Button>
        <p className="player-login-help">Names and league details can be corrected with Edit Player. Account linking alone does not mean the player has signed in.</p>
      </div>
    </section>
  )
}

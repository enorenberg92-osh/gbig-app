import React, { useEffect, useRef, useState } from 'react'
import { Mail, RefreshCw } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { Button } from '../ui'
import EmailSetupGuide from './EmailSetupGuide'
import './weekly-email.css'

export function weeklyEmailValidation(subject, text) {
  if (!subject.trim()) return 'Enter a subject before previewing.'
  if (subject.length > 200) return 'Keep the subject to 200 characters or fewer.'
  if (!text.trim()) return 'Enter the message before previewing.'
  if (text.length > 20000) return 'Keep the message to 20,000 characters or fewer.'
  return ''
}

export function directEmailValidation(to) {
  const address = to.trim()
  return address.length <= 254 && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(address)
    ? '' : 'Enter one email address in To. Multiple recipients are not supported here.'
}

export function weeklyEmailStarted(draft) {
  return !!draft && (draft.status !== 'draft' || draft.accepted_count > 0 || draft.review_count > 0)
}

async function requestEmail(body) {
  const { data, error } = await supabase.functions.invoke('weekly-email', { body })
  if (error) {
    // Supabase's HTTP error message is generic; use the endpoint's safe detail.
    let message = error.message
    try {
      const detail = await error.context?.json()
      message = detail?.error || detail?.message || message
    } catch { /* A network error may not have a response body. */ }
    throw new Error(typeof message === 'string' ? message : 'The email service could not be reached.')
  }
  if (!data || data.error) throw new Error(data?.error || 'The email service returned an empty response.')
  return data
}

/** Server-confirmed recipients and immutable drafts keep every send scoped to its saved email. */
export default function WeeklyEmail({ eventId, locationId, actorId, venueName, venueSlug, mode = 'weekly', disabled = false, onBusyChange = () => {}, onProgressChange = () => {} }) {
  const direct = mode === 'direct'
  const [to, setTo] = useState('')
  const [composeId, setComposeId] = useState('')
  const [storageWarning, setStorageWarning] = useState('')
  const composeRef = useRef('')
  const recipientInput = useRef(null)
  const storageKey = actorId && locationId ? `weekly-email:compose:${locationId}:${actorId}` : null
  const [subject, setSubject] = useState('')
  const [text, setText] = useState('')
  const [draft, setDraft] = useState(null)
  const [sender, setSender] = useState('')
  const [senders, setSenders] = useState([])
  const [senderId, setSenderId] = useState('')
  const [setup, setSetup] = useState(null)
  const [phase, setPhase] = useState('loading')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [sendStarted, setSendStarted] = useState(false)
  const [statusRequired, setStatusRequired] = useState(false)
  const sequence = useRef(0)
  const inFlight = useRef(false)
  const busyCallback = useRef(onBusyChange)
  busyCallback.current = onBusyChange
  const progressCallback = useRef(onProgressChange)
  progressCallback.current = onProgressChange

  const busy = phase !== 'idle'
  const locked = sendStarted || weeklyEmailStarted(draft)
  const selectedSender = senders.find(item => item.id === senderId)
  const senderAuthorized = !!selectedSender
  const displayedSender = locked ? draft?.from || sender : selectedSender?.from || sender
  const currentPreview = !!draft && draft.subject === subject && draft.text === text && draft.sender_id === senderId && (!direct || (draft.mode === 'direct' && draft.recipient_count === 1 && draft.to === to && draft.compose_id === composeId))

  useEffect(() => {
    const version = ++sequence.current
    inFlight.current = false
    setSubject('')
    setText('')
    setTo('')
    let savedCompose = ''
    setStorageWarning('')
    if (direct && storageKey) {
      try {
        if (!globalThis.sessionStorage) throw new Error('Storage unavailable')
        const saved = globalThis.sessionStorage.getItem(storageKey)
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved || '')) savedCompose = saved
      } catch { setStorageWarning('This browser cannot remember the active email across reloads. Keep this page open until sending finishes.') }
    }
    composeRef.current = direct ? savedCompose || globalThis.crypto.randomUUID() : ''
    setComposeId(composeRef.current)
    setDraft(null)
    setSender('')
    setSenders([])
    setSenderId('')
    setSetup(null)
    setError('')
    setNotice('')
    setSendStarted(false)
    setStatusRequired(false)
    checkStatus(true, version, savedCompose)
    return () => {
      sequence.current++
      busyCallback.current(false)
    }
  }, [eventId, locationId, mode, actorId])

  function rememberCompose(id) {
    composeRef.current = id
    setComposeId(id)
    if (!direct || !id || !storageKey) return
    try {
      if (!globalThis.sessionStorage) throw new Error('Storage unavailable')
      // Only the opaque compose ID is retained, never message text or addresses.
      globalThis.sessionStorage.setItem(storageKey, id)
    } catch { setStorageWarning('This browser cannot remember the active email across reloads. Keep this page open until sending finishes.') }
  }

  function emailScope() {
    return direct ? { mode: 'direct', location_id: locationId } : { event_id: eventId }
  }

  function begin(nextPhase) {
    if (inFlight.current) return false
    inFlight.current = true
    setPhase(nextPhase)
    setError('')
    setNotice('')
    busyCallback.current(true)
    return true
  }

  function finish(version) {
    if (version !== sequence.current) return
    inFlight.current = false
    setPhase('idle')
    busyCallback.current(false)
  }

  function reportProgress(next, started = weeklyEmailStarted(next)) {
    progressCallback.current({ eventId, locationId, started, pending: next?.pending_count || 0, review: next?.review_count || 0, statusError: '' })
  }

  function showDraft(next, hydrate = true) {
    setDraft(next)
    reportProgress(next)
    if (next?.from) setSender(next.from)
    if (hydrate && next) {
      setSubject(next.subject)
      setText(next.text)
      setSenderId(next.sender_id || '')
      if (direct) {
        setTo(next.to || '')
        rememberCompose(next.compose_id || '')
          }
    }
    if (weeklyEmailStarted(next)) setSendStarted(true)
  }

  async function checkStatus(hydrate = false, version = sequence.current, savedCompose = '') {
    if (!begin(hydrate ? 'loading' : 'checking')) return
    try {
      const requestedCompose = direct ? (hydrate ? savedCompose : composeRef.current) : ''
      const result = await requestEmail({ action: 'status', ...emailScope(), ...(requestedCompose ? { compose_id: requestedCompose } : {}) })
      if (version !== sequence.current) return
      setSetup(result.setup)
      const approved = Array.isArray(result.senders) ? result.senders : []
      setSenders(approved)
      const preferred = approved.find(item => item.is_default) || approved[0]
      if (typeof result.from === 'string') setSender(result.from)
      // A setup check must not replace unsaved writing with an old preview.
      // A setup check after New email must not resurrect the completed message.
      const relevantLatest = !direct || !requestedCompose || !result.latest || result.latest.compose_id === requestedCompose
      const restore = relevantLatest && (hydrate || statusRequired || weeklyEmailStarted(result.latest))
      // Preserve restored sender identity, even when permission was removed.
      // Only IDs from the current server-approved list may create a preview.
      if (!(restore && result.latest)) {
        setSenderId(previous => approved.some(item => item.id === previous) ? previous : preferred?.id || '')
      }
      if (restore || (relevantLatest && result.latest?.draft_id && result.latest.draft_id === draft?.draft_id)) {
        showDraft(result.latest, restore)
        // A rejected pre-send request (for example, a changed roster) does not
        // freeze editing once the server confirms no send has started.
        if (result.latest || hydrate) setSendStarted(weeklyEmailStarted(result.latest))
      }
      if (direct && hydrate && !result.latest) rememberCompose(composeRef.current)
      setStatusRequired(false)
      if (!hydrate) setNotice('Email status refreshed. This check does not send email.')
    } catch (err) {
      if (version === sequence.current) {
        setError(err.message)
        setStatusRequired(true)
        progressCallback.current({ eventId, locationId, statusError: err.message })
      }
    } finally { finish(version) }
  }

  async function preview() {
    if (disabled || locked || inFlight.current || !senderAuthorized) return
    const validation = (direct ? directEmailValidation(to) : '') || weeklyEmailValidation(subject, text)
    if (validation) { setError(validation); return }
    if (!begin('previewing')) return
    const version = sequence.current
    // The previous audience must never remain sendable after a failed re-preview.
    setDraft(null)
    try {
      const result = await requestEmail({ action: 'preview', ...emailScope(), sender_id: senderId, subject, text, ...(direct ? { to, compose_id: composeId } : {}) })
      if (version !== sequence.current) return
      showDraft(result)
      setNotice(direct ? 'Preview saved. Check From, To, subject, and message, then choose Send email.' : 'Preview saved. Check the message and recipient counts, then choose Send.')
    } catch (err) {
      if (version === sequence.current) {
        setError(err.message)
        setStatusRequired(true)
      }
    } finally { finish(version) }
  }

  async function send() {
    if (disabled || !currentPreview || !senderAuthorized || !setup?.configured || statusRequired || !draft.pending_count || !['draft', 'sending', 'review'].includes(draft.status) || !begin('sending')) return
    const version = sequence.current
    const draftId = draft.draft_id
    setSendStarted(true)
    reportProgress(draft, true)
    try {
      // Only an explicit Send or Continue click reaches this action. No recipients
      // or editable content are supplied, including after an interrupted request.
      const result = await requestEmail({ action: 'send', ...emailScope(), draft_id: draftId })
      if (version !== sequence.current) return
      showDraft(result)
      setNotice(result.message ? '' : result.pending_count > 0
        ? 'Batch finished. Choose Continue sending for the remaining recipients.'
        : 'Email processing finished. Review the results below.')
    } catch (err) {
      if (version === sequence.current) {
        setError(`${err.message} Refresh email status before continuing. Do not start another draft.`)
        setStatusRequired(true)
      }
    } finally { finish(version) }
  }

  function newEmail() {
    if (!direct || busy || disabled || draft?.status !== 'accepted') return
    rememberCompose(globalThis.crypto.randomUUID())
    setTo('')
    setSubject('')
    setText('')
    setDraft(null)
    setSendStarted(false)
    setStatusRequired(false)
    setError('')
    setNotice('New email started. Enter one To address and preview before sending.')
    const preferred = senders.find(item => item.is_default) || senders[0]
    setSenderId(preferred?.id || '')
    setSender(preferred?.from || '')
    reportProgress(null)
  }

  const canPreview = !busy && !disabled && senderAuthorized && !locked && !statusRequired && (!direct || !directEmailValidation(to)) && !!subject.trim() && !!text.trim()
  const canSend = !busy && !disabled && senderAuthorized && currentPreview && setup?.configured && !statusRequired && draft.pending_count > 0 && ['draft', 'sending', 'review'].includes(draft.status)

  return <section className="weekly-email" aria-labelledby="weekly-email-title" aria-busy={busy}>
    <h3 id="weekly-email-title"><Mail size={20} aria-hidden="true"/> {direct ? 'Email' : 'Weekly Email'}</h3>
    <p>{direct ? 'Send an email to one person, or send yourself a private test. Preview the exact recipient, sender, subject, and message before sending.' : 'Paste or type this week’s message. Preview the roster audience before sending. Each golfer receives a separate email.'}</p>
    {direct ? <p className="closeout-muted">No round or league roster is used. This sends email only, with no app or push notification.</p> : <p className="closeout-muted">Finish sending before closing this round. Closing removes this composer and prevents continuing any remaining emails.</p>}
    <div className="weekly-email-setup">
      <div><strong>Email setup</strong>
        <p>{setup?.message || (phase === 'loading' ? 'Checking email setup…' : 'Email setup has not been confirmed.')}</p>
        {setup && <p className="closeout-muted">This checks service configuration only. Sending-domain verification has not been checked.</p>}
      </div>
      <Button variant="secondary" icon={<RefreshCw size={15}/>} disabled={busy || disabled} onClick={() => checkStatus()}>{locked || statusRequired ? 'Refresh email status' : 'Check email setup'}</Button>
    </div>
    {direct && <EmailSetupGuide setup={setup} senders={senders} locationId={locationId} venueName={venueName} venueSlug={venueSlug} busy={busy || disabled} onRefresh={() => checkStatus()} onCompose={() => recipientInput.current?.focus()}/>}
    {direct && storageWarning && <p className="closeout-warning" role="status">{storageWarning}</p>}
    {error && <p className="closeout-warning" role="alert">{error}</p>}
    {notice && <p className="closeout-notice" role="status">{notice}</p>}
    {busy && <p role="status">{phase === 'sending' ? 'Sending this batch to the email service…' : phase === 'previewing' ? (direct ? 'Saving preview for this one recipient…' : 'Saving preview and confirming this round’s recipients…') : 'Checking email setup and saved progress…'}</p>}

    <label htmlFor="weekly-email-from">From</label>
    {!locked && senders.length > 1
      ? <select id="weekly-email-from" value={senderAuthorized ? senderId : ''} disabled={busy || disabled} onChange={e => { setSenderId(e.target.value); setNotice('') }} aria-describedby="weekly-email-from-note">
        <option value="" disabled>Select an approved sender</option>
        {senders.map(item => <option key={item.id} value={item.id}>{item.from}</option>)}
      </select>
      : <input id="weekly-email-from" type="text" value={displayedSender} placeholder="No approved sender available" readOnly aria-describedby="weekly-email-from-note"/>}
    <p id="weekly-email-from-note" className="closeout-muted">Only senders approved for your account at this venue are available. The sender is fixed once sending starts.</p>
    {!busy && !senderAuthorized && <p className="closeout-warning">{senderId ? 'The saved sender is no longer available to your account at this venue.' : 'No approved sender is selected for your account at this venue.'} {locked ? 'Ask the owner to restore sender access before continuing this saved email.' : senders.length ? 'Choose an approved sender and preview again.' : (direct ? 'Ask the owner to configure sender access.' : 'Ask the owner to configure sender access. Weekly Email is optional.')}</p>}
    {!locked && !senderAuthorized && senders.length === 1 && <Button variant="secondary" disabled={busy || disabled} onClick={() => { setSenderId(senders[0].id); setNotice('') }}>Use {senders[0].from}</Button>}
    {direct && <>
      <label htmlFor="weekly-email-to">To</label>
      <input ref={recipientInput} id="weekly-email-to" type="email" inputMode="email" autoComplete="off" maxLength={254} value={to} placeholder="name@example.com" disabled={busy || disabled || locked} onChange={e => { setTo(e.target.value); setNotice('') }} aria-describedby="weekly-email-to-note"/>
      <p id="weekly-email-to-note" className="closeout-muted">One email address. Enter your own address if you want to test delivery.</p>
      <p className="closeout-muted">Limit: 50 new direct emails per account and venue each UTC day. Continuing a saved send does not use another allowance.</p>
    </>}
    <label htmlFor="weekly-email-subject">Subject</label>
    <input id="weekly-email-subject" type="text" maxLength={200} value={subject} disabled={busy || disabled || locked} onChange={e => { setSubject(e.target.value); setNotice('') }} aria-describedby="weekly-email-subject-count"/>
    <p id="weekly-email-subject-count" className="closeout-muted">{subject.length}/200 characters</p>
    <label htmlFor="weekly-email-body">Message</label>
    <textarea id="weekly-email-body" rows={12} maxLength={20000} value={text} disabled={busy || disabled || locked} onChange={e => { setText(e.target.value); setNotice('') }} aria-describedby="weekly-email-body-note"/>
    <p id="weekly-email-body-note" className="closeout-muted">Plain text · {text.length.toLocaleString()}/20,000 characters. Previewing does not send email.</p>
    {locked && <p className="closeout-muted">Sending has started. The message, sender, and recipient are locked for this saved email.</p>}
    {!locked && <Button disabled={!canPreview} loading={phase === 'previewing'} onClick={preview}>{currentPreview ? (direct ? 'Refresh preview' : 'Refresh preview and audience') : 'Preview email'}</Button>}
    {draft && !currentPreview && <p className="closeout-muted">Your message, sender, or recipient changed. Preview again before sending.</p>}

    {draft && currentPreview && <div className="weekly-email-preview" aria-labelledby="weekly-email-preview-title">
      <h4 id="weekly-email-preview-title">{locked ? 'Email and sending progress' : 'Review before sending'}</h4>
      {direct ? <p><strong>To:</strong> {draft.to} · {draft.recipient_count} recipient</p> : <><p><strong>{draft.recipient_count}</strong> unique recipient address{draft.recipient_count === 1 ? '' : 'es'} confirmed by the server for this round.</p>
      <p className={draft.missing_count ? 'closeout-warning' : 'closeout-muted'}>{draft.missing_count} rostered player{draft.missing_count === 1 ? '' : 's'} without a usable email address{draft.missing_count ? '; they will not receive this email.' : '.'}</p></>}
      <dl className="weekly-email-details"><dt>From</dt><dd>{draft.from}</dd><dt>Subject</dt><dd>{draft.subject}</dd></dl>
      <div className="weekly-email-message">{draft.text}</div>
      {locked && <>
        <dl className="weekly-email-progress" aria-label="Email processing results" aria-live="polite">
          <div><dt>Accepted by email service</dt><dd>{draft.accepted_count}</dd></div>
          <div><dt>Needs review</dt><dd>{draft.review_count}</dd></div>
          <div><dt>Pending or unconfirmed</dt><dd>{draft.pending_count}</dd></div>
        </dl>
        <p className="closeout-muted">Accepted by the email service does not confirm delivery to the inbox.</p>
      </>}
      {draft.message && <p className="closeout-warning" role="alert">{draft.message}</p>}
      {draft.review_count > 0 && <p className="closeout-warning">An earlier attempt for {draft.review_count} recipient{draft.review_count === 1 ? '' : 's'} is too old to retry safely. Ask the owner to check the email service history. These recipients are not automatically retried, to avoid duplicate emails.</p>}
      {!direct && !draft.recipient_count && <p className="closeout-warning">No usable recipient addresses were found. Update the roster’s email addresses and preview again.</p>}
      {draft.pending_count > 0 && <>
        <p className="closeout-muted">{direct ? `Send this exact email to ${draft.to}?` : <>{locked ? 'Continue processes only the remaining recipients in this saved draft.' : `Send this exact message to ${draft.recipient_count} recipient${draft.recipient_count === 1 ? '' : 's'}?`} Up to 10 recipients are processed per batch.</>}</p>
        {!setup?.configured && <p className="closeout-warning">Email service configuration is required before sending.</p>}
        <Button icon={<Mail size={16}/>} disabled={!canSend} loading={phase === 'sending'} onClick={send}>{locked ? 'Continue sending' : direct ? 'Send email' : `Send to ${draft.recipient_count} recipient${draft.recipient_count === 1 ? '' : 's'}`}</Button>
      </>}
      {direct && draft.status === 'accepted' && <Button variant="secondary" disabled={busy || disabled} onClick={newEmail}>New email</Button>}
      {draft.status === 'accepted' && <p className="closeout-notice" role="status">All {draft.accepted_count} email{draft.accepted_count === 1 ? '' : 's'} accepted by the email service.</p>}
    </div>}
  </section>
}

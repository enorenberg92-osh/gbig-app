import React, { useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Button } from '../ui'

export function checkedGoogleURL(value) {
  const url = new URL(value)
  const scopes = new Set((url.searchParams.get('scope') || '').split(/\s+/))
  const allowed = new Set(['openid', 'email', 'https://www.googleapis.com/auth/gmail.send'])
  if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || !scopes.has('https://www.googleapis.com/auth/gmail.send') || [...scopes].some(scope => !allowed.has(scope))) throw new Error('The Gmail connection link could not be verified.')
  return url.href
}

export default function GmailConnections({ gmail, disabled, onBusyChange = () => {} }) {
  const [connecting, setConnecting] = useState('')
  const [error, setError] = useState('')
  async function connect(senderId) {
    if (disabled || connecting || !gmail?.app_configured) return
    setConnecting(senderId)
    onBusyChange(true)
    setError('')
    try {
      const result = await supabase.functions.invoke('gmail-oauth', { body: { sender_id: senderId } })
      if (result.error || !result.data?.url) {
        let detail
        try { detail = await result.error?.context?.json() } catch { /* Use safe fallback. */ }
        throw new Error(detail?.error || result.data?.error || 'Gmail could not be connected. Refresh setup and try again.')
      }
      window.location.assign(checkedGoogleURL(result.data.url))
    } catch (err) {
      setError(err.message)
      setConnecting('')
      onBusyChange(false)
    }
  }
  return <div>
    <p>Connect each approved business Gmail account once. Google asks for permission to send email and confirm the account’s email address. Inbox-reading permission is not requested.</p>
    <p>Connecting opens Google and returns here. Finish connecting before writing your message. Connecting does not send an email or activate a sender.</p>
    {!gmail?.app_configured && <p role="status">The owner needs to finish the one-time Google app setup before Connect Gmail is available.</p>}
    {gmail?.senders?.length > 0 ? <ul>{gmail.senders.map(sender => <li key={sender.id}>
      <strong>{sender.email}</strong> — {sender.connected ? 'Connected' : 'Not connected'}{!sender.enabled && ' · activation pending'}{' '}
      <Button variant="secondary" disabled={disabled || !!connecting || !gmail.app_configured} onClick={() => connect(sender.id)}>{connecting === sender.id ? 'Opening Google…' : sender.connected ? `Reconnect ${sender.email}` : `Connect ${sender.email}`}</Button>
    </li>)}</ul> : <p>The owner must assign an approved sender to your app account first.</p>}
    {error && <p role="alert" className="closeout-warning">{error}</p>}
  </div>
}

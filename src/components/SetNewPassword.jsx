import React, { useState } from 'react'
import { KeyRound, LinkIcon } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useBrand } from '../context/ThemeProvider'
import { Button, Input, Callout } from './ui'
import {
  MIN_PASSWORD_LENGTH, validateNewPassword, updatePasswordErrorMessage, authLinkErrorMessage,
} from '../lib/passwordReset'

/**
 * Full-screen overlay shown after a player follows a password-reset email.
 *
 *   mode="recovery" → new password + confirm → supabase.auth.updateUser
 *   mode="error"    → the link was expired/invalid; offer a fresh one
 *
 * Sits just under the splash (z 9999) so it's already in place when the
 * splash fades, however early the PASSWORD_RECOVERY event fired.
 */
export default function SetNewPassword({ mode, errorCode, hasSession, onDone, onCancel, onRequestNewLink }) {
  const { logoUrl } = useBrand()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm]   = useState('')
  const [saving, setSaving]     = useState(false)
  const [error, setError]       = useState(null)
  // updateUser can report the session gone (link reused in another tab etc.)
  const [expired, setExpired]   = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    const result = validateNewPassword(password, confirm)
    if (result.error) { setError(result.error); return }

    setSaving(true)
    setError(null)
    const { error: authErr } = await supabase.auth.updateUser({ password: result.password })
    setSaving(false)
    if (authErr) {
      const msg = updatePasswordErrorMessage(authErr)
      if (/expired/.test(msg)) { setExpired(true); return }
      setError(msg)
      return
    }
    onDone()
  }

  const showError = mode === 'error' || expired

  return (
    <div style={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="set-pw-title">
      <div style={styles.inner}>
        {logoUrl && <img src={logoUrl} alt="" aria-hidden="true" style={styles.logo} />}

        <div style={styles.card}>
          <div style={styles.iconWrap}>
            {showError ? <LinkIcon size={22} /> : <KeyRound size={22} />}
          </div>

          {showError ? (
            <>
              <h2 id="set-pw-title" style={styles.title}>Reset link didn’t work</h2>
              <Callout tone="warning" style={{ fontSize: 13, lineHeight: 1.45, marginBottom: 18 }}>
                {expired ? authLinkErrorMessage('otp_expired') : authLinkErrorMessage(errorCode)}
              </Callout>
              {hasSession && !expired ? (
                <>
                  <p style={styles.subtitle}>You’re still signed in on this device, so you can keep using the app.</p>
                  <Button size="lg" fullWidth onClick={onCancel}>Continue</Button>
                </>
              ) : (
                <>
                  <Button size="lg" fullWidth onClick={onRequestNewLink}>Send me a new link</Button>
                  <button type="button" style={styles.linkBtn} onClick={onCancel}>Back to sign in</button>
                </>
              )}
            </>
          ) : (
            <>
              <h2 id="set-pw-title" style={styles.title}>Choose a new password</h2>
              <p style={styles.subtitle}>
                You’ll use this with your email to sign in from now on.
              </p>
              <form onSubmit={handleSubmit} style={styles.form}>
                <Input
                  label="New password"
                  type="password"
                  size="lg"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  autoComplete="new-password"
                  helperText={`At least ${MIN_PASSWORD_LENGTH} characters.`}
                  autoFocus
                  required
                />
                <Input
                  label="Confirm new password"
                  type="password"
                  size="lg"
                  value={confirm}
                  onChange={e => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                />
                {error && (
                  <Callout tone="danger" style={{ fontSize: 13, lineHeight: 1.4 }}>{error}</Callout>
                )}
                <Button type="submit" size="lg" fullWidth loading={saving} loadingText="Saving…">
                  Save password
                </Button>
              </form>
              {/* Bail out without changing anything — signs out so a reset link
                  opened on a shared device doesn't leave an account signed in. */}
              <button type="button" style={styles.linkBtn} onClick={onCancel} disabled={saving}>
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 9000,
    overflowY: 'auto',
    background: 'linear-gradient(180deg, var(--green-dark) 0%, var(--green-dark) 220px, var(--off-white) 220px)',
  },
  inner: {
    maxWidth: '480px',
    margin: '0 auto',
    padding: 'calc(40px + env(safe-area-inset-top, 0px)) 20px 40px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
  },
  logo: {
    display: 'block',
    width: 'min(52vw, 220px)',
    height: 'auto',
    marginBottom: '24px',
    filter: 'drop-shadow(0 4px 14px rgba(0,0,0,0.25))',
  },
  card: {
    width: '100%',
    boxSizing: 'border-box',
    background: 'var(--white)',
    borderRadius: 'var(--radius)',
    padding: '28px 24px 20px',
    boxShadow: 'var(--shadow-lg)',
    border: '1px solid var(--gray-200)',
  },
  iconWrap: {
    width: '44px', height: '44px', borderRadius: '50%',
    background: 'var(--green-xlight)', color: 'var(--green-dark)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    margin: '0 auto 12px',
  },
  title:    { fontSize: '20px', fontWeight: 700, color: 'var(--green-dark)', marginBottom: '8px', textAlign: 'center' },
  subtitle: { fontSize: '14px', color: 'var(--gray-600)', textAlign: 'center', lineHeight: 1.5, marginBottom: '20px' },
  form:     { display: 'flex', flexDirection: 'column', gap: '14px' },
  linkBtn: {
    display: 'block',
    margin: '14px auto 0',
    padding: '6px 10px',
    fontSize: '13px',
    fontWeight: 600,
    color: 'var(--gray-600)',
    background: 'none',
    cursor: 'pointer',
  },
}

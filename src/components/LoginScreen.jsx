import React, { useState } from 'react'
import { supabase } from '../lib/supabase'
import { useLocation } from '../context/LocationContext'

export default function LoginScreen() {
  const { appName } = useLocation()
  const [email, setEmail]     = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  async function handleSignIn(e) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const { data, error } = await supabase.auth.signInWithPassword({
      email:    email.trim().toLowerCase(),
      password: password.trim(),
    })

    if (error) {
      setLoading(false)
      setError('Email or password is incorrect. Contact your league admin if you need help.')
      return
    }

    // Link player record to this auth account if not already linked
    if (data?.user) {
      await supabase
        .from('players')
        .update({ user_id: data.user.id })
        .eq('email', email.trim().toLowerCase())
        .is('user_id', null)
        .select()
    }

    // App.jsx auth listener handles the redirect automatically
    setLoading(false)
  }

  return (
    <div style={styles.container}>
      {/* Hero */}
      <div style={styles.hero}>
        <div style={styles.heroLogo}>⛳</div>
        <h1 style={styles.heroTitle}>League Portal</h1>
        <p style={styles.heroSubtitle}>{appName}</p>
      </div>

      {/* Card */}
      <div style={styles.card}>
        <h2 style={styles.title}>Welcome back</h2>
        <p style={styles.subtitle}>Sign in with the email and password your league admin set up for you.</p>

        <form onSubmit={handleSignIn} style={styles.form}>
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Email address</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoFocus
              autoComplete="email"
              style={styles.input}
            />
          </div>
          <div style={styles.fieldGroup}>
            <label style={styles.label}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
              autoComplete="current-password"
              style={styles.input}
            />
          </div>

          {error && (
            <div style={styles.errorBox}>
              <span>⚠️</span><span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            style={{ ...styles.primaryBtn, opacity: loading ? 0.7 : 1 }}
            disabled={loading}
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <div style={styles.helpBox}>
          <p style={styles.helpText}>
            🏌️ <strong>New to the league?</strong> Your admin will set up your account and give you your login details.
          </p>
        </div>
      </div>

      <p style={styles.footer}>{appName} · League Members Only</p>
    </div>
  )
}

const styles = {
  container: {
    minHeight: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '0 20px 40px',
    background: 'linear-gradient(180deg, var(--green-dark) 0%, var(--green-dark) 200px, var(--off-white) 200px)',
  },
  hero:         { paddingTop: '48px', paddingBottom: '28px', textAlign: 'center', width: '100%' },
  heroLogo:     { fontSize: '56px', marginBottom: '10px' },
  heroTitle:    { fontSize: '26px', fontWeight: 800, color: 'var(--white)', letterSpacing: '0.3px' },
  heroSubtitle: { fontSize: '14px', color: 'rgba(255,255,255,0.70)', marginTop: '4px' },

  card: {
    width: '100%',
    background: 'var(--white)',
    borderRadius: 'var(--radius)',
    padding: '28px 24px 24px',
    boxShadow: 'var(--shadow-lg)',
    border: '1px solid var(--gray-200)',
  },
  title:    { fontSize: '20px', fontWeight: 700, color: 'var(--green-dark)', marginBottom: '8px', textAlign: 'center' },
  subtitle: { fontSize: '14px', color: 'var(--gray-600)', textAlign: 'center', lineHeight: 1.5, marginBottom: '24px' },

  form:       { display: 'flex', flexDirection: 'column', gap: '16px' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: '6px' },
  label:      { fontSize: '13px', fontWeight: 600, color: 'var(--gray-800)' },
  input: {
    width: '100%',
    padding: '13px 14px',
    borderRadius: 'var(--radius-sm)',
    border: '1.5px solid var(--gray-200)',
    fontSize: '16px',
    color: 'var(--black)',
    background: 'var(--gray-100)',
    outline: 'none',
    boxSizing: 'border-box',
  },
  errorBox: {
    background: '#fff5f5', border: '1px solid #feb2b2', color: '#c53030',
    padding: '10px 14px', borderRadius: 'var(--radius-sm)', fontSize: '13px',
    display: 'flex', gap: '8px', alignItems: 'flex-start', lineHeight: 1.4,
  },
  primaryBtn: {
    width: '100%',
    padding: '14px',
    background: 'var(--green)',
    color: 'var(--white)',
    borderRadius: 'var(--radius-sm)',
    fontSize: '15px',
    fontWeight: 700,
    letterSpacing: '0.3px',
    boxShadow: '0 2px 8px rgba(45,106,79,0.35)',
    cursor: 'pointer',
  },
  helpBox:  { marginTop: '20px', background: 'var(--green-xlight)', borderRadius: 'var(--radius-sm)', padding: '12px 14px' },
  helpText: { fontSize: '13px', color: 'var(--green-dark)', lineHeight: 1.5, textAlign: 'center' },
  footer:   { marginTop: '24px', fontSize: '12px', color: 'rgba(255,255,255,0.5)', textAlign: 'center' },
}

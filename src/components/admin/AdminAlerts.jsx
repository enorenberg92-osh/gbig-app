import React, { useState, useEffect } from 'react'
import { Megaphone, Inbox } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import { Button, Toast, EmptyState } from '../ui'

const EDGE_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-alert`

function timeAgo(dateStr) {
  const diff  = Date.now() - new Date(dateStr).getTime()
  const mins  = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days  = Math.floor(diff / 86400000)
  if (mins < 1)   return 'Just now'
  if (mins < 60)  return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7)   return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function AdminAlerts() {
  const { locationId, appName } = useLocation()
  const [alerts, setAlerts]       = useState([])
  const [subCount, setSubCount]   = useState(null)
  const [loading, setLoading]     = useState(true)
  const [sending, setSending]     = useState(false)
  const [title, setTitle]         = useState('')
  const [body, setBody]           = useState('')
  const [toast, setToast]         = useState(null)

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }

  const load = async () => {
    const [{ data: alertRows }, { count }] = await Promise.all([
      supabase.from('alerts').select('*').eq('location_id', locationId).order('created_at', { ascending: false }).limit(20),
      supabase.from('push_subscriptions').select('*', { count: 'exact', head: true }).eq('location_id', locationId),
    ])
    setAlerts(alertRows || [])
    setSubCount(count ?? 0)
    setLoading(false)
  }

  useEffect(() => { if (locationId) load() }, [locationId])

  const handleSend = async () => {
    if (!title.trim() || !body.trim()) { showToast('Title and message are both required.', 'error'); return }
    setSending(true)
    try {
      // Forward the caller's access token so the Edge Function can resolve
      // the caller's location from their `location_admins` row.
      const { data: { session } } = await supabase.auth.getSession()
      const accessToken = session?.access_token
      if (!accessToken) throw new Error('You are not signed in.')

      const res = await fetch(EDGE_URL, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ title: title.trim(), body: body.trim(), sentBy: `${appName} Admin` }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Send failed')
      showToast(`Alert sent to ${json.sent} device${json.sent !== 1 ? 's' : ''}!`)
      setTitle('')
      setBody('')
      load()
    } catch (e) {
      showToast(e.message, 'error')
    } finally {
      setSending(false)
    }
  }

  const remaining = 160 - body.length

  return (
    <div style={styles.page}>

      {/* Toast */}
      <Toast toast={toast} />

      {/* ── Compose ────────────────────────────────────────── */}
      <div style={styles.section}>
        <div style={styles.sectionHeader}>
          <h2 style={styles.sectionTitle}>Send an Alert</h2>
          <div style={styles.subBadge}>
            <span style={styles.subDot} />
            <span style={styles.subText}>
              {subCount === null ? '…' : subCount} subscriber{subCount !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        <p style={styles.hint}>
          Push notifications go directly to players' phones — even when the app is closed.
          Use sparingly for things that genuinely matter.
        </p>

        <label style={styles.label}>Title</label>
        <input
          style={styles.input}
          placeholder="e.g. Schedule Change — Week 4"
          value={title}
          onChange={e => setTitle(e.target.value)}
          maxLength={80}
        />

        <label style={styles.label}>Message</label>
        <textarea
          style={styles.textarea}
          placeholder="Keep it short and clear. Players will see this on their lock screen."
          value={body}
          onChange={e => setBody(e.target.value)}
          maxLength={160}
          rows={4}
        />
        <div style={styles.charCount}>
          <span style={{ color: remaining < 20 ? '#c53030' : 'var(--gray-400)' }}>
            {remaining} characters remaining
          </span>
        </div>

        {/* Preview */}
        {(title || body) && (
          <div style={styles.preview}>
            <div style={styles.previewLabel}>Preview</div>
            <div style={styles.previewCard}>
              <div style={styles.previewHeader}>
                <span style={styles.previewIcon}>⛳</span>
                <span style={styles.previewApp}>{appName}</span>
                <span style={styles.previewTime}>now</span>
              </div>
              <p style={styles.previewTitle}>{title || '—'}</p>
              <p style={styles.previewBody}>{body || '—'}</p>
            </div>
          </div>
        )}

        <Button
          variant="primary"
          size="lg"
          fullWidth
          icon={<Megaphone size={16} strokeWidth={2.25} />}
          loading={sending}
          loadingText="Sending…"
          disabled={!title.trim() || !body.trim()}
          onClick={handleSend}
          style={{
            background: 'var(--green-dark)',
            borderColor: 'var(--green-dark)',
            letterSpacing: '0.3px',
            boxShadow: '0 3px 10px rgba(45,106,79,0.3)',
          }}
        >
          Send to {subCount ?? '…'} Subscriber{subCount !== 1 ? 's' : ''}
        </Button>
      </div>

      {/* ── History ────────────────────────────────────────── */}
      <div style={styles.section}>
        <h2 style={styles.sectionTitle}>Sent History</h2>

        {loading && <p style={styles.loadingText}>Loading…</p>}

        {!loading && alerts.length === 0 && (
          <EmptyState
            icon={<Inbox size={36} strokeWidth={1.5} />}
            title="No alerts sent yet"
            description="Your first push notification to players will show up here."
          />
        )}

        <div style={styles.history}>
          {alerts.map(a => (
            <div key={a.id} style={styles.histCard}>
              <div style={styles.histTop}>
                <span style={styles.histTitle}>{a.title}</span>
                <span style={styles.histTime}>{timeAgo(a.created_at)}</span>
              </div>
              <p style={styles.histBody}>{a.body}</p>
            </div>
          ))}
        </div>
      </div>

    </div>
  )
}

const styles = {
  page: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
    paddingBottom: '40px',
  },
  section: {
    background: 'var(--white)',
    borderRadius: 'var(--radius)',
    padding: '16px',
    boxShadow: 'var(--shadow)',
    border: '1px solid var(--gray-200)',
  },
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '10px',
  },
  sectionTitle: {
    fontFamily: "'Playfair Display', Georgia, serif",
    fontSize: '17px',
    fontWeight: 700,
    color: 'var(--black)',
  },
  subBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    background: 'var(--green-xlight)',
    borderRadius: '20px',
    padding: '3px 10px',
  },
  subDot: {
    width: '6px', height: '6px',
    borderRadius: '50%',
    background: 'var(--green)',
    flexShrink: 0,
  },
  subText: { fontSize: '12px', fontWeight: 600, color: 'var(--green-dark)' },
  hint: {
    fontSize: '12px',
    color: 'var(--gray-600)',
    lineHeight: 1.5,
    marginBottom: '14px',
    background: 'var(--gray-100)',
    borderRadius: 'var(--radius-sm)',
    padding: '10px 12px',
    borderLeft: '3px solid #c9a84c',
  },
  label: {
    display: 'block',
    fontSize: '11px',
    fontWeight: 700,
    color: 'var(--green)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: '6px',
    marginTop: '12px',
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 'var(--radius-sm)',
    border: '1.5px solid var(--gray-200)',
    fontSize: '14px',
    background: 'var(--gray-100)',
    outline: 'none',
    fontFamily: 'inherit',
  },
  textarea: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 'var(--radius-sm)',
    border: '1.5px solid var(--gray-200)',
    fontSize: '14px',
    background: 'var(--gray-100)',
    outline: 'none',
    fontFamily: 'inherit',
    resize: 'vertical',
    lineHeight: 1.5,
  },
  charCount: { textAlign: 'right', fontSize: '11px', marginTop: '4px', marginBottom: '12px' },
  // ── Notification preview ──────────────────────────────────────
  preview: { marginBottom: '14px' },
  previewLabel: {
    fontSize: '10px',
    fontWeight: 700,
    color: 'var(--gray-400)',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: '6px',
  },
  previewCard: {
    background: 'var(--gray-100)',
    borderRadius: '12px',
    padding: '10px 12px',
    border: '1px solid var(--gray-200)',
  },
  previewHeader: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' },
  previewIcon: { fontSize: '14px' },
  previewApp: { fontSize: '11px', fontWeight: 600, color: 'var(--gray-600)', flex: 1 },
  previewTime: { fontSize: '11px', color: 'var(--gray-400)' },
  previewTitle: { fontSize: '13px', fontWeight: 700, color: 'var(--black)', lineHeight: 1.3, marginBottom: '2px' },
  previewBody: { fontSize: '12px', color: 'var(--gray-600)', lineHeight: 1.4 },
  // ── History ───────────────────────────────────────────────────
  history: { display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '12px' },
  histCard: {
    borderRadius: 'var(--radius-sm)',
    padding: '12px',
    background: 'var(--off-white)',
    border: '1px solid var(--gray-200)',
  },
  histTop: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' },
  histTitle: { fontSize: '14px', fontWeight: 700, color: 'var(--black)' },
  histTime: { fontSize: '11px', color: 'var(--gray-400)', flexShrink: 0 },
  histBody: { fontSize: '13px', color: 'var(--gray-600)', lineHeight: 1.4 },
  loadingText: { fontSize: '13px', color: 'var(--gray-400)', textAlign: 'center', padding: '20px 0' },
}

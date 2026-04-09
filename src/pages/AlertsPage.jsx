import React, { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw     = atob(base64)
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)))
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins  = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days  = Math.floor(diff / 86400000)
  if (mins < 1)   return 'Just now'
  if (mins < 60)  return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7)   return `${days}d ago`
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export default function AlertsPage({ session }) {
  const [alerts, setAlerts]             = useState([])
  const [loading, setLoading]           = useState(true)
  const [notifStatus, setNotifStatus]   = useState('unknown') // 'unknown'|'unsupported'|'denied'|'prompt'|'subscribed'
  const [subscribing, setSubscribing]   = useState(false)

  // ── Load past alerts ─────────────────────────────────────────
  useEffect(() => {
    supabase
      .from('alerts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data }) => { setAlerts(data || []); setLoading(false) })
  }, [])

  // ── Realtime: new alerts appear instantly ────────────────────
  useEffect(() => {
    const channel = supabase
      .channel('alerts-feed')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alerts' }, payload => {
        setAlerts(prev => [payload.new, ...prev])
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  // ── Check current notification permission state ──────────────
  const checkStatus = useCallback(async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setNotifStatus('unsupported'); return
    }
    const perm = Notification.permission
    if (perm === 'denied')  { setNotifStatus('denied');  return }
    if (perm === 'granted') {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      setNotifStatus(sub ? 'subscribed' : 'prompt')
    } else {
      setNotifStatus('prompt')
    }
  }, [])

  useEffect(() => { checkStatus() }, [checkStatus])

  // ── Subscribe to push ────────────────────────────────────────
  const handleSubscribe = async () => {
    setSubscribing(true)
    try {
      const reg  = await navigator.serviceWorker.ready
      const sub  = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      })
      const json = sub.toJSON()
      await supabase.from('push_subscriptions').upsert({
        endpoint: json.endpoint,
        p256dh:   json.keys.p256dh,
        auth_key: json.keys.auth,
        user_id:  session?.user?.id || null,
      }, { onConflict: 'endpoint' })
      setNotifStatus('subscribed')
    } catch (err) {
      console.error('Push subscribe error:', err)
      if (Notification.permission === 'denied') setNotifStatus('denied')
    } finally {
      setSubscribing(false)
    }
  }

  // ── Unsubscribe ───────────────────────────────────────────────
  const handleUnsubscribe = async () => {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) {
      await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
      await sub.unsubscribe()
    }
    setNotifStatus('prompt')
  }

  return (
    <div style={styles.page}>

      {/* ── Notification opt-in banner ─────────────────────── */}
      {notifStatus === 'prompt' && (
        <div style={styles.optInBanner}>
          <span style={styles.optInIcon}>🔔</span>
          <div style={styles.optInText}>
            <p style={styles.optInTitle}>Get important alerts</p>
            <p style={styles.optInBody}>We'll only notify you when it really matters — closures, schedule changes, or league news.</p>
          </div>
          <button style={styles.optInBtn} onClick={handleSubscribe} disabled={subscribing}>
            {subscribing ? '…' : 'Enable'}
          </button>
        </div>
      )}

      {notifStatus === 'denied' && (
        <div style={{ ...styles.optInBanner, background: '#fff7ed', borderColor: '#fed7aa' }}>
          <span style={styles.optInIcon}>🔕</span>
          <div style={styles.optInText}>
            <p style={{ ...styles.optInTitle, color: '#9a3412' }}>Notifications blocked</p>
            <p style={styles.optInBody}>To receive alerts, enable notifications for this site in your browser settings.</p>
          </div>
        </div>
      )}

      {notifStatus === 'subscribed' && (
        <div style={{ ...styles.optInBanner, background: '#f0fdf4', borderColor: 'var(--green-xlight)' }}>
          <span style={styles.optInIcon}>✅</span>
          <div style={{ ...styles.optInText, flex: 1 }}>
            <p style={{ ...styles.optInTitle, color: 'var(--green-dark)' }}>Notifications on</p>
            <p style={styles.optInBody}>You'll be notified when important alerts are sent.</p>
          </div>
          <button style={styles.muteBtn} onClick={handleUnsubscribe}>Mute</button>
        </div>
      )}

      {/* ── Alerts feed ────────────────────────────────────── */}
      <div style={styles.feedHeader}>
        <h2 style={styles.feedTitle}>Latest Alerts</h2>
        {alerts.length > 0 && <span style={styles.feedCount}>{alerts.length}</span>}
      </div>

      {loading && (
        <div style={styles.empty}>
          <div style={styles.emptyIcon}>⏳</div>
          <p style={styles.emptyText}>Loading…</p>
        </div>
      )}

      {!loading && alerts.length === 0 && (
        <div style={styles.empty}>
          <div style={styles.emptyIcon}>📭</div>
          <p style={styles.emptyText}>No alerts yet</p>
          <p style={styles.emptySubtext}>When important updates are sent, they'll appear here.</p>
        </div>
      )}

      <div style={styles.feed}>
        {alerts.map((a, i) => (
          <div key={a.id} style={{ ...styles.card, ...(i === 0 ? styles.cardFirst : {}) }}>
            <div style={styles.cardTop}>
              <span style={styles.cardDot} />
              <span style={styles.cardTime}>{timeAgo(a.created_at)}</span>
            </div>
            <h3 style={styles.cardTitle}>{a.title}</h3>
            <p style={styles.cardBody}>{a.body}</p>
            {a.sent_by && <p style={styles.cardSentBy}>— {a.sent_by}</p>}
          </div>
        ))}
      </div>

    </div>
  )
}

const styles = {
  page: {
    minHeight: '100%',
    background: 'var(--off-white)',
    paddingBottom: '24px',
  },
  // ── Opt-in banner ─────────────────────────────────────────────
  optInBanner: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    background: '#fefce8',
    border: '1px solid #fde68a',
    borderRadius: '0',
    padding: '14px 16px',
    borderBottom: '1px solid var(--gray-200)',
  },
  optInIcon: { fontSize: '22px', lineHeight: 1, flexShrink: 0, marginTop: '2px' },
  optInText: { flex: 1, display: 'flex', flexDirection: 'column', gap: '3px' },
  optInTitle: {
    fontFamily: "'Playfair Display', Georgia, serif",
    fontSize: '15px',
    fontWeight: 700,
    color: '#92400e',
  },
  optInBody: { fontSize: '12px', color: '#78350f', lineHeight: 1.4 },
  optInBtn: {
    flexShrink: 0,
    background: 'var(--green-dark)',
    color: 'var(--white)',
    borderRadius: '20px',
    padding: '7px 16px',
    fontSize: '13px',
    fontWeight: 700,
    alignSelf: 'center',
  },
  muteBtn: {
    flexShrink: 0,
    background: 'transparent',
    color: 'var(--green)',
    borderRadius: '20px',
    padding: '7px 12px',
    fontSize: '12px',
    fontWeight: 600,
    border: '1px solid var(--green)',
    alignSelf: 'center',
  },
  // ── Feed ─────────────────────────────────────────────────────
  feedHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '18px 16px 10px',
  },
  feedTitle: {
    fontFamily: "'Playfair Display', Georgia, serif",
    fontSize: '20px',
    fontWeight: 700,
    color: 'var(--black)',
  },
  feedCount: {
    background: 'var(--green-dark)',
    color: 'var(--white)',
    fontSize: '11px',
    fontWeight: 700,
    borderRadius: '20px',
    padding: '2px 8px',
    lineHeight: '18px',
  },
  // ── Cards ─────────────────────────────────────────────────────
  feed: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '0 16px' },
  card: {
    background: 'var(--white)',
    borderRadius: 'var(--radius)',
    padding: '14px 16px',
    boxShadow: 'var(--shadow)',
    border: '1px solid var(--gray-200)',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  cardFirst: {
    border: '1.5px solid #c9a84c',
    boxShadow: '0 2px 12px rgba(201,168,76,0.15)',
  },
  cardTop: { display: 'flex', alignItems: 'center', gap: '6px' },
  cardDot: {
    width: '7px', height: '7px',
    borderRadius: '50%',
    background: '#c9a84c',
    flexShrink: 0,
  },
  cardTime: { fontSize: '11px', color: 'var(--gray-400)', fontWeight: 500 },
  cardTitle: {
    fontFamily: "'Playfair Display', Georgia, serif",
    fontSize: '16px',
    fontWeight: 700,
    color: 'var(--black)',
    lineHeight: 1.3,
  },
  cardBody: { fontSize: '14px', color: 'var(--gray-600)', lineHeight: 1.5 },
  cardSentBy: { fontSize: '11px', color: 'var(--gray-400)', fontStyle: 'italic', marginTop: '4px' },
  // ── Empty state ───────────────────────────────────────────────
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '60px 32px',
    gap: '10px',
  },
  emptyIcon: { fontSize: '48px' },
  emptyText: {
    fontFamily: "'Playfair Display', Georgia, serif",
    fontSize: '18px',
    fontWeight: 600,
    color: 'var(--black)',
  },
  emptySubtext: { fontSize: '13px', color: 'var(--gray-400)', textAlign: 'center', lineHeight: 1.5 },
}

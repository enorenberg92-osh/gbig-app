import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useLocation } from '../context/LocationContext'

export default function EventsPage() {
  const { locationId } = useLocation()
  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!locationId) return
    async function fetchEvents() {
      const { data, error } = await supabase
        .from('app_events')
        .select('*')
        .eq('location_id', locationId)
        .order('event_date', { ascending: true })

      if (!error) setEvents(data || [])
      setLoading(false)
    }
    fetchEvents()
  }, [locationId])

  return (
    <div style={styles.container}>
      <div style={styles.pageHeader}>
        <h1 style={styles.pageTitle}>Events</h1>
        <p style={styles.pageSubtitle}>Tournaments & special events</p>
      </div>

      {loading ? (
        <div style={styles.loading}>Loading events…</div>
      ) : events.length === 0 ? (
        <div style={styles.empty}>
          <span style={styles.emptyIcon}>🏌️</span>
          <p>No upcoming events yet.</p>
          <p style={styles.emptyHint}>Check back soon!</p>
        </div>
      ) : (
        <div style={styles.list}>
          {events.map(event => (
            <div key={event.id} style={styles.card}>
              <div style={styles.cardDate}>
                {new Date(event.event_date).toLocaleDateString('en-US', {
                  month: 'short', day: 'numeric'
                })}
              </div>
              <div style={styles.cardInfo}>
                <div style={styles.cardTitle}>{event.title}</div>
                {event.description && (
                  <div style={styles.cardDesc}>{event.description}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const styles = {
  container: { padding: '0 0 24px' },
  pageHeader: {
    padding: '20px 20px 16px',
    borderBottom: '1px solid var(--gray-200)',
  },
  pageTitle: { fontSize: '22px', fontWeight: 700, color: 'var(--green-dark)' },
  pageSubtitle: { fontSize: '13px', color: 'var(--gray-600)', marginTop: '2px' },
  loading: { padding: '40px', textAlign: 'center', color: 'var(--gray-400)' },
  empty: {
    padding: '60px 20px',
    textAlign: 'center',
    color: 'var(--gray-600)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '8px',
  },
  emptyIcon: { fontSize: '40px' },
  emptyHint: { fontSize: '13px', color: 'var(--gray-400)' },
  list: { padding: '16px 16px 0' },
  card: {
    display: 'flex',
    gap: '14px',
    padding: '14px 16px',
    background: 'var(--white)',
    borderRadius: 'var(--radius)',
    marginBottom: '10px',
    boxShadow: 'var(--shadow)',
    border: '1px solid var(--gray-200)',
    alignItems: 'flex-start',
  },
  cardDate: {
    background: 'var(--green)',
    color: 'var(--white)',
    borderRadius: '8px',
    padding: '6px 10px',
    fontSize: '12px',
    fontWeight: 700,
    minWidth: '48px',
    textAlign: 'center',
    flexShrink: 0,
  },
  cardInfo: { flex: 1 },
  cardTitle: { fontSize: '15px', fontWeight: 600, color: 'var(--black)' },
  cardDesc: { fontSize: '13px', color: 'var(--gray-600)', marginTop: '4px' },
}

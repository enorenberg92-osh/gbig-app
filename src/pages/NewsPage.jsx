import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useLocation } from '../context/LocationContext'

export default function NewsPage() {
  const { locationId } = useLocation()
  const [posts, setPosts] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!locationId) return
    async function fetchNews() {
      const { data, error } = await supabase
        .from('news_posts')
        .select('*')
        .eq('location_id', locationId)
        .order('created_at', { ascending: false })

      if (!error) setPosts(data || [])
      setLoading(false)
    }
    fetchNews()
  }, [locationId])

  return (
    <div style={styles.container}>
      <div style={styles.pageHeader}>
        <h1 style={styles.pageTitle}>News</h1>
        <p style={styles.pageSubtitle}>Updates from the range</p>
      </div>

      {loading ? (
        <div style={styles.loading}>Loading news…</div>
      ) : posts.length === 0 ? (
        <div style={styles.empty}>
          <span style={styles.emptyIcon}>📰</span>
          <p>No news posts yet.</p>
        </div>
      ) : (
        <div style={styles.list}>
          {posts.map(post => (
            <div key={post.id} style={styles.card}>
              <div style={styles.cardMeta}>
                {new Date(post.created_at).toLocaleDateString('en-US', {
                  month: 'long', day: 'numeric', year: 'numeric'
                })}
              </div>
              <h2 style={styles.cardTitle}>{post.title}</h2>
              {post.body && <p style={styles.cardBody}>{post.body}</p>}
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
  list: { padding: '16px 16px 0' },
  card: {
    background: 'var(--white)',
    borderRadius: 'var(--radius)',
    padding: '16px',
    marginBottom: '12px',
    boxShadow: 'var(--shadow)',
    border: '1px solid var(--gray-200)',
  },
  cardMeta: { fontSize: '11px', color: 'var(--gray-400)', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.5px' },
  cardTitle: { fontSize: '16px', fontWeight: 700, color: 'var(--green-dark)', marginBottom: '8px' },
  cardBody: { fontSize: '14px', color: 'var(--gray-600)', lineHeight: 1.6 },
}

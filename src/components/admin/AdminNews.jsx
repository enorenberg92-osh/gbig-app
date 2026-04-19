import React, { useState, useEffect } from 'react'
import { Plus, X, FileText } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { useLocation } from '../../context/LocationContext'
import { Button, Toast, EmptyState } from '../ui'
import ConfirmDialog from '../ConfirmDialog'

const EMPTY_FORM = { title: '', body: '' }

export default function AdminNews() {
  const { locationId } = useLocation()
  const [posts, setPosts] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)
  const [dialog, setDialog] = useState(null)

  useEffect(() => { if (locationId) load() }, [locationId])

  async function load() {
    const { data } = await supabase
      .from('news_posts')
      .select('*')
      .eq('location_id', locationId)
      .order('created_at', { ascending: false })
    setPosts(data || [])
    setLoading(false)
  }

  function showToast(msg, type = 'success') {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3000)
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)

    const payload = {
      title: form.title.trim(),
      body: form.body.trim(),
    }

    let error
    if (editing) {
      ;({ error } = await supabase.from('news_posts').update(payload).eq('id', editing.id))
    } else {
      ;({ error } = await supabase.from('news_posts').insert({ ...payload, location_id: locationId }))
    }

    setSaving(false)
    if (error) {
      showToast('Error: ' + error.message, 'error')
    } else {
      showToast(editing ? 'Post updated!' : 'Post published!')
      setShowForm(false)
      setEditing(null)
      setForm(EMPTY_FORM)
      load()
    }
  }

  function handleDelete(post) {
    setDialog({
      message: `Delete "${post.title}"?`,
      confirmLabel: 'Delete',
      onConfirm: async () => {
        const { error } = await supabase.from('news_posts').delete().eq('id', post.id)
        if (error) {
          showToast('Error: ' + error.message, 'error')
        } else {
          showToast('Post deleted.')
          load()
        }
      },
    })
  }

  function startEdit(post) {
    setForm({ title: post.title || '', body: post.body || '' })
    setEditing(post)
    setShowForm(true)
  }

  if (loading) return <div style={styles.loading}>Loading…</div>

  return (
    <div style={styles.container}>
      {dialog && (
        <ConfirmDialog
          {...dialog}
          onConfirm={() => { dialog.onConfirm(); setDialog(null) }}
          onCancel={() => setDialog(null)}
        />
      )}
      <Toast toast={toast} />

      <Button
        variant="primary"
        size="lg"
        fullWidth
        icon={<Plus size={16} strokeWidth={2.5} />}
        onClick={() => { setShowForm(true); setEditing(null); setForm(EMPTY_FORM) }}
        style={{
          fontSize: '15px',
          boxShadow: '0 2px 8px rgba(45,106,79,0.3)',
        }}
      >
        Write New Post
      </Button>

      {showForm && (
        <div style={styles.card}>
          <h3 style={styles.cardTitle}>{editing ? 'Edit Post' : 'New Post'}</h3>
          <form onSubmit={handleSave} style={styles.form}>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Title *</label>
              <input
                style={styles.input}
                value={form.title}
                onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
                placeholder="e.g. Week 3 Results Are In!"
                required
              />
            </div>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Body *</label>
              <textarea
                style={styles.textarea}
                value={form.body}
                onChange={e => setForm(f => ({ ...f, body: e.target.value }))}
                placeholder="Write your update here…"
                rows={6}
                required
              />
            </div>
            <div style={styles.formActions}>
              <Button
                type="submit"
                variant="primary"
                loading={saving}
                loadingText="Publishing…"
                style={{ flex: 1 }}
              >
                {editing ? 'Update Post' : 'Publish Post'}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => { setShowForm(false); setEditing(null) }}
                style={{ flex: 1 }}
              >
                Cancel
              </Button>
            </div>
          </form>
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.cardTitleRow}>
          <h3 style={styles.cardTitle}>Published Posts</h3>
          <span style={styles.count}>{posts.length}</span>
        </div>
        {posts.length === 0 ? (
          <EmptyState
            icon={<FileText size={36} strokeWidth={1.5} />}
            title="No posts yet"
            description="Share updates, week recaps, or league announcements with your players."
          />
        ) : (
          posts.map(post => (
            <div key={post.id} style={styles.postRow}>
              <div style={styles.postInfo}>
                <div style={styles.postTitle}>{post.title}</div>
                <div style={styles.postDate}>
                  {new Date(post.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
                {post.body && (
                  <div style={styles.postPreview}>
                    {post.body.length > 80 ? post.body.slice(0, 80) + '…' : post.body}
                  </div>
                )}
              </div>
              <div style={styles.postActions}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => startEdit(post)}
                  style={{
                    background: 'var(--green-xlight)',
                    borderColor: 'var(--green-xlight)',
                    color: 'var(--green)',
                    padding: '4px 10px',
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  icon={<X size={13} strokeWidth={2.5} />}
                  onClick={() => handleDelete(post)}
                  style={{ padding: '4px 8px' }}
                />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

const styles = {
  container: { padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' },
  loading: { padding: '40px', textAlign: 'center', color: 'var(--gray-400)' },
  card: { background: 'var(--white)', borderRadius: 'var(--radius)', padding: '16px', boxShadow: 'var(--shadow)', border: '1px solid var(--gray-200)' },
  cardTitleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' },
  cardTitle: { fontSize: '14px', fontWeight: 700, color: 'var(--green-dark)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  count: { fontSize: '13px', fontWeight: 700, color: 'var(--green)', background: 'var(--green-xlight)', padding: '2px 10px', borderRadius: '20px' },
  form: { display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '12px' },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: '5px' },
  label: { fontSize: '11px', fontWeight: 600, color: 'var(--gray-600)', textTransform: 'uppercase', letterSpacing: '0.4px' },
  input: { padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--gray-100)', color: 'var(--black)' },
  textarea: { padding: '10px 12px', borderRadius: 'var(--radius-sm)', border: '1.5px solid var(--gray-200)', fontSize: '14px', background: 'var(--gray-100)', color: 'var(--black)', resize: 'vertical', lineHeight: 1.5 },
  formActions: { display: 'flex', gap: '10px' },
  postRow: { display: 'flex', gap: '12px', padding: '12px 0', borderBottom: '1px solid var(--gray-100)', alignItems: 'flex-start' },
  postInfo: { flex: 1, minWidth: 0 },
  postTitle: { fontSize: '14px', fontWeight: 600, color: 'var(--black)' },
  postDate: { fontSize: '11px', color: 'var(--gray-400)', marginTop: '2px' },
  postPreview: { fontSize: '12px', color: 'var(--gray-600)', marginTop: '4px', lineHeight: 1.4 },
  postActions: { display: 'flex', gap: '6px', flexShrink: 0 },
}

import React, { useState, useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { Shield, Plus, MapPin, Users, UserCog, Clock } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useIsSuperAdmin } from '../hooks/useIsSuperAdmin'
import { Button, Card, PageHeader, EmptyState, Input } from '../components/ui'

const FEATURE_KEYS = ['friends', 'events', 'skins', 'subs', 'news']

/**
 * SuperAdminPage — ecosystem-wide operations console.
 *
 * Gated behind useIsSuperAdmin. Non-super-admins are bounced to /. The whole
 * console is cross-location: a super-admin signed into any GBIG-ecosystem
 * deployment (greenbayindoorgolf.com, <next>.com, …) can reach /super-admin
 * from that domain and operate on every location from one place.
 *
 * Phase 1 ships only the read-only dashboard. Create-location, invite-admin,
 * and edit-branding routes are stubbed to redirect back to the dashboard
 * until Phase 2 lights them up.
 */
export default function SuperAdminPage({ session }) {
  const { isSuperAdmin, checking } = useIsSuperAdmin(session)

  // Not signed in → dashboard route will handle this via LoginScreen bounce,
  // but /super-admin specifically should always require auth.
  if (!session) return <Navigate to="/" replace />

  // Wait for the role check to resolve before deciding so we don't flash a
  // redirect at super-admins who are still loading.
  if (checking) return null
  if (!isSuperAdmin) return <Navigate to="/" replace />

  return (
    <Routes>
      <Route index element={<LocationsDashboard session={session} />} />
      <Route path="locations/new" element={<CreateLocation />} />
      <Route path="locations/:id" element={<LocationEditor />} />
      <Route path="*" element={<Navigate to="/super-admin" replace />} />
    </Routes>
  )
}


// ─── Dashboard: all locations with counts ────────────────────────────────────
function LocationsDashboard({ session }) {
  const navigate = useNavigate()
  const [locations, setLocations] = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    setError(null)

    const { data: locs, error: locErr } = await supabase
      .from('locations')
      .select('id, name, slug, app_name, primary_color, logo_icon_url, timezone, created_at')
      .order('created_at', { ascending: true })

    if (locErr) {
      setError(locErr.message)
      setLoading(false)
      return
    }

    // Per-location counts. Head-only count queries are cheap; N+1 is fine
    // while locations count is in the low single digits. Swap to a single
    // `locations_with_counts` view if this ever fans out past ~20.
    const enriched = await Promise.all((locs || []).map(async loc => {
      const [{ count: playerCount }, { count: adminCount }] = await Promise.all([
        supabase.from('players')
          .select('*', { count: 'exact', head: true })
          .eq('location_id', loc.id),
        supabase.from('location_admins')
          .select('*', { count: 'exact', head: true })
          .eq('location_id', loc.id),
      ])
      return { ...loc, playerCount: playerCount ?? 0, adminCount: adminCount ?? 0 }
    }))

    setLocations(enriched)
    setLoading(false)
  }

  return (
    <div style={styles.page}>
      <PageHeader
        title="Super Admin"
        subtitle="Ecosystem operations across every GBIG location"
        icon={<Shield size={22} color="var(--green)" />}
        actions={
          <Button
            variant="primary"
            icon={<Plus size={16} />}
            onClick={() => navigate('/super-admin/locations/new')}
          >
            New Location
          </Button>
        }
      />

      {loading && (
        <Card>
          <div style={styles.loadingRow}>Loading locations…</div>
        </Card>
      )}

      {error && (
        <Card>
          <div style={styles.errorRow}>Could not load locations: {error}</div>
        </Card>
      )}

      {!loading && !error && locations.length === 0 && (
        <EmptyState
          icon={<MapPin size={36} color="var(--gray-400)" />}
          title="No locations yet"
          description="Create the first location to start onboarding members."
        />
      )}

      {!loading && !error && locations.length > 0 && (
        <div style={styles.grid}>
          {locations.map(loc => (
            <LocationCard
              key={loc.id}
              loc={loc}
              onOpen={() => navigate(`/super-admin/locations/${loc.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  )
}


// ─── One location's summary card ─────────────────────────────────────────────
function LocationCard({ loc, onOpen }) {
  const color = loc.primary_color || 'var(--green)'

  return (
    <Card
      padding="md"
      style={styles.card}
    >
      <div style={styles.cardTop}>
        <div style={{ ...styles.swatch, background: color }}>
          {loc.logo_icon_url ? (
            <img src={loc.logo_icon_url} alt="" style={styles.swatchLogo} />
          ) : (
            <MapPin size={22} color="#fff" />
          )}
        </div>
        <div style={styles.cardTitleBlock}>
          <div style={styles.cardTitle}>{loc.name}</div>
          <div style={styles.cardSlug}>{loc.slug}</div>
        </div>
      </div>

      <div style={styles.statsRow}>
        <Stat icon={<Users size={14} />}    label="Players" value={loc.playerCount} />
        <Stat icon={<UserCog size={14} />}  label="Admins"  value={loc.adminCount} />
        <Stat icon={<Clock size={14} />}    label="Zone"    value={loc.timezone || '—'} mono />
      </div>

      <div style={styles.cardFoot}>
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpen}
        >
          Open →
        </Button>
      </div>
    </Card>
  )
}

function CreateLocation() {
  const navigate = useNavigate()
  const [form, setForm] = useState({ name: '', slug: '', primary_color: '#10B981', timezone: 'America/Chicago' })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  async function submit(event) {
    event.preventDefault(); setSaving(true); setError('')
    const { data, error: rpcError } = await supabase.rpc('super_admin_create_location', {
      p_name: form.name, p_slug: form.slug, p_primary_color: form.primary_color, p_timezone: form.timezone,
    })
    setSaving(false)
    if (rpcError) setError(rpcError.message)
    else navigate(`/super-admin/locations/${data.id}`)
  }
  return <div style={styles.page}>
    <PageHeader title="New Location" subtitle="Create a tenant and public boot identity" />
    <Card><form onSubmit={submit} style={styles.form}>
      <Input label="Name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
      <Input label="Slug" value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value.toLowerCase() })} placeholder="green-bay" required />
      <Input label="Primary color" type="color" value={form.primary_color} onChange={e => setForm({ ...form, primary_color: e.target.value })} />
      <Input label="Timezone" value={form.timezone} onChange={e => setForm({ ...form, timezone: e.target.value })} required />
      {error && <div style={styles.errorRow}>{error}</div>}
      <div style={styles.actions}><Button type="submit" loading={saving}>Create Location</Button><Button type="button" variant="secondary" onClick={() => navigate('/super-admin')}>Cancel</Button></div>
    </form></Card>
  </div>
}

function LocationEditor() {
  const id = window.location.pathname.split('/').pop()
  const navigate = useNavigate()
  const [form, setForm] = useState(null)
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { supabase.from('locations').select('*').eq('id', id).single().then(({ data, error }) => { setForm(data); if (error) setError(error.message) }) }, [id])
  if (!form) return <div style={styles.page}>{error || 'Loading…'}</div>
  async function save(event) {
    event.preventDefault(); setError(''); setMessage('')
    const { data, error: rpcError } = await supabase.rpc('super_admin_update_location', { p_location_id: id, p_payload: form })
    if (rpcError) setError(rpcError.message); else { setForm(data); setMessage('Location updated.') }
  }
  async function invite(event) {
    event.preventDefault(); setError(''); setMessage('')
    const { error: rpcError } = await supabase.rpc('super_admin_invite_location_admin', { p_location_id: id, p_email: email })
    if (rpcError) setError(rpcError.message); else { setEmail(''); setMessage('Admin access added.') }
  }
  return <div style={styles.page}>
    <PageHeader title={form.name} subtitle={form.slug} actions={<Button variant="secondary" onClick={() => navigate('/super-admin')}>Back</Button>} />
    <Card><form onSubmit={save} style={styles.form}>
      <Input label="Name" value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} />
      <Input label="Primary color" type="color" value={form.primary_color || '#10B981'} onChange={e => setForm({ ...form, primary_color: e.target.value })} />
      <Input label="Full logo URL" value={form.logo_url || ''} onChange={e => setForm({ ...form, logo_url: e.target.value })} />
      <Input label="Icon logo URL" value={form.logo_icon_url || ''} onChange={e => setForm({ ...form, logo_icon_url: e.target.value })} />
      <Input label="Timezone" value={form.timezone || ''} onChange={e => setForm({ ...form, timezone: e.target.value })} />
      <div style={styles.featureGrid}>{FEATURE_KEYS.map(key => {
        const enabled = form.features?.[key] !== false
        return <button key={key} type="button" style={styles.featureButton} onClick={() => setForm({ ...form, features: { ...(form.features || {}), [key]: !enabled } })}>{key}: {enabled ? 'On' : 'Off'}</button>
      })}</div>
      <Button type="submit">Save Branding & Features</Button>
    </form></Card>
    <Card><form onSubmit={invite} style={styles.form}>
      <strong>Invite location admin</strong>
      <Input label="Existing auth user email" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
      <div style={styles.help}>If no auth user exists, ask the person to create or sign in to an account first, then retry.</div>
      <Button type="submit">Add Admin</Button>
    </form></Card>
    {message && <div style={styles.successRow}>{message}</div>}{error && <div style={styles.errorRow}>{error}</div>}
  </div>
}


function Stat({ icon, label, value, mono = false }) {
  return (
    <div style={styles.stat}>
      <span style={styles.statIcon}>{icon}</span>
      <div style={styles.statText}>
        <div style={styles.statLabel}>{label}</div>
        <div style={{ ...styles.statValue, fontFamily: mono ? 'ui-monospace, Menlo, monospace' : undefined }}>
          {value}
        </div>
      </div>
    </div>
  )
}


const styles = {
  page: {
    display:        'flex',
    flexDirection:  'column',
    gap:            16,
    padding:        16,
    maxWidth:       '100%',
  },
  loadingRow: {
    fontSize: 14,
    color:    'var(--gray-500)',
    padding:  '20px 0',
    textAlign:'center',
  },
  errorRow: {
    fontSize: 14,
    color:    'var(--danger, #b42318)',
    padding:  '20px 0',
  },
  grid: {
    display:       'flex',
    flexDirection: 'column',
    gap:           12,
  },
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  actions: { display: 'flex', gap: 10 },
  help: { fontSize: 12, color: 'var(--gray-500)' },
  successRow: { color: 'var(--green-dark)', fontWeight: 700 },
  featureGrid: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  featureButton: { padding: '8px 12px', border: '1px solid var(--gray-200)', borderRadius: 8, background: 'var(--green-xlight)', textTransform: 'capitalize' },

  card: {
    display:        'flex',
    flexDirection:  'column',
    gap:            12,
  },
  cardTop: {
    display:    'flex',
    alignItems: 'center',
    gap:        12,
  },
  swatch: {
    width:         44,
    height:        44,
    borderRadius:  10,
    display:       'flex',
    alignItems:    'center',
    justifyContent:'center',
    flexShrink:    0,
    boxShadow:     '0 1px 3px rgba(0,0,0,0.15)',
  },
  swatchLogo: {
    width:      28,
    height:     28,
    objectFit:  'contain',
  },
  cardTitleBlock: {
    display:        'flex',
    flexDirection:  'column',
    gap:            2,
    minWidth:       0,
  },
  cardTitle: {
    fontSize:   16,
    fontWeight: 700,
    color:      'var(--black)',
    lineHeight: 1.2,
  },
  cardSlug: {
    fontSize:   12,
    fontWeight: 500,
    color:      'var(--gray-500)',
    fontFamily: 'ui-monospace, Menlo, monospace',
  },

  statsRow: {
    display:     'flex',
    gap:         12,
    flexWrap:    'wrap',
    borderTop:   '1px solid var(--gray-200)',
    paddingTop:  12,
  },
  stat: {
    display:    'flex',
    alignItems: 'center',
    gap:        8,
    flex:       '1 1 auto',
    minWidth:   90,
  },
  statIcon: {
    color:      'var(--gray-500)',
    display:    'flex',
    alignItems: 'center',
  },
  statText: {
    display:       'flex',
    flexDirection: 'column',
  },
  statLabel: {
    fontSize:     10,
    fontWeight:   600,
    color:        'var(--gray-500)',
    textTransform:'uppercase',
    letterSpacing:'0.4px',
  },
  statValue: {
    fontSize:   14,
    fontWeight: 700,
    color:      'var(--black)',
    lineHeight: 1.2,
  },

  cardFoot: {
    display:        'flex',
    justifyContent: 'flex-end',
  },
}

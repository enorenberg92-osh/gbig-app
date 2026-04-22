import React, { useState, useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { Shield, Plus, MapPin, Users, UserCog, Clock } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useIsSuperAdmin } from '../hooks/useIsSuperAdmin'
import { Button, Card, PageHeader, EmptyState } from '../components/ui'

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
      {/* Phase-2 routes will live here: /locations/new, /locations/:id */}
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
            disabled
            title="Coming in the next session"
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
          description="Create the first location to start onboarding members. (Coming in the next session.)"
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
          disabled
          title="Coming in the next session"
        >
          Open →
        </Button>
      </div>
    </Card>
  )
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

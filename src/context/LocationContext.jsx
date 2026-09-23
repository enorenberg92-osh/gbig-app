import React, { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const LocationContext = createContext(null)

/**
 * Provides locationId and appName to the entire component tree.
 * Values come from build-time env vars so each deployment is
 * independently configured with no runtime overhead.
 */
// Cache the resolved location per hostname so every boot after the first
// paints the right brand immediately — no other tenant's logo ever flashes.
const CACHE_KEY = `loc:${window.location.hostname.toLowerCase()}`

function readCachedLocation() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function LocationProvider({ children }) {
  const fallbackId = import.meta.env.VITE_LOCATION_ID
  const [resolved, setResolved] = useState(readCachedLocation)
  // True when the host's slug lookup failed (network) and nothing is cached:
  // we can't tell which location this is, so ask the user to retry rather
  // than boot the env fallback (GBIG) under another location's hostname.
  const [lookupFailed, setLookupFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [retrying, setRetrying] = useState(false)
  const locationId = resolved?.id || fallbackId
  const appName     = resolved?.name || import.meta.env.VITE_APP_NAME || 'Golf League App'
  const appFullName = resolved?.name || import.meta.env.VITE_APP_FULL_NAME || appName
  const timezone = resolved?.timezone || 'America/Chicago'

  useEffect(() => {
    let cancelled = false
    async function resolveLocation() {
      const hostname = window.location.hostname.toLowerCase()
      // Hostname's first label is the location slug. Vercel project names end
      // in "-app" (gbig-app, appleton-app) — strip that suffix so the same
      // rule covers both *.vercel.app aliases and future <slug>.domain hosts.
      const slug = hostname.split('.')[0].replace(/-app$/, '')
      const useSlug = !import.meta.env.DEV && slug && slug !== 'www' && slug !== 'localhost'
      let data = null
      if (useSlug) {
        // A transient fetch failure must not silently boot a DIFFERENT
        // location (the env fallback is GBIG). Retry the slug lookup; only a
        // definitive "no such slug" falls through to the fallback.
        let succeeded = false
        for (let i = 0; i < 3; i++) {
          const result = await supabase.from('location_public').select('*').eq('slug', slug).maybeSingle()
          if (!result.error) { data = result.data; succeeded = true; break }
          await new Promise(r => setTimeout(r, 400 * (i + 1)))
        }
        if (cancelled) return
        if (!succeeded) {
          // Keep the cached location for this host if we have one; otherwise
          // surface the retry state.
          const cached = readCachedLocation()
          if (cached?.id) setResolved(cached)
          else setLookupFailed(true)
          setRetrying(false)
          return
        }
      }
      if (!data && fallbackId) {
        const result = await supabase.from('location_public').select('*').eq('id', fallbackId).maybeSingle()
        data = result.data
      }
      if (!cancelled) {
        setLookupFailed(false)
        setResolved(data || (fallbackId ? { id: fallbackId } : {}))
        // Only cache a row that belongs to this host — never the fallback
        // under another location's hostname.
        if (data?.id && (!useSlug || data.slug === slug)) {
          try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)) } catch { /* private mode */ }
        }
      }
    }
    resolveLocation()
    return () => { cancelled = true }
  }, [fallbackId, attempt])

  /* Location data is cached in this context after the single public boot lookup. */
  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!locationId || resolved) return undefined
    let cancelled = false
    supabase.from('location_public').select('*').eq('id', locationId).maybeSingle().then(({ data }) => {
      if (!cancelled && data) setResolved(data)
    })
    return () => { cancelled = true }
  }, [locationId])

  if (!locationId) {
    console.error(
      '[LocationContext] VITE_LOCATION_ID is not set in .env.local. ' +
      'Run the SQL migration, copy the locations UUID, and add it to .env.local.'
    )
  }

  if (lookupFailed) {
    return (
      <div style={retryStyles.screen}>
        <p style={retryStyles.title}>Can't reach the server</p>
        <p style={retryStyles.body}>Check your connection and try again.</p>
        <button
          style={retryStyles.btn}
          disabled={retrying}
          onClick={() => { setRetrying(true); setAttempt(a => a + 1) }}
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    )
  }

  return (
    <LocationContext.Provider value={{ locationId, appName, appFullName, timezone, location: resolved }}>
      {children}
    </LocationContext.Provider>
  )
}

const retryStyles = {
  screen: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
    padding: '32px',
    textAlign: 'center',
    background: 'var(--off-white)',
  },
  title: { fontSize: '17px', fontWeight: 700, color: 'var(--black)' },
  body:  { fontSize: '13px', color: 'var(--gray-500)' },
  btn: {
    marginTop: '6px',
    background: 'var(--green-dark)',
    color: 'var(--white)',
    borderRadius: '20px',
    padding: '9px 22px',
    fontSize: '14px',
    fontWeight: 700,
  },
}

/** Use inside any component: const { locationId, appName, appFullName } = useLocation() */
export function useLocation() {
  const ctx = useContext(LocationContext)
  if (!ctx) throw new Error('useLocation must be used inside <LocationProvider>')
  return ctx
}

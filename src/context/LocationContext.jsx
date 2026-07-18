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
      let data = null
      if (!import.meta.env.DEV && slug && slug !== 'www' && slug !== 'localhost') {
        // A transient fetch failure must not silently boot a DIFFERENT
        // location (the env fallback is GBIG). Retry the slug lookup; only a
        // definitive "no such slug" falls through to the fallback.
        for (let attempt = 0; attempt < 3; attempt++) {
          const result = await supabase.from('location_public').select('*').eq('slug', slug).maybeSingle()
          if (!result.error) { data = result.data; break }
          await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
        }
      }
      if (!data && fallbackId) {
        const result = await supabase.from('location_public').select('*').eq('id', fallbackId).maybeSingle()
        data = result.data
      }
      if (!cancelled) {
        setResolved(data || (fallbackId ? { id: fallbackId } : {}))
        if (data?.id) {
          try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)) } catch { /* private mode */ }
        }
      }
    }
    resolveLocation()
    return () => { cancelled = true }
  }, [fallbackId])

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

  return (
    <LocationContext.Provider value={{ locationId, appName, appFullName, timezone, location: resolved }}>
      {children}
    </LocationContext.Provider>
  )
}

/** Use inside any component: const { locationId, appName, appFullName } = useLocation() */
export function useLocation() {
  const ctx = useContext(LocationContext)
  if (!ctx) throw new Error('useLocation must be used inside <LocationProvider>')
  return ctx
}

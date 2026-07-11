import React, { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

const LocationContext = createContext(null)

/**
 * Provides locationId and appName to the entire component tree.
 * Values come from build-time env vars so each deployment is
 * independently configured with no runtime overhead.
 */
export function LocationProvider({ children }) {
  const locationId  = import.meta.env.VITE_LOCATION_ID
  const appName     = import.meta.env.VITE_APP_NAME     || 'Golf League App'
  // Full display name for the splash screen (defaults to appName if not set)
  const appFullName = import.meta.env.VITE_APP_FULL_NAME || appName
  const [timezone, setTimezone] = useState('America/Chicago')

  useEffect(() => {
    if (!locationId) return undefined
    let cancelled = false

    async function loadTimezone() {
      const { data } = await supabase
        .from('locations')
        .select('timezone')
        .eq('id', locationId)
        .maybeSingle()
      if (!cancelled && data?.timezone) setTimezone(data.timezone)
    }

    loadTimezone()
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => loadTimezone())
    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [locationId])

  if (!locationId) {
    console.error(
      '[LocationContext] VITE_LOCATION_ID is not set in .env.local. ' +
      'Run the SQL migration, copy the locations UUID, and add it to .env.local.'
    )
  }

  return (
    <LocationContext.Provider value={{ locationId, appName, appFullName, timezone }}>
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

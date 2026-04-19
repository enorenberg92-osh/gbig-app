import React, { createContext, useContext } from 'react'

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

  if (!locationId) {
    console.error(
      '[LocationContext] VITE_LOCATION_ID is not set in .env.local. ' +
      'Run the SQL migration, copy the locations UUID, and add it to .env.local.'
    )
  }

  return (
    <LocationContext.Provider value={{ locationId, appName, appFullName }}>
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

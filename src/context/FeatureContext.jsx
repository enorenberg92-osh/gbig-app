import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useLocation } from './LocationContext'

const FeatureContext = createContext({ isEnabled: () => true, loading: true })

export function FeatureProvider({ children }) {
  const { locationId } = useLocation()
  const [locationFlags, setLocationFlags] = useState({})
  const [leagueFlags, setLeagueFlags] = useState({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    if (!locationId) { setLoading(false); return undefined }
    setLoading(true)
    Promise.all([
      supabase.from('locations').select('features').eq('id', locationId).maybeSingle(),
      supabase.from('league_config').select('features').eq('location_id', locationId).eq('is_working', true).maybeSingle(),
    ]).then(([locationResult, leagueResult]) => {
      if (cancelled) return
      setLocationFlags(locationResult.data?.features || {})
      setLeagueFlags(leagueResult.data?.features || {})
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [locationId])

  const value = useMemo(() => ({
    loading,
    isEnabled(key) {
      if (Object.prototype.hasOwnProperty.call(leagueFlags, key)) return leagueFlags[key] !== false
      if (Object.prototype.hasOwnProperty.call(locationFlags, key)) return locationFlags[key] !== false
      return true
    },
  }), [leagueFlags, locationFlags, loading])

  return <FeatureContext.Provider value={value}>{children}</FeatureContext.Provider>
}

export function useFeature(key) {
  const context = useContext(FeatureContext)
  return context.isEnabled(key)
}


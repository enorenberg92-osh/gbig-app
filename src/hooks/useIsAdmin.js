import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import { useLocation } from '../context/LocationContext'

/**
 * Returns whether the current session user is an admin (or super_admin)
 * for THIS deployment's location.
 */
export function useIsAdmin(session) {
  const { locationId } = useLocation()
  const [isAdmin, setIsAdmin]           = useState(false)
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  const [checking, setChecking]         = useState(true)

  useEffect(() => {
    if (!session?.user) {
      setIsAdmin(false)
      setIsSuperAdmin(false)
      setChecking(false)
      return
    }

    async function checkAdmin() {
      const { data, error } = await supabase
        .from('location_admins')
        .select('role')
        .eq('user_id', session.user.id)
        .eq('location_id', locationId)
        .maybeSingle()

      if (!error && data) {
        setIsAdmin(true)
        setIsSuperAdmin(data.role === 'super_admin')
      } else {
        setIsAdmin(false)
        setIsSuperAdmin(false)
      }
      setChecking(false)
    }

    checkAdmin()
  }, [session, locationId])

  return { isAdmin, isSuperAdmin, checking }
}

import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

/**
 * Returns whether the current session user is an ecosystem super-admin.
 *
 * Distinct from `useIsAdmin`, which checks whether you're a location admin
 * for THIS deployment's location. A super-admin has no location -- they can
 * operate across the whole ecosystem (create locations, invite location
 * admins, edit branding, etc).
 *
 * Backed by the `super_admins` table (one row per super-admin user_id).
 * RLS on that table only exposes your own row, so this query returns zero
 * or one row.
 */
export function useIsSuperAdmin(session) {
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  const [checking, setChecking]         = useState(true)

  useEffect(() => {
    if (!session?.user) {
      setIsSuperAdmin(false)
      setChecking(false)
      return
    }

    async function check() {
      const { data, error } = await supabase
        .from('super_admins')
        .select('user_id')
        .eq('user_id', session.user.id)
        .maybeSingle()

      setIsSuperAdmin(!error && !!data)
      setChecking(false)
    }

    check()
  }, [session])

  return { isSuperAdmin, checking }
}

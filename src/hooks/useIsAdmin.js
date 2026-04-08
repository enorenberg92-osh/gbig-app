import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

export function useIsAdmin(session) {
  const [isAdmin, setIsAdmin] = useState(false)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    if (!session?.user) {
      setIsAdmin(false)
      setChecking(false)
      return
    }

    async function checkAdmin() {
      const { data, error } = await supabase
        .from('admins')
        .select('id')
        .eq('user_id', session.user.id)
        .maybeSingle()

      setIsAdmin(!error && !!data)
      setChecking(false)
    }

    checkAdmin()
  }, [session])

  return { isAdmin, checking }
}

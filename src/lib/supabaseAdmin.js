import { createClient } from '@supabase/supabase-js'

const supabaseUrl     = import.meta.env.VITE_SUPABASE_URL
const serviceRoleKey  = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY

// This client has admin privileges and can create/update auth users.
// It is only used inside admin components — never exposed to players.
export const supabaseAdmin = serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null

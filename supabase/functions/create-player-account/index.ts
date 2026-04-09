// Supabase Edge Function — create-player-account
// Creates a Supabase Auth user and links them to a player record.
//
// Deploy: supabase functions deploy create-player-account --project-ref mtuzmasicpcxcvtslevm

import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const { player_id, email, password } = await req.json()

    if (!player_id || !email || !password) {
      return new Response(
        JSON.stringify({ error: 'player_id, email, and password are required' }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )

    // Create the auth user — pre-confirmed, no email sent
    const { data: newUserData, error: createError } = await supabase.auth.admin.createUser({
      email:         email.toLowerCase().trim(),
      password,
      email_confirm: true,
    })

    if (createError) {
      console.error('createUser error:', createError.message)
      return new Response(
        JSON.stringify({ error: createError.message }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    // Link the new auth user to the player record
    const { error: updateError } = await supabase
      .from('players')
      .update({ user_id: newUserData.user.id, email: email.toLowerCase().trim() })
      .eq('id', player_id)

    if (updateError) {
      console.error('player link error:', updateError.message)
      return new Response(
        JSON.stringify({ error: updateError.message }),
        { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
      )
    }

    console.log(`Account created: player=${player_id} email=${email} user=${newUserData.user.id}`)

    return new Response(
      JSON.stringify({ success: true, user_id: newUserData.user.id }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    )

  } catch (e) {
    console.error('create-player-account fatal error:', String(e))
    return new Response(
      JSON.stringify({ error: String(e) }),
      { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
    )
  }
})

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    console.log('invoked')
    const { player_id, email, password } = await req.json()
    if (!player_id || !email || !password) {
      return new Response(JSON.stringify({ error: 'missing fields' }), { status: 400, headers: CORS })
    }
    const url = Deno.env.get('SUPABASE_URL')
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const clean = email.toLowerCase().trim()
    const r1 = await fetch(url + '/auth/v1/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'apikey': key },
      body: JSON.stringify({ email: clean, password: password, email_confirm: true }),
    })
    const b1 = await r1.json()
    console.log('createUser', r1.status)
    if (!r1.ok) return new Response(JSON.stringify({ error: b1.message || 'create failed' }), { status: 400, headers: CORS })
    await fetch(url + '/rest/v1/players?id=eq.' + player_id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'apikey': key, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ user_id: b1.id, email: clean }),
    })
    console.log('done', b1.id)
    return new Response(JSON.stringify({ success: true, user_id: b1.id }), { headers: CORS })
  } catch (e) {
    console.error(String(e))
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: CORS })
  }
})

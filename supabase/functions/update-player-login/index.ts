import { createClient } from 'npm:@supabase/supabase-js@2.101.1'
import { createPlayerLoginService, createLoginReviewSigner, LoginUpdateError } from '../_shared/playerLogin.mjs'

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...headers, 'Content-Type': 'application/json' },
})
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405)
  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim()
    if (!jwt) return json({ error: 'Sign in as a venue administrator.' }, 401)
    const url = Deno.env.get('SUPABASE_URL')!
    const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: 'Bearer ' + jwt } },
    })
    const { data: callerData, error: callerError } = await caller.auth.getUser(jwt)
    if (callerError || !callerData.user) return json({ error: 'Your session expired. Sign in again.' }, 401)
    const body = await req.json().catch(() => null)
    if (!body || !uuid.test(body.player_id) || !['status', 'preview', 'apply'].includes(body.action)) {
      return json({ error: 'Choose a player and a valid action.' }, 400)
    }
    const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const { data, error } = await admin.rpc(name, args)
      if (error) {
        if (error.code === '42501' && error.message === 'Not authorized for this venue') throw new LoginUpdateError('Not authorized for this venue.', 403)
        if (['42501', '42P01', 'PGRST202'].includes(error.code)) throw new LoginUpdateError('Login management needs server setup. Contact the account owner.', 503, 'setup_required')
        throw new LoginUpdateError('The player, login or correction status changed. Refresh and review the account.')
      }
      return data
    }
    const signer = await createLoginReviewSigner(secret)
    const service = createPlayerLoginService({
      store: {
        context: (actor: string, player: string, email: string | null) => rpc('service_player_login_context', { p_actor_id: actor, p_player_id: player, p_email: email }),
        async request(id: string, actor: string) {
          const { data, error } = await admin.from('player_login_updates').select('status').eq('id', id).eq('actor_id', actor).maybeSingle()
          if (error) throw new LoginUpdateError('Could not check the correction status. Refresh and try again.')
          return data
        },
        begin: (p: Record<string, unknown>) => rpc('service_begin_player_login_update', {
          p_request_id: p.request_id, p_actor_id: p.actor_id, p_player_id: p.player_id, p_user_id: p.user_id,
          p_roster_email: p.roster_email, p_old_auth_email: p.old_auth_email, p_new_email: p.email,
        }),
        finish: (id: string, actor: string) => rpc('service_finish_player_login_update', { p_request_id: id, p_actor_id: actor }),
        fail: (id: string, actor: string, code: string) => rpc('service_fail_player_login_update', { p_request_id: id, p_actor_id: actor, p_failure_code: code }),
      },
      auth: {
        async get(id: string) {
          const { data, error } = await admin.auth.admin.getUserById(id)
          if (error || !data.user) throw new LoginUpdateError('Could not load the existing Auth login. No new account was created.')
          return data.user
        },
        async update(id: string, attributes: { email: string }) {
          const { error } = await admin.auth.admin.updateUserById(id, attributes)
          if (error) throw new Error('auth_update_failed')
        },
      },
      ...signer,
    })
    const actor = callerData.user.id
    if (body.action === 'status') return json(await service.status(actor, body.player_id))
    if (body.action === 'preview') return json(await service.preview(actor, body.player_id, body.email))
    return json(await service.apply(actor, body.player_id, body.review, body.confirmed))
  } catch (error) {
    if (error instanceof LoginUpdateError) return json({ error: error.message, code: error.code }, error.status)
    return json({ error: 'Login details could not be loaded. Refresh and try again; contact the account owner if the issue continues.' }, 500)
  }
})

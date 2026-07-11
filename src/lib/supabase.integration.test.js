import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

/*
 * Local Supabase integration harness (skipped in the default unit run).
 *
 * To run it:
 *   1. `supabase start` and `supabase db reset`
 *   2. Seed two locations, player A, player B, an admin, a two-person roster,
 *      a course, and an open event using the local-only fixture script.
 *   3. Set LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, TEST_PLAYER_EMAIL,
 *      TEST_PLAYER_PASSWORD, TEST_ADMIN_EMAIL, TEST_ADMIN_PASSWORD,
 *      TEST_EVENT_ID, TEST_TEAM_ENTRIES (JSON), and TEST_LOCATION_B_ID.
 *   4. Temporarily change `describe.skip` to `describe` and run:
 *      `npm test -- src/lib/supabase.integration.test.js`
 *
 * Never point these tests at a hosted project: they submit and publish scores.
 */
describe.skip('Phase 1 local Supabase integration', () => {
  const url = process.env.LOCAL_SUPABASE_URL || 'http://127.0.0.1:54321'
  const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY

  async function signedInClient(email, password) {
    const client = createClient(url, anonKey, { auth: { persistSession: false } })
    const { error } = await client.auth.signInWithPassword({ email, password })
    if (error) throw error
    return client
  }

  it('makes a concurrent double-submit idempotent', async () => {
    const player = await signedInClient(process.env.TEST_PLAYER_EMAIL, process.env.TEST_PLAYER_PASSWORD)
    const args = {
      p_event_id: process.env.TEST_EVENT_ID,
      p_entries: JSON.parse(process.env.TEST_TEAM_ENTRIES),
    }
    const [first, second] = await Promise.all([
      player.rpc('submit_scores', args),
      player.rpc('submit_scores', args),
    ])
    expect(first.error).toBeNull()
    expect(second.error).toBeNull()
    expect([first.data.inserted, second.data.inserted].sort()).toEqual([0, 2])
  })

  it('serializes submit against publish and never creates a penalty beside played scores', async () => {
    const player = await signedInClient(process.env.TEST_PLAYER_EMAIL, process.env.TEST_PLAYER_PASSWORD)
    const admin = await signedInClient(process.env.TEST_ADMIN_EMAIL, process.env.TEST_ADMIN_PASSWORD)
    const args = {
      p_event_id: process.env.TEST_EVENT_ID,
      p_entries: JSON.parse(process.env.TEST_TEAM_ENTRIES),
    }
    const [submit, publish] = await Promise.all([
      player.rpc('submit_scores', args),
      admin.rpc('publish_week', { p_event_id: process.env.TEST_EVENT_ID }),
    ])
    // If submit wins the lock, publish sees pending rows and blocks. If publish
    // wins, submit sees the closed event. They cannot both mutate successfully.
    expect(Boolean(submit.error) || Boolean(publish.error)).toBe(true)
  })

  it('publishes idempotently', async () => {
    const admin = await signedInClient(process.env.TEST_ADMIN_EMAIL, process.env.TEST_ADMIN_PASSWORD)
    const first = await admin.rpc('publish_week', { p_event_id: process.env.TEST_EVENT_ID })
    const second = await admin.rpc('publish_week', { p_event_id: process.env.TEST_EVENT_ID })
    expect(first.error).toBeNull()
    expect(second.error).toBeNull()
    expect(second.data).toMatchObject({ published: false, already_closed: true })
  })

  it('prevents player A from reading location B', async () => {
    const player = await signedInClient(process.env.TEST_PLAYER_EMAIL, process.env.TEST_PLAYER_PASSWORD)
    const { data, error } = await player
      .from('events')
      .select('id')
      .eq('location_id', process.env.TEST_LOCATION_B_ID)
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('can rebuild the migration chain twice from a clean local stack', () => {
    execFileSync('supabase', ['db', 'reset', '--local'], { stdio: 'pipe' })
    execFileSync('supabase', ['db', 'reset', '--local'], { stdio: 'pipe' })
  })
})


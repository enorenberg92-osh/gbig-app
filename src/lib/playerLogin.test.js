import { describe, it, expect, vi } from 'vitest'
import { createPlayerLoginService, createLoginReviewSigner, normalizeLoginEmail } from '../../supabase/functions/_shared/playerLogin.mjs'

function fixture(options = {}) {
  let context = {
    player: { id: 'player', name: 'Test Golfer', location_id: 'appleton', email: 'old@example.invalid', user_id: 'auth-user' },
    venue: 'Appleton Indoor Golf', shared_login: false, staff_login: false, email_conflict: false,
    roster_conflict: false, in_progress: false, ...options.context,
  }
  let user = { id: 'auth-user', email: 'old@example.invalid', updated_at: 'before', email_confirmed_at: 'confirmed-before',
    last_sign_in_at: null, identities: [{ id: 'identity', provider: 'email' }], ...options.user }
  let request = null
  const store = {
    context: vi.fn(async () => structuredClone(context)),
    request: vi.fn(async () => request),
    begin: vi.fn(async () => { request = { status: 'applying' }; return { status: 'started' } }),
    finish: vi.fn(async () => { context.player.email = 'correct@example.invalid'; request.status = 'complete' }),
    fail: vi.fn(async () => { request.status = 'needs_review' }),
  }
  const auth = {
    get: vi.fn(async () => structuredClone(user)),
    update: vi.fn(async (_id, values) => { user.email = values.email; user.updated_at = 'after' }),
  }
  const sign = vi.fn(async value => structuredClone(value))
  const verify = vi.fn(async value => structuredClone(value))
  const service = createPlayerLoginService({ store, auth, sign, verify, now: () => 100000, uuid: () => 'request-id' })
  return { service, store, auth, sign, verify, context, user, replaceContext: value => { context = value } }
}
const preview = f => f.service.preview('admin', 'player', 'correct@example.invalid')
const apply = (f, review) => f.service.apply('admin', 'player', review, true)

describe('existing player login corrections', () => {
  it('cryptographically rejects modified reviews and signatures from another server', async () => {
    const signer = await createLoginReviewSigner('synthetic-server-key')
    const other = await createLoginReviewSigner('different-synthetic-key')
    const payload = { actor_id: 'admin', email: 'correct@example.invalid' }
    const signed = await signer.sign(payload)
    expect(await signer.verify(signed)).toEqual(payload)
    await expect(other.verify(signed)).rejects.toThrow('invalid')
    const [data, signature] = signed.split('.')
    const altered = btoa(atob(data.replace(/-/g, '+').replace(/_/g, '/')).replace('correct', 'another'))
    await expect(signer.verify(altered + '.' + signature)).rejects.toThrow('invalid')
    await expect(signer.verify('invalid')).rejects.toThrow('invalid')
  })
  it('normalizes addresses and rejects whitespace, empty and overlong inputs', () => {
    expect(normalizeLoginEmail(' Correct@Example.invalid ')).toBe('correct@example.invalid')
    for (const email of [null, '', 'a b@example.invalid', 'a@b', 'x'.repeat(250) + '@example.invalid']) {
      expect(() => normalizeLoginEmail(email)).toThrow()
    }
  })
  it('previews without mutating Auth or the roster', async () => {
    const f = fixture()
    const result = await preview(f)
    expect(result.auth_email).toBe('old@example.invalid')
    expect(result.new_email).toBe('correct@example.invalid')
    expect(result.last_sign_in_at).toBe(null)
    expect(f.auth.update).not.toHaveBeenCalled()
    expect(f.store.begin).not.toHaveBeenCalled()
    expect(f.store.finish).not.toHaveBeenCalled()
  })
  it.each(['shared_login', 'staff_login', 'email_conflict', 'roster_conflict', 'in_progress'])('blocks %s before a mutation', async flag => {
    const f = fixture({ context: { [flag]: true } })
    await expect(preview(f)).rejects.toThrow()
    expect(f.auth.update).not.toHaveBeenCalled()
    expect(f.store.begin).not.toHaveBeenCalled()
  })
  it.each([{ identities: [{ provider: 'google' }] }, { new_email: 'pending@example.invalid' }])('blocks provider and pending-change conflicts', async user => {
    const f = fixture({ user })
    await expect(preview(f)).rejects.toThrow()
  })
  it('requires actual venue authorization even for status reads', async () => {
    const f = fixture()
    f.store.context.mockRejectedValue(new Error('not authorized'))
    await expect(f.service.status('outsider', 'player')).rejects.toThrow('not authorized')
    expect(f.auth.get).not.toHaveBeenCalled()
  })
  it('only updates email on the same Auth user, then finalizes and verifies the roster', async () => {
    const f = fixture()
    const review = await preview(f)
    const result = await apply(f, review.review)
    expect(f.auth.update).toHaveBeenCalledTimes(1)
    expect(f.auth.update).toHaveBeenCalledWith('auth-user', { email: 'correct@example.invalid' })
    expect(f.store.finish).toHaveBeenCalledTimes(1)
    expect(f.store.finish).toHaveBeenCalledWith('request-id', 'admin')
    expect(result.player.id).toBe('player')
    expect(result.player.user_id).toBe('auth-user')
    expect(result.auth_email).toBe(result.player.email)
    expect(result.email_confirmed).toBe(true)
  })
  it('preserves unconfirmed status without confirming the new address', async () => {
    const f = fixture({ user: { email_confirmed_at: null } })
    const review = await preview(f)
    const result = await apply(f, review.review)
    expect(result.email_confirmed).toBe(false)
    expect(f.auth.update.mock.calls[0][1]).toEqual({ email: 'correct@example.invalid' })
  })
  it('rejects an unsigned/altered review, wrong actor, expired review and missing approval', async () => {
    const f = fixture()
    const review = (await preview(f)).review
    await expect(f.service.apply('admin', 'player', review, false)).rejects.toThrow('confirm')
    await expect(apply(f, { ...review, actor_id: 'other' })).rejects.toThrow('another account')
    await expect(apply(f, { ...review, expires_at: 1 })).rejects.toThrow('expired')
    f.verify.mockRejectedValueOnce(new Error('invalid signature'))
    await expect(apply(f, review)).rejects.toThrow('invalid signature')
    expect(f.auth.update).not.toHaveBeenCalled()
  })
  it('rejects stale player/account changes and newly claimed addresses at apply time', async () => {
    const f = fixture()
    const review = (await preview(f)).review
    f.user.updated_at = 'someone changed auth'
    await expect(apply(f, review)).rejects.toThrow('changed after')
    expect(f.store.begin).not.toHaveBeenCalled()
    f.user.updated_at = 'before'
    f.context.email_conflict = true
    await expect(apply(f, review)).rejects.toThrow('conflict')
    expect(f.auth.update).not.toHaveBeenCalled()
  })
  it('does not mutate on two concurrent applies when the database reserve loses', async () => {
    const f = fixture()
    const review = (await preview(f)).review
    f.store.begin.mockResolvedValueOnce({ status: 'applying' })
    await expect(apply(f, review)).rejects.toThrow('already in progress')
    expect(f.auth.update).not.toHaveBeenCalled()
  })
  it('never updates the roster after an Auth failure and records the recovery state', async () => {
    const f = fixture()
    const review = (await preview(f)).review
    f.auth.update.mockRejectedValue(new Error('Auth failed'))
    await expect(apply(f, review)).rejects.toMatchObject({ code: 'partial_failure' })
    expect(f.store.finish).not.toHaveBeenCalled()
    expect(f.store.fail).toHaveBeenCalledWith('request-id', 'admin', 'auth_update_failed')
  })
  it('verifies a timed out Auth write before finalizing instead of repeating it', async () => {
    const f = fixture()
    const review = (await preview(f)).review
    f.auth.update.mockImplementationOnce(async (_id, values) => { f.user.email = values.email; throw new Error('timeout') })
    expect((await apply(f, review)).status).toBe('complete')
    expect(f.auth.update).toHaveBeenCalledTimes(1)
  })
  it('reports partial success if Auth succeeds but the roster cannot be finalized', async () => {
    const f = fixture()
    const review = (await preview(f)).review
    f.store.finish.mockRejectedValue(new Error('DB failed'))
    await expect(apply(f, review)).rejects.toThrow('login may have changed while the roster did not')
    expect(f.user.email).toBe('correct@example.invalid')
    expect(f.context.player.email).toBe('old@example.invalid')
    expect(f.store.fail).toHaveBeenCalledWith('request-id', 'admin', 'roster_update_failed')
    expect(f.auth.update).toHaveBeenCalledTimes(1)
  })
  it('checks final values on an idempotent successful retry without another write', async () => {
    const f = fixture()
    const review = (await preview(f)).review
    await apply(f, review)
    expect((await apply(f, review)).status).toBe('complete')
    expect(f.auth.update).toHaveBeenCalledTimes(1)
    expect(f.store.finish).toHaveBeenCalledTimes(1)
  })
})

export class LoginUpdateError extends Error {
  constructor(message, status = 409, code = 'review_required') {
    super(message)
    this.status = status
    this.code = code
  }
}

export const LOGIN_CHANGE_NOTICE = 'This corrects the existing login immediately, without a confirmation email. The existing password and account confirmation status are kept. No welcome or password reset email is requested. Previous verification or recovery links may stop working.'

export async function createLoginReviewSigner(secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
  return {
    async sign(payload) {
      const data = new TextEncoder().encode(JSON.stringify(payload))
      const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, data))
      return encode(data) + '.' + encode(signature)
    },
    async verify(value) {
      try {
        if (typeof value !== 'string' || value.length > 12000) throw new Error('invalid')
        const parts = value.split('.')
        if (parts.length !== 2) throw new Error('invalid')
        const data = decode(parts[0])
        if (!await crypto.subtle.verify('HMAC', key, decode(parts[1]), data)) throw new Error('invalid')
        return JSON.parse(new TextDecoder().decode(data))
      } catch { throw new LoginUpdateError('This review is invalid. Review the correction again.', 400) }
    },
  }
}

export function normalizeLoginEmail(value) {
  if (typeof value !== 'string') throw new LoginUpdateError('Enter the corrected email address.', 400)
  const email = value.trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new LoginUpdateError('Enter a valid email address.', 400)
  }
  return email
}

function assertEditable(context, user) {
  if (!context.player.user_id || !user) throw new LoginUpdateError('No existing login is linked. Use Create Account for a player without a login.')
  if (context.shared_login) throw new LoginUpdateError('This login is shared by multiple player profiles. Contact the account owner; no accounts have been merged or changed.')
  if (context.staff_login) throw new LoginUpdateError('This is a staff or owner login. Correct it through the account security process.')
  if (!user.email || !(user.identities || []).some(identity => identity.provider === 'email') ||
      (user.identities || []).some(identity => identity.provider !== 'email')) {
    throw new LoginUpdateError('This login uses an external sign-in provider. Review it through the account security process.')
  }
  if (user.new_email) throw new LoginUpdateError('This account has a pending email change. Resolve that request before making a correction.')
}

function fingerprint(context, user) {
  return JSON.stringify({
    player: context.player, auth_id: user.id, auth_email: user.email,
    auth_updated_at: user.updated_at, email_confirmed_at: user.email_confirmed_at || null,
    identities: (user.identities || []).map(identity => ({ id: identity.id, provider: identity.provider })),
  })
}

// Dependency injection keeps tests on synthetic accounts; no service key or live
// credentials are needed to exercise Auth and roster failure paths.
export function createPlayerLoginService({ store, auth, sign, verify, now = Date.now, uuid = () => crypto.randomUUID() }) {
  async function inspect(actorId, playerId, email = null) {
    const context = await store.context(actorId, playerId, email)
    const user = context.player.user_id ? await auth.get(context.player.user_id) : null
    return { context, user }
  }
  function summary(context, user) {
    let blocked = null
    try { assertEditable(context, user) } catch (error) { blocked = error.message }
    if (context.in_progress) blocked = 'A previous correction is unfinished. Contact the account owner to reconcile it before trying again.'
    return {
      player: context.player, venue: context.venue, auth_email: user?.email || null,
      email_confirmed: !!user?.email_confirmed_at, last_sign_in_at: user?.last_sign_in_at || null,
      blocked, notice: LOGIN_CHANGE_NOTICE,
    }
  }
  async function verifyResult(actorId, payload) {
    const { context, user } = await inspect(actorId, payload.player_id)
    if (context.player.user_id !== payload.user_id || user?.id !== payload.user_id ||
        normalizeLoginEmail(user.email) !== payload.email || context.player.email !== payload.email ||
        (user.email_confirmed_at || null) !== payload.confirmed_at) {
      throw new LoginUpdateError('The correction could not be fully verified. Review the roster and login before trying again.', 409, 'verification_failed')
    }
    return { ...summary(context, user), status: 'complete', request_id: payload.request_id }
  }
  return {
    async status(actorId, playerId) {
      const { context, user } = await inspect(actorId, playerId)
      return summary(context, user)
    },
    async preview(actorId, playerId, value) {
      const email = normalizeLoginEmail(value)
      const { context, user } = await inspect(actorId, playerId, email)
      assertEditable(context, user)
      if (context.in_progress) throw new LoginUpdateError('A previous correction is unfinished. Contact the account owner to reconcile it.')
      if (context.email_conflict || context.roster_conflict) throw new LoginUpdateError('That email belongs to another account or player profile. Confirm the player identity and use a unique address; no accounts have been merged.')
      if (email === normalizeLoginEmail(user.email) && email === context.player.email) {
        throw new LoginUpdateError('The roster and login already use this email. No correction is needed.', 400)
      }
      const payload = {
        actor_id: actorId, player_id: playerId, location_id: context.player.location_id,
        user_id: user.id, email, roster_email: context.player.email, old_auth_email: user.email,
        confirmed_at: user.email_confirmed_at || null, fingerprint: fingerprint(context, user),
        request_id: uuid(), expires_at: now() + 10 * 60 * 1000,
      }
      return { ...summary(context, user), new_email: email, review: await sign(payload) }
    },
    async apply(actorId, playerId, review, confirmed) {
      if (confirmed !== true) throw new LoginUpdateError('Review and confirm the correction first.', 400)
      const payload = await verify(review)
      if (payload.actor_id !== actorId || payload.player_id !== playerId || !Number.isFinite(payload.expires_at) || payload.expires_at < now()) {
        throw new LoginUpdateError('This review expired or belongs to another account. Review the correction again.')
      }
      const { context, user } = await inspect(actorId, playerId, payload.email)
      assertEditable(context, user)
      const prior = await store.request(payload.request_id, actorId)
      if (prior?.status === 'complete') return verifyResult(actorId, payload)
      if (prior) throw new LoginUpdateError('This correction was already attempted. Refresh the login details and review its status before trying again.')
      if (fingerprint(context, user) !== payload.fingerprint) throw new LoginUpdateError('The player or login changed after your review. Review the correction again.')
      if (context.email_conflict || context.roster_conflict || context.in_progress) throw new LoginUpdateError('An account conflict or unfinished correction needs review.')
      const start = await store.begin(payload)
      if (start.status !== 'started') throw new LoginUpdateError('This correction is already in progress. Refresh its status.')
      let stage = 'auth_update_failed'
      try {
        // Recheck after reserving the player, and NEVER change passwords, roles,
        // user metadata, user_id or email_confirm. Only the email is submitted.
        const current = await auth.get(payload.user_id)
        if (fingerprint(context, current) !== payload.fingerprint) throw new Error('stale_auth')
        if (normalizeLoginEmail(current.email) !== payload.email) {
          try { await auth.update(payload.user_id, { email: payload.email }) }
          catch {
            // A timeout may follow a successful API write. Read the existing
            // user before deciding; never roll back or blindly repeat the call.
            const after = await auth.get(payload.user_id)
            if (normalizeLoginEmail(after.email) !== payload.email) throw new Error('auth_update_failed')
          }
        }
        stage = 'auth_verification_failed'
        const after = await auth.get(payload.user_id)
        if (after.id !== payload.user_id || normalizeLoginEmail(after.email) !== payload.email ||
            (after.email_confirmed_at || null) !== payload.confirmed_at) throw new Error('auth_verification_failed')
        stage = 'roster_update_failed'
        await store.finish(payload.request_id, actorId)
        stage = 'verification_failed'
        return await verifyResult(actorId, payload)
      } catch {
        let recorded = true
        try { await store.fail(payload.request_id, actorId, stage) } catch { recorded = false }
        throw new LoginUpdateError(
          'The correction did not fully complete. The login may have changed while the roster did not. Refresh the login details and contact the account owner with correction ID ' +
          payload.request_id + '. Do not create another account.' + (recorded ? '' : ' Its recovery status could not be saved.'),
          409, 'partial_failure',
        )
      }
    },
  }
}

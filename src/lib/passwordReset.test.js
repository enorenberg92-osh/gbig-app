import { describe, it, expect } from 'vitest'
import {
  parseAuthRedirect, authLinkErrorMessage, isRateLimitError,
  validateNewPassword, updatePasswordErrorMessage,
} from './passwordReset'

describe('parseAuthRedirect', () => {
  it('detects a recovery redirect in the hash', () => {
    expect(parseAuthRedirect('https://x.app/league#access_token=abc&expires_in=3600&refresh_token=r&token_type=bearer&type=recovery'))
      .toEqual({ type: 'recovery' })
  })
  it('detects an expired-link error in the hash', () => {
    expect(parseAuthRedirect('https://x.app/league#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'))
      .toEqual({ type: 'error', code: 'otp_expired', description: 'Email link is invalid or has expired' })
  })
  it('detects an error in the query string', () => {
    expect(parseAuthRedirect('https://x.app/league?error=access_denied&error_description=nope'))
      .toEqual({ type: 'error', code: 'access_denied', description: 'nope' })
  })
  it('ignores ordinary URLs and other link types', () => {
    expect(parseAuthRedirect('https://x.app/league')).toBeNull()
    expect(parseAuthRedirect('https://x.app/league/standings?week=3')).toBeNull()
    expect(parseAuthRedirect('https://x.app/#access_token=a&type=signup')).toBeNull()
    expect(parseAuthRedirect('not a url')).toBeNull()
  })
})

describe('authLinkErrorMessage', () => {
  it('has specific copy for expired links', () => {
    expect(authLinkErrorMessage('otp_expired')).toMatch(/expired/)
    expect(authLinkErrorMessage('access_denied')).toMatch(/no longer valid/)
  })
})

describe('isRateLimitError', () => {
  it('recognises the supabase throttle shapes', () => {
    expect(isRateLimitError({ status: 429, message: 'x' })).toBe(true)
    expect(isRateLimitError({ status: 400, code: 'over_email_send_rate_limit' })).toBe(true)
    expect(isRateLimitError({ message: 'For security purposes, you can only request this after 42 seconds.' })).toBe(true)
    expect(isRateLimitError({ message: 'email rate limit exceeded' })).toBe(true)
  })
  it('ignores other errors', () => {
    expect(isRateLimitError(null)).toBe(false)
    expect(isRateLimitError({ status: 400, message: 'Unable to validate email address: invalid format' })).toBe(false)
  })
})

describe('validateNewPassword', () => {
  it('trims and accepts matching passwords', () => {
    expect(validateNewPassword(' secret1 ', 'secret1')).toEqual({ password: 'secret1' })
  })
  it('enforces the minimum length after trimming', () => {
    expect(validateNewPassword('  abc  ', 'abc').error).toMatch(/at least 6/)
    expect(validateNewPassword('', '').error).toMatch(/at least 6/)
  })
  it('requires the confirmation to match', () => {
    expect(validateNewPassword('secret1', 'secret2').error).toMatch(/do not match/)
  })
})

describe('updatePasswordErrorMessage', () => {
  it('maps known auth errors', () => {
    expect(updatePasswordErrorMessage({ code: 'same_password', message: '' })).toMatch(/already your password/)
    expect(updatePasswordErrorMessage({ message: 'Auth session missing!' })).toMatch(/expired/)
    expect(updatePasswordErrorMessage({ code: 'weak_password' })).toMatch(/at least 6/)
    expect(updatePasswordErrorMessage({ message: 'boom' })).toMatch(/try again/)
  })
})

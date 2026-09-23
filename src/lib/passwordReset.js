// Pure helpers for the self-serve "Forgot password?" flow.
//
// Flow: LoginScreen → supabase.auth.resetPasswordForEmail → email link →
// Supabase verifies the token and redirects back to /league with either
//   #access_token=…&type=recovery            (valid link → PASSWORD_RECOVERY)
//   #error=access_denied&error_code=otp_expired&error_description=…  (bad link)
// App.jsx reads the URL once at load (before supabase-js clears the hash) and
// shows SetNewPassword.

export const MIN_PASSWORD_LENGTH = 6

/**
 * Classify an auth redirect URL. Supabase puts implicit-flow results in the
 * hash and some errors in the query string, so both are checked (hash wins).
 * Returns { type: 'recovery' } | { type: 'error', code, description } | null.
 */
export function parseAuthRedirect(href) {
  let url
  try { url = new URL(href) } catch { return null }
  const params = new URLSearchParams(url.search)
  const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
  // Hash params override query params, matching supabase-js.
  new URLSearchParams(hash).forEach((v, k) => params.set(k, v))

  if (params.get('error') || params.get('error_code') || params.get('error_description')) {
    return {
      type: 'error',
      code: params.get('error_code') || params.get('error') || 'unknown',
      description: params.get('error_description') || '',
    }
  }
  if (params.get('type') === 'recovery') return { type: 'recovery' }
  return null
}

/** Friendly copy for a link that couldn't be used. */
export function authLinkErrorMessage(code) {
  if (code === 'otp_expired') {
    return 'This reset link has expired or has already been used. Links only work once and expire after a short time.'
  }
  return 'This reset link is no longer valid. Request a new one and use the most recent email.'
}

/** Supabase throttles reset emails: 429 / "For security purposes…" / over_email_send_rate_limit. */
export function isRateLimitError(error) {
  if (!error) return false
  if (error.status === 429) return true
  if (typeof error.code === 'string' && /rate_limit/i.test(error.code)) return true
  return /for security purposes|rate limit/i.test(error.message || '')
}

/**
 * Validate a new password + confirmation. Trimmed because LoginScreen trims
 * on sign-in — a stray trailing space would otherwise lock the player out.
 * Returns { password } on success or { error } with a user-facing message.
 */
export function validateNewPassword(password, confirm) {
  const next = (password || '').trim()
  if (next.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` }
  }
  if (next !== (confirm || '').trim()) {
    return { error: 'Passwords do not match.' }
  }
  return { password: next }
}

/** Map a supabase.auth.updateUser error to player-facing copy. */
export function updatePasswordErrorMessage(error) {
  const code = error?.code || ''
  const msg  = error?.message || ''
  if (code === 'same_password' || /different from the old/i.test(msg)) {
    return 'That is already your password — choose a different one, or just continue.'
  }
  if (code === 'weak_password' || /at least/i.test(msg)) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  if (code === 'session_not_found' || code === 'session_expired' || /session missing|jwt expired|invalid jwt/i.test(msg)) {
    return 'Your reset link has expired. Request a new one from the sign-in screen.'
  }
  return 'Could not update your password. Please try again.'
}

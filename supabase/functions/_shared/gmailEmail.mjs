// Google credentials and refresh tokens are used only by Edge Functions.
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
export const GMAIL_ORIGINS = ['https://gbig-app.vercel.app', 'https://appleton-app.vercel.app']
const encoder = new TextEncoder()
const addressPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i
export function base64(bytes) { return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')) }
export function unbase64(value) { return Uint8Array.from(atob(value), char => char.charCodeAt(0)) }
export function base64url(bytes) { return base64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
export function randomSecret() { return base64url(crypto.getRandomValues(new Uint8Array(32))) }
export async function digest(value) { return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))) }
export function gmailConfiguration(get) {
  const clientId = get('GMAIL_CLIENT_ID') || ''
  const clientSecret = get('GMAIL_CLIENT_SECRET') || ''
  const encryptionKey = get('GMAIL_TOKEN_ENCRYPTION_KEY') || ''
  try {
    if (!clientId.endsWith('.apps.googleusercontent.com') || !clientSecret || unbase64(encryptionKey).length !== 32) return null
  } catch { return null }
  return { clientId, clientSecret, encryptionKey }
}
async function encryptionKey(value) { return crypto.subtle.importKey('raw', unbase64(value), 'AES-GCM', false, ['encrypt', 'decrypt']) }
export async function seal(value, key, binding) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(binding) }, await encryptionKey(key), encoder.encode(value))
  return `v1.${base64(iv)}.${base64(new Uint8Array(encrypted))}`
}
export async function unseal(value, key, binding) {
  const [version, iv, encrypted, extra] = String(value).split('.')
  if (version !== 'v1' || !iv || !encrypted || extra) throw new Error('Gmail needs to be reconnected.')
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(iv), additionalData: encoder.encode(binding) }, await encryptionKey(key), unbase64(encrypted))
  return new TextDecoder().decode(plaintext)
}
export function oauthURL({ clientId, redirectUri, state, challenge, email }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
    scope: `openid email ${GMAIL_SCOPE}`, access_type: 'offline', prompt: 'consent select_account',
    include_granted_scopes: 'false', state, code_challenge: challenge, code_challenge_method: 'S256', login_hint: email }).toString()
  return url.href
}
export async function exchangeGoogleToken(parameters, fetcher = fetch) {
  const response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(parameters), signal: AbortSignal.timeout(15000) })
  const token = await response.json()
  if (!response.ok || typeof token.access_token !== 'string' || token.token_type?.toLowerCase() !== 'bearer') throw new Error('Google authorization could not be completed. Reconnect Gmail.')
  return token
}
export async function googleMailbox(accessToken, fetcher = fetch) {
  const response = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) })
  const identity = await response.json()
  if (!response.ok || identity.email_verified !== true || typeof identity.sub !== 'string' || !addressPattern.test(identity.email || '')) throw new Error('Google could not verify this mailbox.')
  return { email: identity.email.toLowerCase(), sub: identity.sub }
}
export function requireSendingScope(scope) {
  const scopes = new Set(String(scope || '').split(/\s+/))
  if (!scopes.has(GMAIL_SCOPE)) throw new Error('Approve Gmail sending access before connecting.')
  // Refuse accidental inbox/modify grants; this integration needs sending only.
  const allowed = new Set([GMAIL_SCOPE, 'openid', 'email', 'https://www.googleapis.com/auth/userinfo.email'])
  if ([...scopes].some(value => value && !allowed.has(value))) throw new Error('Reconnect with only email identity and Gmail sending access.')
}
function address(value) {
  if (typeof value !== 'string' || value.length > 254 || !addressPattern.test(value)) throw new Error('Invalid email address.')
  return value
}
function encodedHeader(value) {
  if (typeof value !== 'string' || /[\r\n\x00-\x1f]/.test(value)) throw new Error('Invalid email header.')
  // Short Unicode-safe encoded words, folded to RFC 2047 limits.
  const chars = Array.from(value), words = []
  for (let index = 0; index < chars.length; index += 10) words.push(`=?UTF-8?B?${base64(encoder.encode(chars.slice(index, index + 10).join('')))}?=`)
  return words.join('\r\n ')
}
export async function gmailMessage(payload, key, mailbox) {
  const from = payload.from?.match(/^([^<>]+) <([^<>]+)>$/)
  if (!from || from[2].toLowerCase() !== mailbox.toLowerCase()) throw new Error('The connected Gmail account must match From.')
  if (!Array.isArray(payload.to) || payload.to.length !== 1) throw new Error('Send one recipient at a time.')
  const messageId = `<${await digest(key)}@gbig-app.vercel.app>`
  const body = base64(encoder.encode(payload.text.replace(/\r\n|\r|\n/g, '\r\n'))).match(/.{1,76}/g)?.join('\r\n') || ''
  const mime = [`From: ${encodedHeader(from[1])} <${address(from[2])}>`, `To: ${address(payload.to[0])}`,
    `Reply-To: ${address(payload.reply_to)}`, `Subject: ${encodedHeader(payload.subject)}`, `Message-ID: ${messageId}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body].join('\r\n')
  return { raw: base64url(encoder.encode(mime)), messageId }
}
export async function sendGmail(payload, key, mailbox, accessToken, fetcher = fetch) {
  const { raw } = await gmailMessage(payload, key, mailbox)
  const response = await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }), signal: AbortSignal.timeout(15000) })
  const result = await response.json()
  if (!response.ok || typeof result.id !== 'string') throw new Error('Gmail did not confirm acceptance. Check Sent mail before attempting another email.')
  return { id: result.id }
}

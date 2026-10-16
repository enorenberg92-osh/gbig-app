import { describe, expect, it, vi } from 'vitest'
vi.mock('./supabase', () => ({ supabase: { functions: { invoke: vi.fn() } } }))
import { GMAIL_SCOPE, base64, unbase64, gmailConfiguration, seal, unseal, oauthURL, gmailMessage, sendGmail, requireSendingScope, googleMailbox } from '../../supabase/functions/_shared/gmailEmail.mjs'
import { sendChunk } from '../../supabase/functions/_shared/weeklyEmail.mjs'
import { checkedGoogleURL } from '../components/admin/GmailConnections'

const key = base64(new Uint8Array(32).fill(7))
const payload = { from: 'Trent <trent@greenbayindoorgolf.com>', reply_to: 'trent@greenbayindoorgolf.com', to: ['owner@example.com'], subject: 'League ⛳ update', text: 'Hello\nSecond line' }
const mailbox = 'trent@greenbayindoorgolf.com'
describe('Gmail account integration', () => {
  it('requires a complete server configuration and exactly 32 encryption-key bytes', () => {
    const env = { GMAIL_CLIENT_ID: 'test.apps.googleusercontent.com', GMAIL_CLIENT_SECRET: 'test-only', GMAIL_TOKEN_ENCRYPTION_KEY: key }
    expect(gmailConfiguration(name => env[name])).toBeTruthy()
    expect(gmailConfiguration(name => ({ ...env, GMAIL_TOKEN_ENCRYPTION_KEY: 'bad' })[name])).toBeNull()
    expect(gmailConfiguration(() => undefined)).toBeNull()
  })
  it('encrypts refresh tokens with sender binding and rejects tampering or a different mailbox', async () => {
    const sealed = await seal('test-refresh-token', key, 'sender:one:trent@example.com')
    expect(sealed).not.toContain('test-refresh-token')
    expect(await unseal(sealed, key, 'sender:one:trent@example.com')).toBe('test-refresh-token')
    await expect(unseal(sealed, key, 'sender:two:other@example.com')).rejects.toThrow()
    await expect(unseal(sealed, base64(new Uint8Array(32).fill(9)), 'sender:one:trent@example.com')).rejects.toThrow()
  })
  it('requests offline sending and email identity only, with PKCE and state', () => {
    const url = new URL(oauthURL({ clientId: 'client', redirectUri: 'https://example.com/callback', state: 'state', challenge: 'challenge', email: mailbox }))
    expect(url.searchParams.get('scope').split(' ')).toEqual(['openid', 'email', GMAIL_SCOPE])
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('state')).toBe('state')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(checkedGoogleURL(url.href)).toBe(url.href)
    expect(() => checkedGoogleURL(url.href.replace('accounts.google.com', 'accounts.google.com.evil.example'))).toThrow()
    expect(() => checkedGoogleURL(url.href.replace('gmail.send', 'gmail.modify'))).toThrow()
    requireSendingScope(`openid https://www.googleapis.com/auth/userinfo.email ${GMAIL_SCOPE}`)
    expect(() => requireSendingScope('openid email')).toThrow()
    expect(() => requireSendingScope(`${GMAIL_SCOPE} https://www.googleapis.com/auth/gmail.readonly`)).toThrow()
  })
  it('accepts only a Google-verified mailbox identity', async () => {
    expect(await googleMailbox('test-token', async () => Response.json({ email: mailbox.toUpperCase(), sub: 'google-id', email_verified: true }))).toEqual({ email: mailbox, sub: 'google-id' })
    await expect(googleMailbox('test-token', async () => Response.json({ email: mailbox, sub: 'google-id', email_verified: false }))).rejects.toThrow()
  })
  it('creates one Unicode-safe MIME message with stable Message-ID and no header injection', async () => {
    const message = await gmailMessage(payload, 'campaign/1', mailbox)
    const mime = new TextDecoder().decode(unbase64(message.raw.replace(/-/g, '+').replace(/_/g, '/')))
    expect(mime).toContain('To: owner@example.com\r\n')
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8')
    expect(mime).toContain('Subject: =?UTF-8?B?')
    expect((await gmailMessage(payload, 'campaign/1', mailbox)).messageId).toBe(message.messageId)
    await expect(gmailMessage({ ...payload, subject: 'Hello\r\nBcc: victim@example.com' }, 'key', mailbox)).rejects.toThrow()
    await expect(gmailMessage({ ...payload, to: ['one@example.com', 'two@example.com'] }, 'key', mailbox)).rejects.toThrow()
    await expect(gmailMessage(payload, 'key', 'jordan@appletonindoorgolf.com')).rejects.toThrow()
  })
  it('sends only to the fixed Gmail API endpoint and requires a successful provider ID', async () => {
    let calls = 0
    const result = await sendGmail(payload, 'campaign/1', mailbox, 'test-access-token', async (url, options) => {
      calls++
      expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
      expect(JSON.parse(options.body)).toHaveProperty('raw')
      return Response.json({ id: 'google-message-id' })
    })
    expect(result).toEqual({ id: 'google-message-id' })
    expect(calls).toBe(1)
    await expect(sendGmail(payload, 'key', mailbox, 'test-token', async () => Response.json({ error: 'quota' }, { status: 429 }))).rejects.toThrow()
  })
  it('never retries a Gmail recipient after a timeout or interrupted progress write', async () => {
    const row = { id: 'campaign', sender: payload.from, reply_to: payload.reply_to, subject: payload.subject, body: payload.text, recipients: [{ email: 'owner@example.com', status: 'pending', attempted_at: null }] }
    let calls = 0, saved
    const result = await sendChunk(row, { retryUnconfirmed: false, save: async state => { saved = structuredClone(state) }, send: async () => { calls++; throw new Error('timeout') } })
    expect(result.recipients[0].status).toBe('review')
    await sendChunk(saved, { retryUnconfirmed: false, save: async () => {}, send: async () => { calls++; return { id: 'duplicate' } } })
    expect(calls).toBe(1)
    row.recipients[0].attempted_at = new Date().toISOString()
    const crashResult = await sendChunk(row, { retryUnconfirmed: false, save: async () => {}, send: async () => { calls++; return { id: 'duplicate' } } })
    expect(crashResult.recipients[0].status).toBe('review')
    expect(calls).toBe(1)
  })
})

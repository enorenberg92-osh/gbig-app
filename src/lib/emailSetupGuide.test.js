import { describe, expect, it } from 'vitest'
import { emailSetupGuide } from './emailSetupGuide'
import { emailSetupStatus } from '../../supabase/functions/_shared/weeklyEmail.mjs'

describe('email owner setup readiness', () => {
  it('never treats partial readiness or unknown checks as ready to send', () => {
    for (const storage of [true, false, null]) {
      for (const sender of [true, false, null]) {
        for (const serviceKey of [true, false]) {
          const result = emailSetupStatus({ storage, sender, serviceKey, accountId: 'verified-user', locationId: 'venue' })
          expect(result.configured).toBe(storage === true && sender === true && serviceKey)
          expect(result.account_id).toBe('verified-user')
          expect(result).not.toHaveProperty('apiKey')
          expect(result).not.toHaveProperty('domain_verified')
          expect(result).not.toHaveProperty('delivered')
        }
      }
    }
  })

  it('includes the verified signed-in ID without inferring an account from a sender address', () => {
    const guide = emailSetupGuide({ setup: { account_id: 'server-verified-id' }, venueSlug: 'gbig', locationId: 'green-bay-id', venueName: 'Green Bay Indoor Golf' })
    expect(guide.initialSender).toBe('trent@greenbayindoorgolf.com')
    expect(guide.domains).toEqual(['greenbayindoorgolf.com'])
    expect(guide.request).toContain('server-verified-id')
    expect(guide.request).toContain('green-bay-id')
    expect(guide.request).toContain('Do not infer account identity')
    expect(guide.request).toContain('obtain owner approval of that exact assignment')
  })

  it('keeps Appleton instructions separate from Green Bay', () => {
    const guide = emailSetupGuide({ venueSlug: 'appleton', locationId: 'appleton-id', venueName: 'Appleton Indoor Golf' })
    expect(guide.initialSender).toBe('jordan@appletonindoorgolf.com')
    expect(guide.domains).toEqual(['appletonindoorgolf.com'])
    expect(guide.request).not.toContain('trent@')
    expect(guide.accountId).toBe('')
    expect(guide.request).toContain('Not checked yet')
  })

  it('supports future venues with their own approved sender domains', () => {
    const guide = emailSetupGuide({ setup: { configured: true }, venueSlug: 'future', senders: [
      { from: 'Owner <owner@future.example>' }, { from: 'Staff <staff@future.example>' },
    ] })
    expect(guide.initialSender).toBe('')
    expect(guide.domains).toEqual(['future.example'])
    expect(guide.request).toContain('Choose an owner-approved sender')
    expect(guide.readiness).toEqual({ storage: true, sender: true, serviceKey: true })
  })

  it('preserves a failed check even when a stale configured flag says true', () => {
    const guide = emailSetupGuide({ setup: { configured: true, checks: { storage: false, service_key: false } } })
    expect(guide.readiness.storage).toBe(false)
    expect(guide.readiness.serviceKey).toBe(false)
    expect(guide.request).toContain('Any real test needs approval')
    expect(guide.request).toContain('Do not use the league audience')
  })
})

import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
vi.mock('../../lib/supabase', () => ({ supabase: { functions: { invoke: vi.fn() } } }))
import EmailSetupGuide from './EmailSetupGuide'

describe('guided in-app owner setup', () => {
  it('renders an actionable four-step guide with failed and unknown readiness', () => {
    const html = renderToStaticMarkup(<EmailSetupGuide locationId="venue" venueSlug="gbig" venueName="Green Bay Indoor Golf" setup={{ configured: false, checks: { storage: false, service_key: null } }}/>)
    expect(html).toContain('Email setup steps')
    expect(html).toContain('Step 1 of 4')
    expect(html).toContain('Action needed')
    expect(html).toContain('Not checked')
    expect(html).toContain('Refresh readiness')
    expect(html).toContain('Copy setup request')
    expect(html).toContain('Connect your existing Gmail account')
    expect(html).toContain('GMAIL_CLIENT_ID')
    expect(html).not.toContain('RESEND_API_KEY')
    expect(html).not.toContain('type="password"')
    expect(html).not.toContain('API key value')
  })

  it('collapses the guide for configured staff while retaining owner access', () => {
    const html = renderToStaticMarkup(<EmailSetupGuide setup={{ configured: true }}/>)
    expect(html).toContain('Owner setup')
    expect(html).not.toMatch(/class="email-setup-guide" open/)
  })
})

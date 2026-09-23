import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { brandHtml, slugFromHost, shortNameFor } from './brandHtml.js'

const INDEX = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')

describe('slugFromHost', () => {
  it('strips the -app suffix and ignores non-location hosts', () => {
    expect(slugFromHost('appleton-app.vercel.app')).toBe('appleton')
    expect(slugFromHost('gbig-app.vercel.app')).toBe('gbig')
    expect(slugFromHost('appleton.leagueapp.com:443')).toBe('appleton')
    expect(slugFromHost('localhost')).toBe(null)
    expect(slugFromHost('127.0.0.1')).toBe(null)
    expect(slugFromHost('www.example.com')).toBe(null)
  })
})

describe('brandHtml', () => {
  const appleton = { slug: 'appleton', name: 'Appleton Indoor Golf', primary_color: '#123abc', hasIcons: true }

  it('rebrands title, iOS name/icon, favicon and theme color', () => {
    const out = brandHtml(INDEX, appleton)
    expect(out).toContain('<title>Appleton Indoor Golf</title>')
    expect(out).toContain('name="apple-mobile-web-app-title" content="APPLETON"')
    expect(out).toContain('rel="apple-touch-icon" href="/branding/appleton-icon-apple.png"')
    expect(out).toContain('href="/branding/appleton-icon-192.png"')
    expect(out).toContain('name="theme-color" content="#123abc"')
    expect(out).not.toMatch(/Green Bay Indoor Golf|content="GBIG"|favicon\.svg|apple-touch-icon\.png/)
    // The app bundle and manifest links survive untouched.
    expect(out).toContain('/api/manifest')
    expect(out).toContain('/src/main.jsx')
  })

  it('keeps default icons when the location has no icon set, and escapes names', () => {
    const out = brandHtml(INDEX, { slug: 'newclub', name: 'Tee & <Shot>', primary_color: 'nope', hasIcons: false })
    expect(out).toContain('<title>Tee &amp; &lt;Shot&gt;</title>')
    expect(out).toContain('href="/apple-touch-icon.png"')
    expect(out).toContain('name="theme-color" content="#1b4332"')
  })

  it('uses the location name for long slugs on the home screen', () => {
    expect(shortNameFor('gbig', 'Green Bay Indoor Golf')).toBe('GBIG')
    expect(shortNameFor('fox-valley-indoor', 'Fox Valley')).toBe('Fox Valley')
  })
})

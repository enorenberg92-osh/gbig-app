import fs from 'node:fs'
import { describe, it, expect } from 'vitest'
import venueInstallPlugin from '../../scripts/venue-install-plugin.mjs'
import { installIconPath } from './installBranding.js'

const source = fs.readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
const routes = JSON.parse(fs.readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')).routes

function firstRoute(host, path) {
  for (const route of routes) {
    if (route.handle === 'filesystem') return 'filesystem'
    const match = path.match(new RegExp(`^(?:${route.src})$`))
    if (!match || route.has?.some(condition => !new RegExp(`^(?:${condition.value})$`).test(host))) continue
    return route.dest.replace(/\$(\d+)/g, (_, n) => match[Number(n)])
  }
}

describe('phone install metadata before JavaScript', () => {
  it('builds separate original HTML and real versioned artwork for both venues', () => {
    const bundle = { 'index.html': { type: 'asset', source } }
    const emitted = []
    venueInstallPlugin().generateBundle.call({ emitFile(asset) { emitted.push(asset) } }, {}, bundle)
    const htmlByVenue = { gbig: bundle['index.html'].source, appleton: emitted.find(a => a.fileName === 'appleton.html').source }
    for (const [slug, name] of [['gbig', 'Green Bay Indoor Golf'], ['appleton', 'Appleton Indoor Golf']]) {
      const html = htmlByVenue[slug]
      expect(html).toContain(`<title>${name}</title>`)
      expect(html).toContain(`name="apple-mobile-web-app-title" content="${name}"`)
      expect(html).toContain(`href="${installIconPath(slug, 'apple')}"`)
      expect(html).not.toContain('href="/apple-touch-icon.png"')
      const icon = emitted.find(a => a.fileName === installIconPath(slug, 'apple').slice(1))
      expect(icon.source.equals(fs.readFileSync(new URL(`../../public/branding/${slug}-icon-apple.png`, import.meta.url)))).toBe(true)
    }
    expect(htmlByVenue.appleton).not.toContain('Green Bay Indoor Golf')
  })

  it.each(['appleton-app.vercel.app', 'appleton-app-owner.vercel.app', 'appleton-preview-owner.vercel.app'])('serves Appleton root HTML before shared files on %s', host => {
    expect(firstRoute(host, '/')).toBe('/appleton.html')
    expect(firstRoute(host, '/index.html')).toBe('/appleton.html')
    expect(firstRoute(host, '/apple-touch-icon.png')).toBe(installIconPath('appleton', 'apple'))
    expect(firstRoute(host, '/apple-touch-icon-180x180-precomposed.png')).toBe(installIconPath('appleton', 'apple'))
    expect(firstRoute(host, '/icon-192.png')).toBe(installIconPath('appleton', '192'))
    expect(firstRoute(host, '/icon-512-maskable.png')).toBe(installIconPath('appleton', 'maskable'))
    expect(firstRoute(host, '/assets/app.js')).toBe('filesystem')
    expect(firstRoute(host, '/api/manifest')).toBe('filesystem')
  })

  it('keeps Green Bay root/icon assets and uses venue manifests for old installations', () => {
    expect(firstRoute('gbig-app.vercel.app', '/')).toBe('filesystem')
    expect(firstRoute('gbig-app.vercel.app', '/apple-touch-icon.png')).toBe('filesystem')
    expect(firstRoute('appleton-app.vercel.app', '/manifest.json')).toBe('/api/manifest')
    expect(firstRoute('gbig-app.vercel.app', '/manifest.json')).toBe('/api/manifest')
  })
})

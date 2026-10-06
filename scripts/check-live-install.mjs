import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { installIconPath } from '../src/lib/installBranding.js'

// Checks the response used by installers, not just the corrected running DOM.
// Public reads only; no login or database writes.
const results = []
const userAgents = {
  desktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
for (const [slug, name] of [['gbig', 'Green Bay Indoor Golf'], ['appleton', 'Appleton Indoor Golf']]) {
  const origin = `https://${slug}-app.vercel.app`
  for (const [device, userAgent] of Object.entries(userAgents)) {
    for (const path of ['/', '/league', '/index.html']) {
      const page = await fetch(origin + path, { headers: { 'User-Agent': userAgent }, cache: 'no-store' })
      assert.equal(page.status, 200, origin + path)
      const html = await page.text()
      assert.ok(html.includes(`<title>${name}</title>`), `${origin}${path} ${device}: incorrect original title`)
      assert.ok(html.includes(`name="apple-mobile-web-app-title" content="${name}"`))
      assert.ok(html.includes(`href="${installIconPath(slug, 'apple')}"`), `${origin}${path}: wrong install icon`)
      const bundle = html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1]
      assert.ok(bundle)
      assert.equal((await fetch(origin + bundle)).status, 200)
      results.push({ venue: slug, device, path, originalHtml: 'correct', bundle: 'loads' })
    }
  }
  for (const variant of ['apple', '192', '512', 'maskable']) {
    const asset = await fetch(origin + installIconPath(slug, variant))
    assert.equal(asset.status, 200)
    assert.ok(asset.headers.get('content-type')?.includes('image/png'))
    const actual = Buffer.from(await asset.arrayBuffer())
    const expected = fs.readFileSync(new URL(`../public/branding/${slug}-icon-${variant}.png`, import.meta.url))
    assert.equal(digest(actual), digest(expected), `${slug} ${variant}: wrong artwork`)
  }
  const legacyIcon = await fetch(origin + '/apple-touch-icon.png')
  assert.equal(legacyIcon.status, 200)
  assert.equal(digest(Buffer.from(await legacyIcon.arrayBuffer())), digest(fs.readFileSync(new URL(`../public/branding/${slug}-icon-apple.png`, import.meta.url))))
  for (const path of ['/api/manifest', '/manifest.json']) {
    const response = await fetch(origin + path)
    assert.equal(response.status, 200)
    const manifest = await response.json()
    assert.equal(manifest.name, name)
    assert.equal(manifest.id, '/')
    assert.ok(manifest.icons.every(icon => icon.src.startsWith(`/branding/${slug}-`) && icon.src.includes('20261006')))
  }
}
const receipt = { checked: new Date().toISOString(), passed: true, results, artwork: 'all deployed icons match venue source bytes', legacyIcons: 'correct venue', manifestIdentity: 'unchanged' }
fs.mkdirSync('artifacts', { recursive: true })
fs.writeFileSync('artifacts/live-install-branding.json', JSON.stringify(receipt, null, 2))
console.log(JSON.stringify(receipt))

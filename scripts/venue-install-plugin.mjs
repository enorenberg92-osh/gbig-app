import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { INSTALL_ICON_VARIANTS, installIconPath, venueInstallHtml } from '../src/lib/installBranding.js'

// Safari's install metadata must already be correct in the HTML response.
// Updating the DOM after boot isn't enough for every Home Screen installer.
export default function venueInstallPlugin() {
  return {
    name: 'venue-install-html',
    enforce: 'post',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url?.split('?')[0]
        for (const slug of ['gbig', 'appleton']) {
          for (const variant of INSTALL_ICON_VARIANTS) {
            if (pathname !== installIconPath(slug, variant)) continue
            res.setHeader('Content-Type', 'image/png')
            res.end(fs.readFileSync(new URL(`../public/branding/${slug}-icon-${variant}.png`, import.meta.url)))
            return
          }
        }
        next()
      })
    },
    generateBundle(_, bundle) {
      const entry = bundle['index.html']
      if (!entry || entry.type !== 'asset') throw new Error('Missing built app HTML')
      const source = String(entry.source)
      entry.source = venueInstallHtml(source, 'gbig')
      this.emitFile({ type: 'asset', fileName: 'appleton.html', source: venueInstallHtml(source, 'appleton') })
      for (const slug of ['gbig', 'appleton']) {
        for (const variant of INSTALL_ICON_VARIANTS) {
          const sourcePath = new URL(`../public/branding/${slug}-icon-${variant}.png`, import.meta.url)
          this.emitFile({ type: 'asset', fileName: installIconPath(slug, variant).slice(1), source: fs.readFileSync(fileURLToPath(sourcePath)) })
        }
      }
    },
  }
}

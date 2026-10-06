import { VENUES } from './locationIdentity.js'

// Change this when the install artwork changes. A new URL lets phone launchers
// fetch new artwork instead of reusing an icon from an earlier installation.
export const INSTALL_ICON_VERSION = '20261006'
export const INSTALL_ICON_VARIANTS = ['apple', '192', '512', 'maskable']

export function installIconPath(slug, variant) {
  return `/branding/${slug}-icon-${variant}${VENUES[slug] ? `-${INSTALL_ICON_VERSION}` : ''}.png`
}

export function venueInstallHtml(html, slug) {
  const venue = VENUES[slug]
  if (!venue) throw new Error(`Unknown install venue: ${slug}`)
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${venue.name}</title>`)
    .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*("\s*\/?>)/, `$1${venue.name}$2`)
    .replace(/(<link rel="apple-touch-icon"[^>]*href=")[^"]*("[^>]*>)/, `$1${installIconPath(slug, 'apple')}$2`)
    .replace(/<link rel="icon"[^>]*>/g, `<link rel="icon" type="image/png" sizes="192x192" href="${installIconPath(slug, '192')}" />`)
}

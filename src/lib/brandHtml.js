// Per-location HTML head branding, shared by the Vercel middleware.
// Every location is served the same built index.html; without this the
// title, iOS home-screen name/icon and theme color are GBIG's until the app
// boots and swaps them — too late for "Add to Home Screen" and the launch
// splash on another location's device.

/** Location slug for a hostname: first label, "-app" suffix stripped. */
export function slugFromHost(hostname) {
  const host = String(hostname || '').toLowerCase().split(':')[0]
  if (!host || host === 'localhost' || /^[\d.]+$/.test(host)) return null
  const label = host.split('.')[0].replace(/-app$/, '')
  if (!label || label === 'www' || !/^[a-z0-9-]+$/.test(label)) return null
  return label
}

/** Home-screen label: same rule as api/manifest.js short_name. */
export function shortNameFor(slug, name) {
  return slug.length <= 12 ? slug.toUpperCase() : name
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Rewrite the head of index.html for one location.
 * brand: { slug, name, primary_color, hasIcons }
 */
export function brandHtml(html, brand) {
  const name = escapeHtml(brand.name || brand.slug.toUpperCase())
  const shortName = escapeHtml(shortNameFor(brand.slug, brand.name || brand.slug))
  let out = html
    .replace(/<title>[^<]*<\/title>/i, `<title>${name}</title>`)
    .replace(
      /(<meta\s+name="apple-mobile-web-app-title"\s+content=")[^"]*(")/i,
      `$1${shortName}$2`,
    )
  if (/^#[0-9a-f]{6}$/i.test(brand.primary_color || '')) {
    out = out.replace(/(<meta\s+name="theme-color"\s+content=")[^"]*(")/i, `$1${brand.primary_color}$2`)
  }
  if (brand.hasIcons) {
    const icon = (size) => `/branding/${brand.slug}-icon-${size}.png`
    out = out
      .replace(/(<link\s+rel="apple-touch-icon"\s+href=")[^"]*(")/i, `$1${icon('apple')}$2`)
      .replace(
        /<link\s+rel="icon"\s+type="image\/png"[^>]*>/i,
        `<link rel="icon" type="image/png" sizes="192x192" href="${icon('192')}" />`,
      )
      // The SVG favicon outranks PNG in Chrome and is GBIG's mark.
      .replace(/\s*<link\s+rel="icon"\s+type="image\/svg\+xml"[^>]*>/i, '')
  }
  return out
}

// Vercel Routing Middleware — serves each location its own branded HTML head.
//
// One deployment serves every location (gbig-app.vercel.app,
// appleton-app.vercel.app, …) from the same index.html. Its static head is
// GBIG's, so an Appleton phone that installs or launches the app saw the
// Green Bay title, home-screen name and icon before the React boot swapped
// them. Here we rewrite the head per hostname before the first byte reaches
// the browser. Anything unexpected (unknown slug, lookup failure) falls
// through to the normal static index.html, so this can never break boot.

import { brandHtml, slugFromHost } from './src/lib/brandHtml.js'

export const config = {
  // Page navigations only: no API routes, built assets, branding files or
  // anything with a file extension (which also keeps /index.html below from
  // re-entering this middleware).
  matcher: ['/((?!api/|assets/|branding/|.*\\.[A-Za-z0-9]+$).*)'],
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://mtuzmasicpcxcvtslevm.supabase.co'
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im10dXptYXNpY3BjeGN2dHNsZXZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNzc1MDksImV4cCI6MjA5MDc1MzUwOX0.B6dlwPay4Lgv6t5C1y5xwxwTKzQjnWVJqWav4AAtCN0'

// Per-instance cache so most requests skip the lookups.
const TTL_MS = 5 * 60 * 1000
const brandCache = new Map()

async function lookupBrand(slug, origin) {
  const hit = brandCache.get(slug)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.brand

  const [locRes, iconRes] = await Promise.all([
    fetch(
      `${SUPABASE_URL}/rest/v1/location_public?slug=eq.${encodeURIComponent(slug)}&select=slug,name,primary_color`,
      { headers: { apikey: SUPABASE_ANON_KEY } },
    ).catch(() => null),
    fetch(`${origin}/branding/${slug}-icon-apple.png`, { method: 'HEAD' }).catch(() => null),
  ])
  if (!locRes?.ok) return null // transient: don't cache, fall through this time
  const loc = (await locRes.json())[0]
  const brand = loc ? { ...loc, hasIcons: !!iconRes?.ok } : null
  brandCache.set(slug, { brand, at: Date.now() })
  return brand
}

export default async function middleware(request) {
  const url = new URL(request.url)
  const slug = slugFromHost(url.hostname)
  if (!slug) return undefined

  try {
    const [brand, shell] = await Promise.all([
      lookupBrand(slug, url.origin),
      fetch(new URL('/index.html', url.origin)),
    ])
    if (!brand || !shell.ok) return undefined
    return new Response(brandHtml(await shell.text(), brand), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // The shell references hashed bundles; always revalidate it.
        'cache-control': 'no-cache',
      },
    })
  } catch {
    return undefined
  }
}

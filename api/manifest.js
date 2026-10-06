// Per-location PWA manifest (Vercel serverless function).
// The install prompt, home-screen name, and app icon come from here, so each
// location's installed app carries its own branding. The hostname's first
// label is the location slug (same rule as the client boot resolver); icon
// files follow the /branding/<slug>-icon-*.png convention created at
// location onboarding.

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://mtuzmasicpcxcvtslevm.supabase.co'
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY
  || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im10dXptYXNpY3BjeGN2dHNsZXZtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNzc1MDksImV4cCI6MjA5MDc1MzUwOX0.B6dlwPay4Lgv6t5C1y5xwxwTKzQjnWVJqWav4AAtCN0'

import { VENUES, hostSlug } from '../src/lib/locationIdentity.js'

export default async function handler(req, res) {
  // Same slug rule as the client boot resolver: first host label, "-app"
  // suffix stripped (gbig-app → gbig, appleton-app → appleton).
  const hostLabel = hostSlug(req.headers.host)
  let loc = null
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/location_public?slug=eq.${encodeURIComponent(hostLabel)}&select=slug,name,primary_color`,
      { headers: { apikey: SUPABASE_ANON_KEY }, signal: AbortSignal.timeout(3000) }
    )
    if (r.ok) loc = (await r.json())[0] || null
  } catch { /* fall through to defaults */ }
  const { slug, name, primary_color } = loc || VENUES[hostLabel] || { slug:'', name:'Golf League App', primary_color:'#1b4332' }

  res.setHeader('Content-Type', 'application/manifest+json')
  res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate')
  res.status(200).json({
    name,
    id: '/',
    scope: '/',
    short_name: slug ? slug.toUpperCase() : name,
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: primary_color,
    orientation: 'portrait',
    icons: [
      { src: slug ? `/branding/${slug}-icon-192.png` : '/icon-192.png', sizes:'192x192',type:'image/png',purpose:'any' },
      { src: slug ? `/branding/${slug}-icon-512.png` : '/icon-512.png', sizes:'512x512',type:'image/png',purpose:'any' },
      { src: slug ? `/branding/${slug}-icon-maskable.png` : '/icon-512-maskable.png', sizes:'512x512',type:'image/png',purpose:'maskable' },
    ],
  })
}

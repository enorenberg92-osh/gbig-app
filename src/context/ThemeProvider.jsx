import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useLocation } from './LocationContext'

// ── Color math ──────────────────────────────────────────────────────────────
// Convert a hex color to HSL so we can derive a full brand family (dark,
// light, xlight) from a single `primary_color` in the database. That way
// onboarding a new location is one DB value, not four.

function hexToHsl(hex) {
  const clean = hex.replace('#', '')
  const r = parseInt(clean.slice(0, 2), 16) / 255
  const g = parseInt(clean.slice(2, 4), 16) / 255
  const b = parseInt(clean.slice(4, 6), 16) / 255

  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l   = (max + min) / 2

  if (max === min) return [0, 0, l * 100]  // achromatic

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h
  switch (max) {
    case r: h = ((g - b) / d + (g < b ? 6 : 0)); break
    case g: h = ((b - r) / d + 2); break
    default: h = ((r - g) / d + 4); break
  }
  h = (h * 60) % 360
  return [h, s * 100, l * 100]
}

function hslToHex(h, s, l) {
  s /= 100
  l /= 100
  const k = n => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = n => {
    const v = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
    return Math.round(v * 255).toString(16).padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)) }

/**
 * Given a primary hex, derive the whole brand family.
 *   --green        → primary
 *   --green-dark   → ~15 points darker
 *   --green-light  → ~15 points lighter, saturation held
 *   --green-xlight → very light tint (for chips, backgrounds)
 */
export function deriveBrandPalette(primaryHex) {
  const [h, s, l] = hexToHsl(primaryHex)
  return {
    primary: primaryHex,
    // Dark accent — same hue/saturation, 15 points darker.
    dark:    hslToHex(h, s, clamp(l - 15, 5, 95)),
    // Light accent — same hue/saturation, 15 points lighter.
    light:   hslToHex(h, s, clamp(l + 15, 5, 85)),
    // Pale chip/badge background — hue preserved, saturation scaled to ~40%
    // of the primary, lightness pushed well into the 80–94 range. Formulas
    // were picked to stay visually close to the hand-tuned GBIG sage
    // (#d8f3dc) while also producing a coherent tint for any input hue.
    xlight:  hslToHex(h, clamp(s * 0.4, 10, 60), clamp(l + 55, 80, 94)),
  }
}

/**
 * Reads the current location's theme tokens from the `locations` row and
 * writes them onto `:root` as CSS custom properties. This runs once at
 * boot and then again only if `locationId` changes.
 *
 * Falls back silently to whatever is baked into index.css if the fetch
 * fails or primary_color is missing — nothing visual breaks.
 */
export function ThemeProvider({ children }) {
  const { locationId } = useLocation()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    if (!locationId) { setReady(true); return }
    let cancelled = false

    async function applyTheme() {
      const { data, error } = await supabase
        .from('locations')
        .select('primary_color')
        .eq('id', locationId)
        .maybeSingle()

      if (cancelled) return

      if (error) {
        console.warn('[ThemeProvider] Could not fetch theme:', error.message)
        setReady(true)
        return
      }

      const primary = data?.primary_color
      if (primary && /^#[0-9a-f]{6}$/i.test(primary)) {
        const palette = deriveBrandPalette(primary)
        const root = document.documentElement
        root.style.setProperty('--green',        palette.primary)
        root.style.setProperty('--green-dark',   palette.dark)
        root.style.setProperty('--green-light',  palette.light)
        root.style.setProperty('--green-xlight', palette.xlight)
      }

      setReady(true)
    }

    applyTheme()
    return () => { cancelled = true }
  }, [locationId])

  // Render children immediately — the splash screen already covers the brief
  // moment before the theme resolves, and the CSS defaults are correct for
  // GBIG regardless. Keeping this non-blocking means a slow network never
  // stalls the app.
  void ready
  return children
}

// ── Shared handicap calculation utility ───────────────────────────────────────
// Used by AdminHandicap (display/bulk) and AdminScores (auto-recalc after save).

export const DEFAULT_SETTINGS = {
  handicapPct: 0.90,
  scoresUsed:  12,
  minScores:   1,
  maxHandicap: 27,
}

// Discard rules per number of scores available (mirrors the league config screenshots)
export const DISCARD_TABLE = {
  1:  { high: 0, low: 0 },
  2:  { high: 0, low: 0 },
  3:  { high: 0, low: 0 },
  4:  { high: 1, low: 0 },
  5:  { high: 1, low: 1 },
  6:  { high: 1, low: 1 },
  7:  { high: 1, low: 1 },
  8:  { high: 1, low: 1 },
  9:  { high: 1, low: 1 },
  10: { high: 1, low: 1 },
  11: { high: 1, low: 1 },
  12: { high: 1, low: 1 },
}

// Core calculation: takes an array of differentials (gross - par), returns handicap integer.
export function calcHandicap(differentials, settings = DEFAULT_SETTINGS) {
  if (!differentials || differentials.length < settings.minScores) return null

  const recent = differentials.slice(-settings.scoresUsed)
  const n      = recent.length
  const rule   = DISCARD_TABLE[Math.min(n, 12)] || { high: 1, low: 1 }

  // Sort ascending: lowest diff first (best scores), highest last (worst scores)
  const sorted = [...recent].sort((a, b) => a - b)

  // Remove worst (high) and best (low) outliers per discard table
  let used = sorted
  if (rule.low  > 0) used = used.slice(rule.low)
  if (rule.high > 0) used = used.slice(0, used.length - rule.high)

  if (used.length === 0) return null

  const avg       = used.reduce((sum, d) => sum + d, 0) / used.length
  const raw       = avg * settings.handicapPct
  const truncated = Math.floor(raw)          // truncate, never round up
  return Math.min(Math.max(truncated, 0), settings.maxHandicap)
}

// Breakdown version — same math but returns all the intermediate steps for display.
export function calcBreakdown(differentials, settings = DEFAULT_SETTINGS) {
  if (!differentials || differentials.length < settings.minScores) return null

  const recent = differentials.slice(-settings.scoresUsed)
  const n      = recent.length
  const rule   = DISCARD_TABLE[Math.min(n, 12)] || { high: 1, low: 1 }
  const sorted = [...recent].sort((a, b) => a - b)
  const used   = sorted.slice(rule.low, rule.high > 0 ? sorted.length - rule.high : undefined)

  const avg       = used.length ? used.reduce((s, d) => s + d, 0) / used.length : 0
  const raw       = avg * settings.handicapPct
  const truncated = Math.floor(raw)
  const capped    = Math.min(Math.max(truncated, 0), settings.maxHandicap)

  return { n, rule, sorted, used, avg, raw, capped }
}

// ── One-shot recalc for a single player ───────────────────────────────────────
// Fetches their score history, recalculates, and writes back to DB if changed.
// Safe to call silently — never throws, returns { updated, newHcp } or { skipped }.
export async function recalcPlayerHandicap(supabase, playerId, locationId, settings = DEFAULT_SETTINGS) {
  try {
    // Check if player exists and isn't locked
    const { data: player } = await supabase
      .from('players')
      .select('id, handicap, handicap_locked')
      .eq('id', playerId)
      .eq('location_id', locationId)
      .maybeSingle()

    if (!player || player.handicap_locked) return { skipped: true }

    // Load all their scores with course par info
    const { data: scores } = await supabase
      .from('scores')
      .select('gross_total, events(courses(hole_pars))')
      .eq('player_id', playerId)
      .eq('location_id', locationId)
      .not('gross_total', 'is', null)
      .order('created_at', { ascending: true })

    const diffs = (scores || [])
      .map(s => {
        const holePars  = s.events?.courses?.hole_pars
        const coursePar = holePars ? holePars.reduce((sum, p) => sum + p, 0) : null
        return coursePar != null ? s.gross_total - coursePar : null
      })
      .filter(d => d != null)

    const newHcp = calcHandicap(diffs, settings)
    if (newHcp == null) return { skipped: true }

    // Only write if the value actually changed
    if (newHcp === player.handicap) return { skipped: true, newHcp }

    await supabase.from('players').update({ handicap: newHcp }).eq('id', playerId)
    return { updated: true, newHcp, oldHcp: player.handicap }

  } catch (e) {
    console.warn(`recalcPlayerHandicap(${playerId}) failed:`, e)
    return { skipped: true }
  }
}

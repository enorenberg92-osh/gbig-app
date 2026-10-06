// ── Shared handicap calculation utility ───────────────────────────────────────
// Used by AdminHandicap (display/bulk) and AdminScores (auto-recalc after save).
import { compareRoundsChronologically } from './roundUtils'

// Core rules for GBIG's default league. The `minHandicap`/`maxHandicap` bounds
// are a hard clamp after truncation — a scratch or plus golfer caps at -2, a
// 30-handicap plays off 27. If you want different ranges for a future league,
// pass a custom settings object into calcHandicap/calcBreakdown; nothing here
// is hardcoded beyond the defaults.
export const DEFAULT_SETTINGS = {
  handicapPct: 0.90,
  scoresUsed:  12,
  minScores:   1,
  minHandicap: -2,
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

// Match server format exclusions before selecting the recent history window.
export function handicapRounds(scores) {
  return [...(scores || [])].filter(s => {
    const event = s.events
    const override = event?.format_config?.exclude_from_handicap
    const excluded = override == null ? event?.format === 'scramble' : override === true || override === 'true'
    return s.status === 'verified' && s.entry_type === 'played' && !s.sub_played &&
      s.gross_total != null && event?.courses?.total_par != null && !excluded
  }).sort(compareRoundsChronologically)
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
  // Clamp to [minHandicap, maxHandicap]. Previously floored at 0, which
  // silently capped scratch/plus golfers to 0 and violated the -2 to 27 spec.
  const floor = settings.minHandicap ?? -2
  const ceil  = settings.maxHandicap ?? 27
  return Math.min(Math.max(truncated, floor), ceil)
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
  // Same clamp rule as calcHandicap — [minHandicap, maxHandicap], default -2..27.
  const floor     = settings.minHandicap ?? -2
  const ceil      = settings.maxHandicap ?? 27
  const capped    = Math.min(Math.max(truncated, floor), ceil)

  return { n, rule, sorted, used, avg, raw, capped }
}

// ── One-shot recalc for a single player ───────────────────────────────────────
// The server applies venue permissions, locks, history and format rules.
// Never skip the authoritative calculation based on a client-side prediction.
export async function recalcPlayerHandicap(supabase, playerId) {
  try {
    const { data: recalcResult, error: recalcErr } = await supabase.rpc('recalculate_player_handicap', { p_player_id: playerId })
    if (recalcErr) throw recalcErr
    return recalcResult || { skipped: true }

  } catch (e) {
    console.warn(`recalcPlayerHandicap(${playerId}) failed:`, e)
    return { skipped: true, error: e }
  }
}

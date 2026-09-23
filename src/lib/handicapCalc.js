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

// Server parity (recalculate_handicaps): the league's num_weeks (NULL → 12),
// at least 1.
export function scoresUsedForLeague(numWeeks) {
  const n = numWeeks == null || numWeeks === '' ? 12 : Math.trunc(Number(numWeeks))
  if (!Number.isFinite(n)) return 12
  return Math.max(1, n)
}

// Server parity: an event feeds handicaps unless format_config says
// exclude_from_handicap=true; when the flag is absent, scrambles are excluded
// (a shared ball says nothing about one player's game).
export function isHandicapEligibleEvent(evt) {
  if (!evt) return true
  const flag = evt.format_config?.exclude_from_handicap
  if (flag != null) return !(flag === true || flag === 'true')
  return evt.format !== 'scramble'
}

// Subs (players.is_sub) get a wider ceiling server-side: -2..40.
export const SUB_MAX_HANDICAP = 40
export function settingsForPlayer(settings, player) {
  return player?.is_sub ? { ...settings, maxHandicap: SUB_MAX_HANDICAP } : settings
}

// floor(avg × pct) computed exactly in integers — floor(sum × 9 / (n × 10))
// for 90% — like the server. `Math.floor(avg * 0.9)` drifts on float error
// (e.g. sum -50 over 3 rounds: exact -15, float -16).
function truncatedHandicap(used, pct) {
  const sum   = used.reduce((a, d) => a + d, 0)
  const scale = 1000
  const pctInt = Math.round(pct * scale)
  return Math.floor((sum * pctInt) / (used.length * scale))
}

// Core calculation: takes an array of differentials (gross - par) in
// chronological order (oldest first), returns handicap integer.
export function calcHandicap(differentials, settings = DEFAULT_SETTINGS) {
  return calcBreakdown(differentials, settings)?.capped ?? null
}

// Breakdown version — same math but returns all the intermediate steps for display.
export function calcBreakdown(differentials, settings = DEFAULT_SETTINGS) {
  if (!differentials || differentials.length < settings.minScores) return null

  const recent = differentials.slice(-settings.scoresUsed)
  const n      = recent.length
  const rule   = DISCARD_TABLE[Math.min(n, 12)] || { high: 1, low: 1 }
  // Sort ascending: lowest diff first (best scores), highest last (worst scores),
  // then remove best (low) and worst (high) outliers per the discard table.
  const sorted = [...recent].sort((a, b) => a - b)
  const used   = sorted.slice(rule.low, rule.high > 0 ? sorted.length - rule.high : undefined)
  if (used.length === 0) return null

  const avg       = used.reduce((s, d) => s + d, 0) / used.length
  const raw       = avg * settings.handicapPct          // display only
  const truncated = truncatedHandicap(used, settings.handicapPct) // never rounds up
  // Clamp to [minHandicap, maxHandicap], default -2..27 (subs: -2..40).
  const floor     = settings.minHandicap ?? -2
  const ceil      = settings.maxHandicap ?? 27
  const capped    = Math.min(Math.max(truncated, floor), ceil)

  return { n, rule, sorted, used, avg, raw, truncated, capped }
}

// Turns raw score rows (with joined `events(..., courses(total_par, hole_pars))`)
// into the chronological handicap history the server would use: verified,
// played, non-sub rounds with a gross, from handicap-eligible events, oldest
// first by event date. Each row gets `par` and `diff` (gross − course par).
export function handicapRounds(scoreRows) {
  return (scoreRows || [])
    .filter(s =>
      (s.entry_type == null || s.entry_type === 'played') &&
      (s.status == null || s.status === 'verified') &&
      !s.sub_played &&
      s.gross_total != null &&
      isHandicapEligibleEvent(s.events))
    .map(s => {
      const course = s.events?.courses
      const par = course?.total_par ?? (Array.isArray(course?.hole_pars)
        ? course.hole_pars.reduce((sum, p) => sum + p, 0)
        : null)
      return { ...s, par, diff: par != null ? s.gross_total - par : null }
    })
    .filter(s => s.diff != null)
    .sort(compareRoundsChronologically)
}

// ── One-shot recalc for a single player ───────────────────────────────────────
// Fetches their score history, recalculates, and writes back to DB if changed.
// Safe to call silently — never throws, returns { updated, newHcp } or { skipped }.
export async function recalcPlayerHandicap(supabase, playerId, locationId, settings = DEFAULT_SETTINGS) {
  try {
    // Check if player exists and isn't locked
    const { data: player } = await supabase
      .from('players')
      .select('id, handicap, handicap_locked, is_sub')
      .eq('id', playerId)
      .eq('location_id', locationId)
      .maybeSingle()

    if (!player || player.handicap_locked) return { skipped: true }

    // Load their scores with event date/format + course par; handicapRounds
    // applies the server's eligibility rules and event-date ordering so
    // `calcHandicap`'s `.slice(-scoresUsed)` picks the most recent N.
    // sub_played NULL counts as false (legacy rows) — `.eq(false)` would drop them.
    const { data: scores } = await supabase
      .from('scores')
      .select('id, gross_total, entry_type, status, sub_played, created_at, events(week_number, start_date, event_date, format, format_config, courses(total_par, hole_pars))')
      .eq('player_id', playerId)
      .eq('location_id', locationId)
      .eq('entry_type', 'played')
      .eq('status', 'verified')
      .or('sub_played.is.null,sub_played.eq.false')
      .not('gross_total', 'is', null)

    const diffs = handicapRounds(scores).map(r => r.diff)

    const newHcp = calcHandicap(diffs, settingsForPlayer(settings, player))
    if (newHcp == null) return { skipped: true }

    // Only write if the value actually changed
    if (newHcp === player.handicap) return { skipped: true, newHcp }

    const { data: recalcResult, error: recalcErr } = await supabase.rpc('recalculate_player_handicap', { p_player_id: playerId })
    if (recalcErr) throw recalcErr
    return recalcResult || { updated: true, newHcp, oldHcp: player.handicap }

  } catch (e) {
    console.warn(`recalcPlayerHandicap(${playerId}) failed:`, e)
    return { skipped: true }
  }
}

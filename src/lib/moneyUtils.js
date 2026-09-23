// ── Ledger (money list) helpers ────────────────────────────────────────────
// Sign convention (enforced by admin_add_ledger_entries): positive = credit
// to the player/team, negative = money out / owed to the league.

// Types whose amount must be ≤ 0 or ≥ 0; 'adjustment' may be either sign.
export const NEGATIVE_TYPES = ['entry_fee', 'payout']
export const POSITIVE_TYPES = ['skins', 'match_points', 'event_prize']

/** -1, +1, or 0 (free) for a ledger type. */
export function typeSign(type) {
  if (NEGATIVE_TYPES.includes(type)) return -1
  if (POSITIVE_TYPES.includes(type)) return 1
  return 0
}

/** Round to cents, avoiding float drift like 3 × 0.1 = 0.30000000000000004. */
export function roundCents(x) {
  return Math.round((Number(x) + Number.EPSILON) * 100) / 100
}

/**
 * The amount to store for a manual entry: fixed-sign types take the magnitude
 * the admin typed and get the right sign; adjustments keep what was typed.
 * Returns NaN for non-numeric input.
 */
export function signedAmount(type, raw) {
  const n = roundCents(parseFloat(raw))
  if (!Number.isFinite(n)) return NaN
  const sign = typeSign(type)
  return sign === 0 ? n : sign * Math.abs(n)
}

/** A balance this close to zero is settled (float residue, not money). */
export function isSettled(amount) {
  return Math.abs(amount) < 0.005
}

/** Stable key for who an entry belongs to: `p:<player_id>` or `t:<team_id>`. */
export function ledgerWhoKey(entry) {
  return entry.player_id ? `p:${entry.player_id}` : `t:${entry.team_id}`
}

/**
 * Net balance per player/team, keyed by id (display names can collide).
 * Returns [{ key, playerId, teamId, amt }] with amounts rounded to cents,
 * settled balances dropped, largest credit first.
 */
export function ledgerBalances(entries) {
  const byKey = {}
  ;(entries || []).forEach(e => {
    const key = ledgerWhoKey(e)
    if (!byKey[key]) byKey[key] = { key, playerId: e.player_id || null, teamId: e.player_id ? null : (e.team_id || null), amt: 0 }
    byKey[key].amt += Number(e.amount) || 0
  })
  return Object.values(byKey)
    .map(b => ({ ...b, amt: roundCents(b.amt) }))
    .filter(b => !isSettled(b.amt))
    .sort((a, b) => b.amt - a.amt)
}

/**
 * Flags suggestions that already exist in the ledger for the same event, type
 * and player/team, so a week's skins/points can't be added twice. Duplicates
 * come back with `duplicate: true` and `include: false`.
 */
export function markDuplicateSuggestions(suggestions, ledgerRows) {
  const existing = new Set((ledgerRows || [])
    .filter(e => e.event_id)
    .map(e => `${e.event_id}|${e.type}|${ledgerWhoKey(e)}`))
  return (suggestions || []).map(s => {
    const dup = existing.has(`${s.event_id}|${s.type}|${ledgerWhoKey(s)}`)
    return dup ? { ...s, duplicate: true, include: false } : s
  })
}

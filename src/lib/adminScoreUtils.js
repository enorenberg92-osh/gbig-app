// ── Admin score-entry helpers ──────────────────────────────────────────────
// Pure logic behind AdminScores' team editor, kept here so it can be tested.

/**
 * Classifies one player's hole-by-hole grid from the admin editor.
 *   'blank'    — every hole empty: nothing to save for this player
 *   'complete' — every hole a whole number 1..20: `holes` is the int array
 *   'invalid'  — partially filled or out of range
 */
export function classifyHoleGrid(values, holeCount) {
  const raw = Array.from({ length: holeCount }, (_, i) => values?.[i])
  const isEmpty = v => v == null || String(v).trim() === ''
  if (raw.every(isEmpty)) return { status: 'blank', holes: null }
  const holes = raw.map(v => (isEmpty(v) ? null : Number(v)))
  const valid = holes.every(h => Number.isInteger(h) && h >= 1 && h <= 20)
  return valid ? { status: 'complete', holes } : { status: 'invalid', holes: null }
}

/**
 * The handicap a saved row should carry. Editing an existing round keeps the
 * handicap it was originally played off — re-sending today's handicap would
 * rewrite historic net scores. Only brand-new rows use the current handicap
 * (or the approved sub's). A missed-week penalty being replaced by a real
 * round keeps the penalty's handicap (the player's at publish time) unless a
 * sub played, in which case the sub's handicap applies.
 */
export function resolveHandicapUsed(existingScore, player, sub) {
  const current = sub != null ? (sub.sub_handicap || 0) : (player?.handicap || 0)
  const kept = existingScore?.handicap_used
  if (kept != null && existingScore) {
    const isPenalty = existingScore.entry_type === 'missed_penalty'
    if (!isPenalty || sub == null) return Math.round(Number(kept))
  }
  return Math.round(current)
}

// ── Shared score display utilities ─────────────────────────────────────────
// Used by ScoreEntry (player hole-by-hole input) and AdminScores (admin view).

/**
 * Returns the text color for a score relative to par.
 *   Eagle or better → gold
 *   Birdie          → red
 *   Par             → green
 *   Bogey or worse  → default black
 */
export function scoreColor(score, par) {
  if (!score || !par) return 'var(--black)'
  const diff = score - par
  if (diff <= -2) return 'var(--score-eagle)'   // eagle or better — gold
  if (diff === -1) return 'var(--score-birdie)' // birdie — red
  if (diff === 0)  return 'var(--score-par)'    // par — green
  return 'var(--black)'                         // bogey or worse — black
}

/**
 * Returns the background fill color for a score box relative to par.
 *   Eagle or better → light gold
 *   Birdie          → light red
 *   Par             → light green
 *   Bogey or worse  → transparent
 */
export function scoreBg(score, par) {
  if (!score || !par) return 'transparent'
  const diff = score - par
  if (diff <= -2) return 'var(--score-eagle-bg)'   // eagle — light gold
  if (diff === -1) return 'var(--score-birdie-bg)' // birdie — light red
  if (diff === 0)  return 'var(--score-par-bg)'    // par — light green
  return 'transparent'                             // bogey+ — no background
}

/**
 * Converts a vs-par number to a display string.
 *   0  → 'E'
 *   +n → '+n'
 *   -n → '-n'
 */
export function vsParLabel(diff) {
  if (diff === null || diff === undefined) return ''
  if (diff === 0) return 'E'
  return diff > 0 ? `+${diff}` : `${diff}`
}

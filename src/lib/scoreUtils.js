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
  if (diff <= -2) return '#b8860b'   // eagle or better — gold
  if (diff === -1) return '#dc2626'  // birdie — red
  if (diff === 0)  return '#16a34a'  // par — green
  return 'var(--black)'              // bogey or worse — black
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
  if (diff <= -2) return '#fef9c3'   // eagle — light gold
  if (diff === -1) return '#fee2e2'  // birdie — light red
  if (diff === 0)  return '#dcfce7'  // par — light green
  return 'transparent'               // bogey+ — no background
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

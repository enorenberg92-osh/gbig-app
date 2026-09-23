// Skins: for each hole, the lowest score wins iff exactly one player shot it.
// No carryovers — each hole independent. playerScoreMap: { playerId: [h1..hN] }.
// Returns { holeNumber(1-indexed): winnerPlayerId | null }.
export function calcSkins(playerScoreMap, numHoles) {
  const entries = Object.entries(playerScoreMap)
  const skins = {}

  for (let hole = 0; hole < numHoles; hole++) {
    const holeScores = entries
      .map(([pid, scores]) => ({ pid, score: scores[hole] }))
      .filter(x => x.score != null && x.score > 0)

    if (holeScores.length === 0) { skins[hole + 1] = null; continue }

    const min = Math.min(...holeScores.map(x => x.score))
    const winners = holeScores.filter(x => x.score === min)
    skins[hole + 1] = winners.length === 1 ? winners[0].pid : null // null = tie
  }
  return skins
}

// Sub-played marker rows (sub_played=true) hold the SUB's holes on the absent
// player's row — they must never win skins under that player's name. NULL
// counts as false (legacy rows), so use this PostgREST filter via
// `query.or(NOT_SUB_PLAYED)` rather than `.eq('sub_played', false)`.
export const NOT_SUB_PLAYED = 'sub_played.is.null,sub_played.eq.false'

// Client-side twin of the query filters: a verified, played, non-sub row with
// hole scores. Missing entry_type/status count as played/verified (legacy).
export function isSkinsEligibleScore(score) {
  return !!score &&
    (score.entry_type == null || score.entry_type === 'played') &&
    (score.status == null || score.status === 'verified') &&
    !score.sub_played &&
    Array.isArray(score.hole_scores)
}

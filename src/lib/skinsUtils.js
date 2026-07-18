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

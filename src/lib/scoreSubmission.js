export const PLAYER_KEYS = ['p1', 'p2']

// Server submissions win over any device-local draft, independently per golfer.
export function unsubmittedDraft(context, draft, submitted = {}) {
  const scores = {}, stats = {}
  PLAYER_KEYS.forEach((pk, index) => {
    const saved = !submitted[context.playerIds[index]]
    scores[pk] = saved && draft?.scores?.[pk] || Array(context.numHoles).fill(null)
    stats[pk] = saved && draft?.stats?.[pk] || Array.from({ length: context.numHoles }, () => ({}))
  })
  return { scores, stats }
}

export function scorecardComplete(values, numHoles) {
  return Array.isArray(values) && values.length === numHoles &&
    values.every(value => Number.isInteger(value) && value >= 1 && value <= 20)
}

export function submittedByPlayer(rows) {
  return Object.fromEntries(rows.map(row => [row.player_id, row]))
}

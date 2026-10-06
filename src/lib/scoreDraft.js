// Device-local drafts only. Submitted scores remain authoritative in Supabase.
const PREFIX = 'golf:score-draft:v1:'

export function scoreDraftKey(context) {
  return PREFIX + JSON.stringify([
    context.userId, context.locationId, context.leagueId, context.eventId, context.teamId,
  ])
}

function courseSignature(context) {
  return JSON.stringify([context.courseId, context.numHoles, context.startHole, context.holePars])
}

function validScores(values, count) {
  return Array.isArray(values) && values.length === count &&
    values.every(value => value === null || (Number.isInteger(value) && value >= 1 && value <= 20))
}

function validStats(values, count) {
  return Array.isArray(values) && values.length === count && values.every(hole =>
    hole && typeof hole === 'object' && !Array.isArray(hole) &&
    (hole.putts == null || (Number.isInteger(hole.putts) && hole.putts >= 0 && hole.putts <= 10)) &&
    (hole.fir == null || typeof hole.fir === 'boolean') &&
    (hole.gir == null || typeof hole.gir === 'boolean'),
  )
}

export function readScoreDraft(context, storage) {
  try {
    storage ??= window.localStorage
    const raw = storage.getItem(scoreDraftKey(context))
    if (!raw) return { status: 'empty' }
    const saved = JSON.parse(raw)
    if (saved?.version !== 1 || saved.course !== courseSignature(context) ||
        !Array.isArray(saved.playerIds) || saved.playerIds.length !== 2 ||
        new Set(saved.playerIds).size !== 2 ||
        !context.playerIds.every(id => saved.playerIds.includes(id)) ||
        !Array.isArray(saved.players) || saved.players.length !== 2 ||
        !saved.players.every(player => player && validScores(player.scores, context.numHoles) && validStats(player.stats, context.numHoles)) ||
        !Number.isInteger(saved.currentHole) || saved.currentHole < 0 || saved.currentHole >= context.numHoles ||
        typeof saved.showStats !== 'boolean') {
      return { status: 'incompatible' }
    }
    // Roster query order can change. Match by player ID, never by array slot.
    const players = context.playerIds.map(id => saved.players[saved.playerIds.indexOf(id)])
    return {
      status: 'restored',
      scores: { p1: players[0].scores, p2: players[1].scores },
      stats: { p1: players[0].stats, p2: players[1].stats },
      currentHole: saved.currentHole,
      showStats: saved.showStats,
    }
  } catch (error) {
    return { status: error instanceof SyntaxError ? 'incompatible' : 'unavailable' }
  }
}

export function saveScoreDraft(context, draft, storage) {
  try {
    storage ??= window.localStorage
    const hasProgress = ['p1', 'p2'].some(pk =>
      draft.scores[pk]?.some(value => value != null) ||
      draft.stats[pk]?.some(hole => hole.putts != null || hole.fir != null || hole.gir != null),
    )
    if (!hasProgress) return 'empty'
    storage.setItem(scoreDraftKey(context), JSON.stringify({
      version: 1,
      course: courseSignature(context),
      playerIds: context.playerIds,
      players: ['p1', 'p2'].map(pk => ({ scores: draft.scores[pk], stats: draft.stats[pk] })),
      currentHole: draft.currentHole,
      showStats: draft.showStats,
      updatedAt: Date.now(),
    }))
    return 'saved'
  } catch {
    return 'unavailable'
  }
}

export function clearScoreDraft(context, storage) {
  try {
    storage ??= window.localStorage
    storage.removeItem(scoreDraftKey(context))
  } catch {
    // If deletion is blocked, the server submission check still prevents restore.
  }
}

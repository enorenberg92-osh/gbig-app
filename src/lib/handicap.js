/**
 * GBIG Handicap Calculation Engine
 *
 * Rules (exactly as configured by admin):
 *   - Based on the most recent 12 rounds played in league only
 *   - Minimum 1 score needed before a handicap is calculated
 *   - Handicap % = 90%
 *   - Discard rules:
 *       1–3 scores  → use all, discard nothing
 *       4 scores    → discard the 1 highest
 *       5–12 scores → discard 1 highest AND 1 lowest
 *   - Rounding: TRUNCATE (floor), never round up
 *   - Max handicap: 27
 *   - Tee adjustment: finalHandicap = handicap + (scratchPar - coursePar)
 *
 * Score inputs are DIFFERENTIALS (gross - course par for that round).
 * e.g. player shoots 46 on a par-36 course → differential = 10
 */

const HANDICAP_PERCENT = 0.90
const MAX_HANDICAP     = 27
const MAX_SCORES_USED  = 12

/**
 * Calculate a player's handicap from their score history.
 *
 * @param {number[]} differentials   Array of (gross - par) values, oldest first
 * @param {number}   scratchPar      Par for scratch (default 36 for 9-hole)
 * @param {number}   coursePar       Par for the course being played (default 36)
 * @returns {number|null}            Calculated handicap, or null if no scores
 */
export function calculateHandicap(differentials, scratchPar = 36, coursePar = 36) {
  if (!differentials || differentials.length === 0) return null

  // Use only the most recent 12
  const recent = differentials.slice(-MAX_SCORES_USED)
  const n = recent.length

  // Sort a copy for discard logic (ascending = lowest first)
  const sorted = [...recent].sort((a, b) => a - b)

  let working
  if (n <= 3) {
    working = sorted                        // use all
  } else if (n === 4) {
    working = sorted.slice(0, 3)            // drop the 1 highest
  } else {
    working = sorted.slice(1, sorted.length - 1) // drop lowest AND highest
  }

  const avg = working.reduce((sum, d) => sum + d, 0) / working.length
  const raw = avg * HANDICAP_PERCENT + (scratchPar - coursePar)

  // Truncate (Math.trunc handles negatives correctly too)
  const handicap = Math.trunc(raw)

  return Math.min(handicap, MAX_HANDICAP)
}

/**
 * Given a player's scores (gross) and the par for each round,
 * compute the differentials array, then return the handicap.
 *
 * @param {Array<{gross: number, course_par: number}>} rounds
 * @param {number} scratchPar
 * @param {number} coursePar  (current course being played)
 * @returns {number|null}
 */
export function calculateHandicapFromRounds(rounds, scratchPar = 36, coursePar = 36) {
  if (!rounds || rounds.length === 0) return null
  const differentials = rounds.map(r => r.gross - r.course_par)
  return calculateHandicap(differentials, scratchPar, coursePar)
}

/**
 * Recalculate and update handicap in Supabase for a given player
 * after a new score has been posted.
 *
 * @param {object} supabase   Supabase client
 * @param {string} playerId
 * @param {string} eventId    The event just completed (for history record)
 * @returns {number|null}     The new handicap, or null if insufficient data
 */
export async function recalculateAndSaveHandicap(supabase, playerId, eventId) {
  // Fetch all scores for this player, ordered oldest first
  const { data: scores, error } = await supabase
    .from('scores')
    .select('gross_score, events(courses(total_par))')
    .eq('player_id', playerId)
    .order('created_at', { ascending: true })

  if (error || !scores?.length) return null

  // Build rounds array: {gross, course_par}
  const rounds = scores
    .filter(s => s.gross_score != null)
    .map(s => ({
      gross:      s.gross_score,
      course_par: s.events?.courses?.total_par ?? 36,
    }))

  const newHandicap = calculateHandicapFromRounds(rounds)
  if (newHandicap === null) return null

  // Save to handicap_history
  await supabase.from('handicap_history').insert({
    player_id:    playerId,
    event_id:     eventId,
    handicap:     newHandicap,
    scores_used:  Math.min(rounds.length, MAX_SCORES_USED),
    calculated_at: new Date().toISOString(),
  })

  // Update current handicap on player record
  await supabase
    .from('players')
    .update({ handicap: newHandicap })
    .eq('id', playerId)

  return newHandicap
}

/**
 * Show the working of a handicap calculation — useful for the admin
 * "how was this calculated?" view.
 *
 * @param {number[]} differentials
 * @returns {object} Detailed breakdown
 */
export function explainHandicap(differentials) {
  if (!differentials || differentials.length === 0) {
    return { handicap: null, explanation: 'No scores on record.' }
  }

  const recent = differentials.slice(-MAX_SCORES_USED)
  const n = recent.length
  const sorted = [...recent].sort((a, b) => a - b)

  let working, discardNote
  if (n <= 3) {
    working     = sorted
    discardNote = 'Using all scores (fewer than 4 rounds)'
  } else if (n === 4) {
    working     = sorted.slice(0, 3)
    discardNote = 'Dropped 1 highest score'
  } else {
    working     = sorted.slice(1, sorted.length - 1)
    discardNote = 'Dropped 1 highest and 1 lowest score'
  }

  const avg      = working.reduce((s, d) => s + d, 0) / working.length
  const raw      = avg * HANDICAP_PERCENT
  const handicap = Math.min(Math.trunc(raw), MAX_HANDICAP)
  const capped   = handicap === MAX_HANDICAP && Math.trunc(raw) > MAX_HANDICAP

  return {
    handicap,
    scoresUsed:   n,
    sorted,
    working,
    discardNote,
    average:      Math.round(avg * 100) / 100,
    timesNinetyPct: Math.round(raw * 100) / 100,
    truncated:    Math.trunc(raw),
    capped,
    explanation: [
      `${n} score${n !== 1 ? 's' : ''} on record (using last ${Math.min(n, MAX_SCORES_USED)})`,
      discardNote,
      `Average differential: ${avg.toFixed(2)}`,
      `× 90% = ${raw.toFixed(2)}`,
      `Truncated = ${Math.trunc(raw)}`,
      capped ? `Capped at max handicap of ${MAX_HANDICAP}` : null,
      `Final handicap: ${handicap}`,
    ].filter(Boolean),
  }
}

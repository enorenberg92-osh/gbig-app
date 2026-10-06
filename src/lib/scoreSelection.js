import { compareEffectiveScores } from './roundUtils.js'

// A covered roster slot is the league result. The substitute's own copy is
// handicap history, and must not enter standings or skins a second time.
export function rosterScores(scores, roster) {
  const slots = new Map(roster.map(r => [`${r.event_id ?? ''}:${r.player_id}`, r.team_id]))
  const selected = new Map()
  for (const score of [...scores].filter(s => s.status === 'verified').sort(compareEffectiveScores)) {
    const key = `${score.event_id ?? ''}:${score.player_id}`
    if (!slots.has(key) || selected.has(key)) continue
    selected.set(key, { ...score, team_id: slots.get(key) })
  }
  return [...selected.values()]
}

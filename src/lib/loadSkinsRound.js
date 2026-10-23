import { fetchAllRows } from './fetchAllRows.js'
import { hasCompleteCoursePars } from './holeUtils.js'
import { skinScoreRows, calcSkins } from './skinsUtils.js'

async function checked(query) {
  const result = await query
  if (result.error) throw result.error
  return result.data
}

export async function loadSeasonSkinsEnrollments(supabase, leagueId, locationId) {
  if (!leagueId) throw new Error('Choose a league before loading skins enrollment.')
  return checked(fetchAllRows(() => supabase.from('league_skins_enrollments')
    .select('player_id, enrolled').eq('league_id', leagueId).eq('location_id', locationId).order('player_id')))
}

export async function withSeasonSkinsEnrollment(supabase, leagueId, locationId, players) {
  const enrollments = await loadSeasonSkinsEnrollments(supabase, leagueId, locationId)
  const enrolledIds = new Set((enrollments || []).filter(row => row.enrolled).map(row => row.player_id))
  return players.map(player => ({ ...player, in_skins: enrolledIds.has(player.id) }))
}

export async function loadSkinsRound(supabase, eventId, locationId) {
  const event = await checked(supabase.from('events').select('id, league_id, courses(id, num_holes, hole_pars, total_par, start_hole)')
    .eq('id', eventId).eq('location_id', locationId).single())
  const course = event?.courses
  if (!hasCompleteCoursePars(course) || course.total_par !== course.hole_pars.reduce((a,b) => a+b, 0)) {
    throw new Error('Assign a course with complete pars and matching total par before calculating skins.')
  }
  const [scores, players, roster] = await Promise.all([
    checked(fetchAllRows(() => supabase.from('scores').select('id, event_id, player_id, hole_scores, gross_total, net_total, entry_type, status, created_at')
      .eq('event_id', eventId).eq('location_id', locationId).eq('status', 'verified').order('id'))),
    checked(fetchAllRows(() => supabase.from('players').select('id, name')
      .eq('location_id', locationId).order('id'))),
    checked(fetchAllRows(() => supabase.from('roster_at').select('event_id, player_id, team_id')
      .eq('event_id', eventId).order('player_id'))),
  ])
  const seasonPlayers = await withSeasonSkinsEnrollment(supabase, event.league_id, locationId, players || [])
  const skinScores = skinScoreRows(scores || [], seasonPlayers, roster || [])
  const skins = calcSkins(Object.fromEntries(skinScores.map(s => [s.player_id, s.hole_scores])), course.num_holes)
  return { course, players: seasonPlayers, scores: skinScores, skins }
}

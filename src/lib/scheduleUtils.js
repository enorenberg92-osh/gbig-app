// Pure helpers for AdminSchedule's matchup generation.

// Circle-method round robin. Returns array of rounds; each round is an array
// of [homeId, awayId]. Odd team count → one team sits out each round.
export function roundRobinRounds(teamIds) {
  const ids = [...teamIds]
  if (ids.length < 2) return []
  if (ids.length % 2 === 1) ids.push(null) // bye slot
  const n = ids.length
  const rounds = []
  const rotation = ids.slice(1)
  for (let r = 0; r < n - 1; r++) {
    const left = [ids[0], ...rotation.slice(0, n / 2 - 1)]
    const right = rotation.slice(n / 2 - 1).reverse()
    const pairs = []
    for (let i = 0; i < n / 2; i++) {
      if (left[i] != null && right[i] != null) {
        // alternate home/away by round so nobody is always home
        pairs.push(r % 2 === 0 ? [left[i], right[i]] : [right[i], left[i]])
      }
    }
    rounds.push(pairs)
    rotation.push(rotation.shift())
  }
  return rounds
}

// Which regular-season team match-play weeks get (re)generated, and with
// which round-robin round.
//
//   • Playoff, bye, and cancelled weeks are never touched.
//   • A week is "played" once it's closed or has any scored matchup; played
//     weeks keep their matchups.
//   • Rotation starts at the number of played weeks, so regenerating mid-
//     season continues the cycle (week 5 gets round 5) instead of starting
//     over at round 1 and repeating the early pairings. This assumes the
//     team list hasn't changed since those weeks were generated — if teams
//     were added or removed, the rounds themselves change and some repeats
//     are unavoidable.
//
// `events` must be in week order. Returns [{ event, pairs: [[home, away]] }].
export function planRoundRobin(events, matchupsByEvent, teamIds) {
  const rounds = roundRobinRounds(teamIds)
  if (!rounds.length) return []
  const matchWeeks = events.filter(e =>
    !e.is_bye && !e.is_playoff && e.status !== 'cancelled' && e.format === 'match_team')
  const isPlayed = e => e.status === 'closed'
    || (matchupsByEvent[e.id] || []).some(m => m.status === 'scored')
  const playedCount = matchWeeks.filter(isPlayed).length
  return matchWeeks
    .filter(e => !isPlayed(e))
    .map((event, i) => ({ event, pairs: rounds[(playedCount + i) % rounds.length] }))
}

// Playoff seeding: rank by season points (high → low), ties broken by lower
// season net total (teams with no net total rank after those with one).
// Pairs 1 v N, 2 v N-1, … With an odd count the TOP seed gets the bye and
// seeds 2..N are paired among themselves.
// Returns { seeded: [team], pairs: [[homeId, awayId]], byeTeamId }.
export function seedPlayoff(teams, pointsByTeam = {}, netByTeam = {}) {
  const net = id => (netByTeam[id] ?? Infinity)
  const seeded = [...teams].sort((a, b) =>
    ((pointsByTeam[b.id] || 0) - (pointsByTeam[a.id] || 0)) || (net(a.id) - net(b.id)))
  const byeTeamId = seeded.length % 2 === 1 ? seeded[0].id : null
  const field = byeTeamId ? seeded.slice(1) : seeded
  const pairs = []
  for (let i = 0; i < Math.floor(field.length / 2); i++) {
    pairs.push([field[i].id, field[field.length - 1 - i].id])
  }
  return { seeded, pairs, byeTeamId }
}

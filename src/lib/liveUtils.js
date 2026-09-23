// Pure helpers for live (hole-by-hole) rounds: the background sync queue used
// by ScoreEntry and the math behind the Tonight leaderboard.
import { dateKeyInTimeZone } from './dateUtils'

// ── Stroke allocation ─────────────────────────────────────────────────────────
// Mirrors public.format_strokes_received (100% allowance): extra strokes land
// on the hardest holes (stroke index 1 = hardest); a plus handicap gives
// strokes back starting at the easiest hole. No/invalid index → holes 1..n.
export function strokesReceived(handicap, strokeIndex, numHoles) {
  const n = Number(numHoles) || 0
  if (n < 1) return []
  const strokes = Math.round(Number(handicap) || 0)
  const ranks = Array.isArray(strokeIndex) && strokeIndex.length === n
    ? strokeIndex.map(Number)
    : Array.from({ length: n }, (_, i) => i + 1)
  const base = Math.floor(Math.abs(strokes) / n)
  const extra = Math.abs(strokes) % n
  return ranks.map(rank => strokes >= 0
    ? base + (rank <= extra ? 1 : 0)
    : -(base + ((n - rank + 1) <= extra ? 1 : 0)) || 0)
}

// Running numbers for one card over the holes actually played (players can
// skip around, so "thru" counts entered holes rather than the last hole).
export function summarizeCard(holeScores, course, handicap) {
  const n = Number(course?.num_holes) || 0
  const pars = Array.isArray(course?.hole_pars) ? course.hole_pars : []
  const received = strokesReceived(handicap, course?.stroke_index, n)
  let thru = 0, gross = 0, parPlayed = 0, net = 0
  for (let i = 0; i < n; i++) {
    const s = Array.isArray(holeScores) ? holeScores[i] : null
    if (s == null) continue
    thru += 1
    gross += s
    parPlayed += Number(pars[i]) || 0
    net += s - (received[i] || 0)
  }
  return {
    thru,
    finished: n > 0 && thru === n,
    gross: thru ? gross : null,
    grossToPar: thru ? gross - parPlayed : null,
    netToPar: thru ? net - parPlayed : null,
  }
}

export function formatToPar(n) {
  if (n == null) return '—'
  if (n === 0) return 'E'
  return n > 0 ? `+${n}` : `${n}`
}

export function isTodayAt(timestamp, timeZone, now = new Date()) {
  if (!timestamp) return false
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return false
  return dateKeyInTimeZone(timeZone, d) === dateKeyInTimeZone(timeZone, now)
}

// "Someone is out there right now": an open card touched in the last hour.
export function isPlayingNow(row, timeZone, now = new Date(), windowMs = 60 * 60 * 1000) {
  if (!row || row.submitted || !(row.holes_played > 0)) return false
  if (!isTodayAt(row.updated_at, timeZone, now)) return false
  return now.getTime() - new Date(row.updated_at).getTime() <= windowMs
}

// ── Tonight leaderboard rows ──────────────────────────────────────────────────
// liveRows:  live_rounds rows (any date; filtered to today here)
// scoreRows: played, non-rejected scores for the relevant events
// Everyone with a live card updated today, plus anyone whose score was
// created today without a live card (paper / admin entry).
export function buildTonightRows({
  liveRows = [], scoreRows = [], events = {}, courses = {}, players = {}, teams = {},
  timeZone, now = new Date(),
}) {
  const scoreByKey = {}
  scoreRows.forEach(s => { scoreByKey[`${s.event_id}:${s.player_id}`] = s })

  const rows = []
  const seen = new Set()
  const courseFor = eventId => courses[events[eventId]?.course_id] || null

  liveRows.forEach(lr => {
    if (!isTodayAt(lr.updated_at, timeZone, now)) return
    const key = `${lr.event_id}:${lr.player_id}`
    seen.add(key)
    const score = scoreByKey[key]
    // The submitted card is the one to show once it exists (admin may have
    // corrected a hole); until then, the live card.
    const holes = score?.hole_scores || lr.hole_scores
    const handicap = score?.handicap_used ?? lr.handicap_used
    rows.push(makeRow({
      key, eventId: lr.event_id, playerId: lr.player_id, teamId: lr.team_id || score?.team_id,
      holes, handicap, course: courseFor(lr.event_id), players, teams,
      status: score ? (score.status === 'verified' ? 'approved' : 'submitted') : 'live',
      updatedAt: lr.updated_at, source: lr.source, bay: lr.bay,
    }))
  })

  scoreRows.forEach(s => {
    const key = `${s.event_id}:${s.player_id}`
    if (seen.has(key) || !isTodayAt(s.created_at, timeZone, now)) return
    seen.add(key)
    rows.push(makeRow({
      key, eventId: s.event_id, playerId: s.player_id, teamId: s.team_id,
      holes: s.hole_scores, handicap: s.handicap_used, course: courseFor(s.event_id), players, teams,
      status: s.status === 'verified' ? 'approved' : 'submitted',
      updatedAt: s.created_at, source: 'app', bay: null,
    }))
  })
  return sortLeaderboard(rows)
}

function makeRow({ key, eventId, playerId, teamId, holes, handicap, course, players, teams, status, updatedAt, source, bay }) {
  return {
    key, eventId, playerId, teamId: teamId || null,
    name: players[playerId]?.name || 'Player',
    teamName: teams[teamId]?.name || '',
    handicap: handicap ?? null,
    numHoles: Number(course?.num_holes) || 0,
    status, updatedAt, source, bay,
    ...summarizeCard(holes, course, handicap),
  }
}

// Lowest net-to-par first; ties go to whoever has played more holes. Cards
// with nothing entered yet sit at the bottom.
export function sortLeaderboard(rows) {
  return [...rows].sort((a, b) => {
    const aNone = a.netToPar == null, bNone = b.netToPar == null
    if (aNone !== bNone) return aNone ? 1 : -1
    if (!aNone && a.netToPar !== b.netToPar) return a.netToPar - b.netToPar
    if (a.thru !== b.thru) return b.thru - a.thru
    return String(a.name).localeCompare(String(b.name))
  })
}

const STATUS_RANK = { live: 0, submitted: 1, approved: 2 }

// Team view: teammates' net-to-par summed; "thru" is the slower teammate.
export function buildTeamRows(playerRows) {
  const byTeam = {}
  playerRows.forEach(r => {
    const k = r.teamId ? `${r.eventId}:${r.teamId}` : `solo:${r.key}`
    if (!byTeam[k]) byTeam[k] = { key: k, teamId: r.teamId, name: r.teamName || r.name, members: [] }
    byTeam[k].members.push(r)
  })
  const rows = Object.values(byTeam).map(t => {
    const played = t.members.filter(m => m.netToPar != null)
    return {
      ...t,
      members: [...t.members].sort((a, b) => String(a.name).localeCompare(String(b.name))),
      netToPar: played.length ? played.reduce((a, m) => a + m.netToPar, 0) : null,
      gross: played.length ? played.reduce((a, m) => a + m.gross, 0) : null,
      thru: Math.min(...t.members.map(m => m.thru)),
      finished: t.members.every(m => m.finished),
      numHoles: Math.max(...t.members.map(m => m.numHoles)),
      // Least-advanced status wins: a team isn't "submitted" until everyone is.
      status: t.members.reduce((s, m) => (STATUS_RANK[m.status] < STATUS_RANK[s] ? m.status : s), 'approved'),
    }
  })
  return sortLeaderboard(rows)
}

// ── Live sync queue ───────────────────────────────────────────────────────────
// Fire-and-forget hole uploads that never block score entry. Changes are
// coalesced per (player, hole) — only the latest value is sent — debounced,
// sent one at a time, and retried with backoff. Permanent errors (auth,
// validation, week closed) drop that hole instead of retrying forever.
//   send(playerId, hole, strokes) → Promise; reject/throw on failure
//   onStatus('idle' | 'syncing' | 'paused')
export function createLiveSync({
  send,
  onStatus = () => {},
  debounceMs = 800,
  retryDelays = [2000, 5000, 15000, 30000],
  isPermanent = defaultIsPermanent,
} = {}) {
  const pending = new Map()       // "playerId:hole" → { playerId, hole, strokes }
  let timer = null
  let running = false
  let attempt = 0                 // consecutive transient failures (backoff step)
  let lastFailed = false
  let status = 'idle'
  let disposed = false

  const setStatus = s => { if (s !== status) { status = s; onStatus(s) } }
  const schedule = ms => {
    if (disposed) return
    clearTimeout(timer)
    timer = setTimeout(run, ms)
  }

  async function run() {
    timer = null
    if (running) return
    running = true
    try {
      while (pending.size) {
        const [key, item] = pending.entries().next().value
        try {
          const result = await send(item.playerId, item.hole, item.strokes)
          if (result && result.error) throw result.error
          // Only clear if nothing newer arrived for this hole meanwhile.
          if (pending.get(key) === item) pending.delete(key)
          attempt = 0
          lastFailed = false
        } catch (err) {
          lastFailed = true
          setStatus('paused')
          if (isPermanent(err)) {
            if (pending.get(key) === item) pending.delete(key)
            continue
          }
          const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)]
          attempt += 1
          schedule(delay)
          return
        }
      }
      setStatus(lastFailed ? 'paused' : 'idle')
    } finally {
      running = false
    }
  }

  return {
    push(playerId, hole, strokes) {
      if (disposed) return
      pending.set(`${playerId}:${hole}`, { playerId, hole, strokes: strokes ?? null })
      if (status === 'idle') setStatus('syncing')
      // A running loop picks the change up; a pending retry keeps its backoff.
      if (running || (attempt > 0 && timer)) return
      schedule(debounceMs)
    },
    flush() {
      if (disposed || running || !pending.size) return
      clearTimeout(timer)
      run()
    },
    pendingCount: () => pending.size,
    status: () => status,
    dispose() {
      // Best effort: send what's queued once, then stop retrying.
      clearTimeout(timer)
      timer = null
      if (pending.size && !running) run()
      disposed = true
    },
  }
}

function defaultIsPermanent(err) {
  const code = err?.code
  return code === '42501' || code === '22023' || code === 'PGRST202'
}

// Live card → the entry screen's per-player hole array.
export function holesFromLive(liveRow, numHoles) {
  return Array.from({ length: numHoles }, (_, i) => {
    const v = Array.isArray(liveRow?.hole_scores) ? liveRow.hole_scores[i] : null
    return Number.isInteger(v) && v >= 1 && v <= 20 ? v : null
  })
}

// Where to resume: the first hole either teammate hasn't entered, else the last.
export function resumeHoleIndex(a, b, numHoles) {
  for (let i = 0; i < numHoles; i++) {
    if (a?.[i] == null || b?.[i] == null) return i
  }
  return Math.max(0, numHoles - 1)
}

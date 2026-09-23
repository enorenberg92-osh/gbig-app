function nullableNumber(value) {
  return value == null || value === '' ? null : Number(value)
}

/** Event date of a round: COALESCE(start_date, event_date), like the server. */
export function roundDate(r) {
  const d = r.startDate ?? r.start_date ?? r.eventDate ?? r.event_date
    ?? r.events?.start_date ?? r.events?.event_date ?? null
  return d == null || d === '' ? null : String(d)
}

/**
 * Stable chronological order: event date, week, creation time, then id.
 *
 * Date comes first (matching recalculate_handicaps' "most recent N by event
 * date"): week numbers restart every season, so ordering by week first mixed
 * last season's week 10 in after this season's week 2. Rounds with no date
 * or week sort first (treated as oldest), matching the server's DESC NULLS LAST.
 */
export function compareRoundsChronologically(a, b) {
  const ad = roundDate(a)
  const bd = roundDate(b)
  if (ad != null && bd != null && ad !== bd) return ad.localeCompare(bd)
  if (ad == null && bd != null) return -1
  if (ad != null && bd == null) return 1

  const aw = nullableNumber(a.weekNumber ?? a.week_number ?? a.events?.week_number)
  const bw = nullableNumber(b.weekNumber ?? b.week_number ?? b.events?.week_number)
  if (aw != null && bw != null && aw !== bw) return aw - bw
  if (aw == null && bw != null) return -1
  if (aw != null && bw == null) return 1

  const ac = a.createdAt ?? a.created_at ?? ''
  const bc = b.createdAt ?? b.created_at ?? ''
  if (ac !== bc) return String(ac).localeCompare(String(bc))
  return String(a.id ?? '').localeCompare(String(b.id ?? ''))
}

/** Standings must pick an effective verified row deterministically. */
export function compareEffectiveScores(a, b) {
  const typeRank = score => score.entry_type === 'played' ? 0 : 1
  const typeDiff = typeRank(a) - typeRank(b)
  if (typeDiff) return typeDiff
  const createdDiff = String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))
  return createdDiff || String(a.id ?? '').localeCompare(String(b.id ?? ''))
}

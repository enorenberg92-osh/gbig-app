function nullableNumber(value) {
  return value == null || value === '' ? null : Number(value)
}

/** Dates must precede week numbers, which restart every league session. */
export function compareRoundsChronologically(a, b) {
  const ad = a.startDate ?? a.start_date ?? a.events?.start_date ?? a.events?.event_date ?? a.createdAt ?? a.created_at ?? ''
  const bd = b.startDate ?? b.start_date ?? b.events?.start_date ?? b.events?.event_date ?? b.createdAt ?? b.created_at ?? ''
  if (ad !== bd) return String(ad).localeCompare(String(bd))
  const aw = nullableNumber(a.weekNumber ?? a.week_number ?? a.events?.week_number)
  const bw = nullableNumber(b.weekNumber ?? b.week_number ?? b.events?.week_number)
  if (aw != null && bw != null && aw !== bw) return aw - bw
  if (aw == null && bw != null) return 1
  if (aw != null && bw == null) return -1

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


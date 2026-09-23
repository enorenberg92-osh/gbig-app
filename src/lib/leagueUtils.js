export async function loadWorkingLeague(supabase, locationId) {
  const { data, error } = await supabase
    .from('league_config')
    .select('id, name, num_weeks, start_date, is_active, is_working, segments, default_format')
    .eq('location_id', locationId)
    .eq('is_working', true)
    .maybeSingle()

  if (error) throw error
  if (!data) throw new Error('Choose a working league in Admin > Leagues first.')
  return data
}

// Week-by-week date ranges for a season: week 1 starts on `startDate`
// (YYYY-MM-DD) and each later week begins 7 days after the previous one.
// Pure date-string math in UTC so the local timezone can't shift a day.
export function buildWeekSchedule(startDate, numWeeks) {
  const n = parseInt(numWeeks)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate || '')
  if (!m || !n || n < 1) return []
  const base = Date.UTC(+m[1], +m[2] - 1, +m[3])
  const day = 24 * 60 * 60 * 1000
  const iso = ms => new Date(ms).toISOString().slice(0, 10)
  const weeks = []
  for (let i = 0; i < n; i++) {
    const start = base + i * 7 * day
    weeks.push({ week: i + 1, start: iso(start), end: iso(start + 6 * day) })
  }
  return weeks
}

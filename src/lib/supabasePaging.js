// ── PostgREST paging ───────────────────────────────────────────────────────
// Supabase caps every select at `max_rows` (1000 by default), silently
// truncating big result sets — a full season of scores easily exceeds it.
// fetchAllRows pages through with .range() until a short page comes back.
//
// `makeQuery` must build a FRESH, deterministically ordered query each call
// (e.g. `() => supabase.from('scores').select('*').eq(...).order('id')`),
// since a builder can only be awaited once and unordered pages can overlap.
export async function fetchAllRows(makeQuery, pageSize = 1000) {
  const rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1)
    if (error) return { data: null, error }
    const page = data || []
    rows.push(...page)
    if (page.length < pageSize) return { data: rows, error: null }
  }
}

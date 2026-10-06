// Rebuild the query for each page and use a stable, unique order at the caller.
// Continue until an empty page: a server cap smaller than pageSize must not
// turn a short response into a silently truncated season.
export async function fetchAllRows(makeQuery, pageSize = 500) {
  const rows = []
  for (;;) {
    const { data, error } = await makeQuery().range(rows.length, rows.length + pageSize - 1)
    if (error) return { data: null, error }
    if (!Array.isArray(data)) return { data: null, error: new Error('The league results could not be loaded. Please retry.') }
    if (data.length === 0) return { data: rows, error: null }
    rows.push(...data)
  }
}

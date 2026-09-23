// ── CSV export helpers ─────────────────────────────────────────────────────

const PLAIN_NUMBER = /^[-+]?\d+(\.\d+)?$/

/**
 * Escapes one CSV cell. Strings starting with = + - @ (or tab / CR) are
 * prefixed with a single quote so spreadsheet apps don't run them as formulas
 * (CSV injection) — plain numbers like "-3" are left alone. Cells containing
 * a quote, comma, CR or LF are quoted.
 */
export function csvCell(v) {
  let s = v == null ? '' : String(v)
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** rows: array of arrays; first row = header. */
export function toCsv(rows) {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n')
}

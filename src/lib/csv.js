// Minimal RFC 4180 CSV parser.
//
// Handles what spreadsheet / WPForms exports actually produce:
//   • quoted fields containing commas, line breaks, or escaped quotes ("")
//   • CRLF, LF, or bare CR line endings
//   • a leading UTF-8 byte-order mark
//   • a trailing newline (does not produce an extra empty row)
//
// Returns an array of rows, each an array of raw (untrimmed) string fields.
// Blank lines come back as [''] so callers can decide whether to skip them.
export function parseCSV(text) {
  const src = String(text ?? '').replace(/^﻿/, '')
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  let i = 0

  while (i < src.length) {
    const ch = src[i]

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue }  // escaped quote
        inQuotes = false; i++; continue
      }
      field += ch; i++; continue
    }

    if (ch === '"') { inQuotes = true; i++; continue }
    if (ch === ',') { row.push(field); field = ''; i++; continue }
    if (ch === '\r' || ch === '\n') {
      row.push(field); rows.push(row)
      row = []; field = ''
      i += (ch === '\r' && src[i + 1] === '\n') ? 2 : 1
      continue
    }
    field += ch; i++
  }

  // Flush the last row unless the input ended exactly on a line break.
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Parse a database DATE without letting UTC midnight shift the calendar day. */
export function parseLocalDate(value) {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime())

  const dateOnly = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnly) {
    const [, year, month, day] = dateOnly
    const parsed = new Date(Number(year), Number(month) - 1, Number(day))
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

export function formatLocalDate(value, options = {}, locale = 'en-US') {
  const date = parseLocalDate(value)
  return date ? date.toLocaleDateString(locale, options) : ''
}

/** YYYY-MM-DD for an instant as observed at the location's IANA timezone. */
export function dateKeyInTimeZone(timeZone = 'America/Chicago', now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function isDateInRange(startDate, endDate, timeZone, now = new Date()) {
  const today = dateKeyInTimeZone(timeZone, now)
  return (!startDate || startDate <= today) && (!endDate || endDate >= today)
}

export function isFutureDate(date, timeZone, now = new Date()) {
  return Boolean(date) && date > dateKeyInTimeZone(timeZone, now)
}


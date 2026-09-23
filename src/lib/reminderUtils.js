// Pure helpers for the weekly "Scores due" reminder card (AdminAlerts).
// The server (admin_score_reminder_preview) returns raw settings + counts;
// these turn them into labels. Day numbers follow JS getDay / Postgres DOW.

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export const DEFAULT_REMINDER_SETTINGS = { enabled: true, day_of_week: 5, send_hour: 9, audience: 'missing' }

// 0..23 -> "12:00 AM" .. "11:00 PM"
export function formatHour(hour) {
  const h = Number(hour)
  if (!Number.isInteger(h) || h < 0 || h > 23) return ''
  const suffix = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:00 ${suffix}`
}

export const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({ value: h, label: formatHour(h) }))

// "Fridays at 9:00 AM (America/Chicago)" or "Off"
export function scheduleLabel(settings, timezone) {
  if (!settings) return ''
  if (!settings.enabled) return 'Off'
  const day = DAY_NAMES[settings.day_of_week]
  if (!day) return ''
  const tz = timezone ? ` (${timezone})` : ''
  return `${day}s at ${formatHour(settings.send_hour)}${tz}`
}

// Sum one audience's counts across every open week the preview returned.
export function summarizeAudience(events, audience) {
  const out = { players: 0, withApp: 0, devices: 0, weeks: [] }
  for (const ev of events || []) {
    const c = ev?.counts?.[audience]
    if (!c) continue
    out.players += Number(c.players) || 0
    out.withApp += Number(c.with_app) || 0
    out.devices += Number(c.devices) || 0
    out.weeks.push(ev.week_number)
  }
  return out
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// One-line preview under the card, e.g.
// "6 players haven't submitted Week 5 · 4 devices will get it"
export function audienceSummaryText(summary, audience) {
  if (!summary || !summary.weeks.length) return 'No open week to remind about right now.'
  const weeks = summary.weeks.filter(w => w != null)
  const weekLabel = weeks.length === 1 ? `Week ${weeks[0]}` : weeks.length ? `Weeks ${weeks.join(', ')}` : 'this week'
  if (summary.players === 0) {
    return audience === 'missing'
      ? `Every team has submitted ${weekLabel} — nobody to remind.`
      : `Nobody is rostered for ${weekLabel}.`
  }
  const who = audience === 'missing'
    ? `${plural(summary.players, 'player')} ${summary.players === 1 ? "hasn't" : "haven't"} submitted ${weekLabel}`
    : `${plural(summary.players, 'player')} rostered for ${weekLabel}`
  return `${who} · ${plural(summary.devices, 'device')} will get it`
}

// "Fri, Sep 25, 9:00 AM · Scheduled · 12 devices"
export function lastSentLabel(last, timezone) {
  if (!last || !last.sent_at) return 'Never'
  let when
  try {
    when = new Date(last.sent_at).toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      ...(timezone ? { timeZone: timezone } : {}),
    })
  } catch {
    when = new Date(last.sent_at).toLocaleString('en-US')
  }
  const kind = last.kind === 'manual' ? 'Sent by admin' : 'Scheduled'
  let outcome
  if (last.status === 'empty') outcome = 'nobody to remind'
  else if (last.status === 'claimed') outcome = 'sending…'
  else outcome = plural(Number(last.sent) || 0, 'device')
  return `${when} · ${kind} · ${outcome}`
}

// Toast text for the function's response to "Send now".
export function sendNowResultText(result) {
  if (!result) return ''
  if (!result.reminders) {
    return result.alreadySent
      ? 'A reminder already went out today — try again tomorrow.'
      : 'No open week to remind about right now.'
  }
  if (!result.players) return 'Every team has submitted — nobody to remind.'
  return `Reminder sent to ${plural(result.sent || 0, 'device')} (${plural(result.players, 'player')}).`
}

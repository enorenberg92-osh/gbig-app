export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
import { directRecipient } from './emailRecipients.mjs'
export { directRecipient } from './emailRecipients.mjs'

export function validateMessage(subject, text) {
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 200 || /[\r\n\x00-\x1f]/.test(subject)) throw new Error('Enter a subject of 1–200 characters without line breaks.')
  if (typeof text !== 'string' || !text.trim() || text.length > 20000 || text.includes('\0')) throw new Error('Enter a message of 1–20,000 characters.')
  return { subject: subject.trim(), text: text.trim() }
}
export function resolveRecipients(roster, players, teams, event) {
  if (!roster.length || roster.length > 500) throw new Error('This round needs a roster of 1–500 players.')
  const validTeams = new Set(teams.filter(t => t.location_id === event.location_id && t.league_id === event.league_id).map(t => t.id))
  const byId = new Map(players.filter(p => p.location_id === event.location_id).map(p => [p.id, p]))
  const recipients = new Set(), seen = new Set()
  let missing_count = 0
  for (const row of roster) {
    if (row.event_id !== event.id || row.location_id !== event.location_id || row.league_id !== event.league_id || !validTeams.has(row.team_id) || !byId.has(row.player_id) || seen.has(row.player_id)) throw new Error('The round roster needs staff review before emailing.')
    seen.add(row.player_id)
    const email = String(byId.get(row.player_id).email || '').trim().toLowerCase()
    if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(email)) missing_count++
    else recipients.add(email)
  }
  if (!recipients.size) throw new Error('Add valid email addresses to this round’s roster first.')
  return { recipients: [...recipients].sort().map(email => ({ email, status: 'pending', attempted_at: null })), missing_count }
}
export function summary(row) {
  if (!row) return null
  const accepted_count = row.recipients.filter(r => r.status === 'accepted').length
  const review_count = row.recipients.filter(r => r.status === 'review').length
  return { draft_id:row.id, mode:row.mode||'league', compose_id:row.compose_id||null,
    to:row.mode==='direct'?row.recipients.map(r=>r.email).join(', '):undefined,
    to_addresses:row.mode==='direct'?row.recipients.map(r=>r.email):undefined,
    sender_id:row.sender_id, from:row.sender, subject:row.subject, text:row.body,
    recipient_count:row.recipients.length, missing_count:row.missing_count,
    accepted_count, review_count, pending_count:row.recipients.length - accepted_count - review_count,
    status:accepted_count === row.recipients.length ? 'accepted' : review_count ? 'review' : row.started_at ? 'sending' : 'draft',
    created_at:row.created_at, started_at:row.started_at, message:row.last_error || null }
}
// save must durably persist before contacting the provider. All provider calls are injected.
export async function sendChunk(row, { save, send, now = () => new Date(), pause = async () => {}, retryUnconfirmed = true }) {
  const state = structuredClone(row)
  let count = 0
  for (let i = 0; i < state.recipients.length && count < 10; i++) {
    const recipient = state.recipients[i]
    if (['accepted','review'].includes(recipient.status)) continue
    if (!retryUnconfirmed && recipient.attempted_at) {
      recipient.status = 'review'
      state.last_error = 'An earlier Gmail attempt has no confirmed result. Check the sender’s Sent mail before creating any replacement email. This address will not be resent automatically.'
      await save(state)
      continue
    }
    if (recipient.attempted_at && now().getTime() - Date.parse(recipient.attempted_at) >= 23 * 3600000) {
      recipient.status = 'review'
      state.last_error = 'An earlier attempt is too old to retry safely. Ask the owner to check the email service history before any further send.'
      await save(state)
      continue
    }
    recipient.attempted_at ||= now().toISOString()
    state.last_error = null
    await save(state)
    count++
    try {
      const result = await send({from:state.sender,reply_to:state.reply_to,to:[recipient.email],subject:state.subject,text:state.body}, `weekly-email/${state.id}/${i}`)
      if (!result?.id) throw new Error('The email service did not confirm acceptance.')
      recipient.status = 'accepted'
      recipient.provider_id = result.id
      await save(state)
    } catch {
      // Gmail has no provider idempotency key. A timeout or write failure must
      // never turn into another provider call for this recipient.
      if (!retryUnconfirmed) recipient.status = 'review'
      state.last_error = retryUnconfirmed
        ? 'Sending stopped without a confirmed result for every address. Retry this same email to safely check or continue. Do not create another email.'
        : 'Gmail did not confirm this attempt. Check the sender’s Sent mail before creating any replacement email. This address will not be resent automatically.'
      await save(state)
      break
    }
    await pause()
  }
  return state
}

export function authorizedSenders(configs, assignments, userId, locationId) {
  const allowed = new Set(assignments.filter(a => a.user_id === userId).map(a => a.sender_id))
  return configs.filter(s => s.location_id === locationId && s.enabled === true && allowed.has(s.id)).map(s => {
    const name = String(s.display_name || '').trim()
    const email = String(s.email || '').trim()
    const replyTo = String(s.reply_to || email).trim()
    const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i
    if (!name || name.length > 100 || /[\r\n<>\x00-\x1f]/.test(name) || email.length > 254 || replyTo.length > 254 || !emailPattern.test(email) || !emailPattern.test(replyTo)) throw new Error('A venue sender configuration needs owner review.')
    return { id:s.id, from:`${name} <${email}>`, reply_to:replyTo, is_default:s.is_default === true }
  }).sort((a,b) => Number(b.is_default) - Number(a.is_default) || a.from.localeCompare(b.from))
}

// The direct path cannot accidentally load a league audience: the callback is
// invoked only for league mode. Kept injectable for offline isolation tests.
export async function resolveEmailAudience(mode, to, loadLeagueAudience) {
  if (mode === 'direct') return directRecipient(to)
  if (mode !== 'league') throw new Error('Choose a valid email mode.')
  return await loadLeagueAudience()
}

// Readiness exposes presence checks only, never a credential or a delivery claim.
/** @param {{storage?: boolean|null, sender?: boolean|null, serviceKey?: boolean, accountId?: string, locationId?: string, message?: string}} options */
export function emailSetupStatus({ storage = null, sender = null, serviceKey = false, accountId, locationId, message }) {
  return {
    configured: storage === true && sender === true && Boolean(serviceKey),
    checks: { storage, sender, service_key: Boolean(serviceKey) },
    account_id: accountId,
    location_id: locationId,
    message,
  }
}


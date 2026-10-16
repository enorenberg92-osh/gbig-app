export const DIRECT_RECIPIENT_LIMIT = 1000
export const DIRECT_RECIPIENT_INPUT_LIMIT = 270000

/** Explicit addresses only; normalization never adds recipients from a roster. */
export function directRecipient(value) {
  if (typeof value !== 'string' || value.length > DIRECT_RECIPIENT_INPUT_LIMIT || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('Enter up to 1,000 recipient email addresses.')
  const tokens = value.split(/[,;\r\n]+/).map(item => item.trim().toLowerCase()).filter(Boolean)
  if (!tokens.length) throw new Error('Enter at least one email address in To.')
  const addresses = new Set()
  for (const email of tokens) {
    if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(email)) throw new Error('Check every recipient. Use email addresses only, separated by commas, semicolons, or new lines.')
    addresses.add(email)
    if (addresses.size > DIRECT_RECIPIENT_LIMIT) throw new Error(`Use no more than ${DIRECT_RECIPIENT_LIMIT} unique recipient addresses per email.`)
  }
  return { recipients: [...addresses].map(email => ({ email, status: 'pending', attempted_at: null })), missing_count: 0 }
}

// Imported venue contacts are never silently mixed into the saved audience.
// The UI must explicitly add them to To and preview the resulting exact list.
export function contactRecipients(players) {
  const addresses = new Set()
  let missing_count = 0
  for (const player of players) {
    try {
      const value = String(player.email || '').trim()
      const parsed = directRecipient(value).recipients
      if (parsed.length !== 1 || /[,;\r\n]/.test(value)) throw new Error('One address per contact')
      addresses.add(parsed[0].email)
    } catch { missing_count++ }
  }
  if (addresses.size > DIRECT_RECIPIENT_LIMIT) throw new Error('This group has more than 1,000 email addresses. Choose a smaller league or paste a smaller list.')
  return { addresses: [...addresses].sort(), missing_count, player_count: players.length }
}

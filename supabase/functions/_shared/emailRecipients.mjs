export const DIRECT_RECIPIENT_LIMIT = 50
export const DIRECT_RECIPIENT_INPUT_LIMIT = 13000

/** Explicit addresses only; normalization never adds recipients from a roster. */
export function directRecipient(value) {
  if (typeof value !== 'string' || value.length > DIRECT_RECIPIENT_INPUT_LIMIT || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error('Enter up to 50 recipient email addresses.')
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

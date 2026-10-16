const INITIAL_SENDERS = {
  gbig: 'trent@greenbayindoorgolf.com',
  appleton: 'jordan@appletonindoorgolf.com',
}

// Initial venue hints are instructions only. The server alone authorizes From.
export function emailSetupGuide({ setup, senders = [], locationId, venueSlug, venueName = 'This venue' }) {
  const checks = setup?.checks || {}
  const knownReady = setup?.configured === true
  const readiness = {
    storage: checks.storage ?? (knownReady ? true : null),
    sender: checks.sender ?? (knownReady ? true : null),
    serviceKey: checks.service_key ?? (knownReady ? true : null),
  }
  const initialSender = INITIAL_SENDERS[venueSlug] || ''
  const addresses = senders.map(sender => sender.from?.match(/<([^<>\s]+)>$/)?.[1]).filter(Boolean)
  const domains = [...new Set((addresses.length ? addresses : [initialSender]).filter(Boolean).map(address => address.split('@')[1]))]
  const accountId = setup?.account_id || ''
  const request = [
    `Email setup request: ${venueName}`,
    `Venue ID: ${locationId || 'Confirm the current venue ID.'}`,
    `Signed-in account ID confirmed by the email service: ${accountId || 'Not checked yet. Sign in and refresh readiness before assigning access.'}`,
    initialSender ? `Requested initial venue sender: ${initialSender}` : 'Choose an owner-approved sender for this venue.',
    'Review and install the weekly-email migration and authenticated Edge Function if missing. Keep JWT verification and RLS enabled.',
    'Configure the Google Gmail API web client and secure server settings GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_TOKEN_ENCRYPTION_KEY. Never paste credentials into chat or the composer. No DNS changes are authorized.',
    'Use Connect Gmail for each exact business Gmail account with only sending and email-identity permissions. Do not request inbox access. Before enabling a sender or assigning any verified staff account ID, obtain owner approval of that exact assignment. Do not infer account identity from the sender address or grant new venue-admin rights.',
    'After setup, refresh readiness. Any real test needs approval of the exact From, single To address, subject, and message. Do not use the league audience for validation.',
  ].join('\n')
  return { readiness, initialSender, domains, accountId, request }
}

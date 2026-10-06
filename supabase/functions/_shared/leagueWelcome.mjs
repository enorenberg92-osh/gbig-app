export const LEAGUE_VENUES = {
  gbig: { name:'Green Bay Indoor Golf', appUrl:'https://gbig-app.vercel.app/league', from:'Trent <trent@greenbayindoorgolf.com>', replyTo:'trent@greenbayindoorgolf.com', color:'#1b4332' },
  appleton: { name:'Appleton Indoor Golf', appUrl:'https://appleton-app.vercel.app/league', from:'Jordan <jordan@appletonindoorgolf.com>', replyTo:'jordan@appletonindoorgolf.com', color:'#1b4332' },
}
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
export function buildLeagueWelcome({ slug, leagueName, playerName, email, loginKind }) {
  const venue = LEAGUE_VENUES[slug]
  if (!venue) throw new Error('The venue has no configured welcome email or app address.')
  const session = String(leagueName || 'your league').trim()
  const greeting = `Hi ${String(playerName).trim()},`
  const login = loginKind === 'new'
    ? 'Your app account is ready. Your starting password is: password (all lowercase).'
    : 'Your app account is ready. Use your existing app password. We have kept it unchanged.'
  const booking = 'A tee-time booking account may be separate from your league app account. You do not need to create another account in the app.'
  const help = `If you need help signing in, reply to this email and our staff will help.`
  const text = `${greeting}\n\nWelcome to ${session} at ${venue.name}! You are registered and your app access is ready.\n\nOpen the app: ${venue.appUrl}\nEmail: ${email}\n${login}\n\n${booking}\n\nIn the app you can view your team, check league standings, and enter your round when a week opens. Check your name, partner, and handicap the first time you sign in.\n\nTo keep the app on your phone, open it in Safari on iPhone or Chrome on Android, then choose Add to Home Screen from the browser menu.\n\n${help}\n\nSee you at the league!\n${venue.name}`
  const html = `<!doctype html><html><body style="margin:0;background:#f5f7f5;font-family:Arial,sans-serif;color:#203329"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="padding:32px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:auto;background:#fff;border-radius:12px"><tr><td style="padding:32px"><p style="margin:0 0 24px;color:${venue.color};font-size:16px;font-weight:bold">${escape(venue.name)}</p><h1 style="font-size:28px;line-height:1.2;margin:0 0 24px">Welcome to ${escape(session)}</h1><p style="line-height:1.6">${escape(greeting)}</p><p style="line-height:1.6">You are registered, and your app access is ready.</p><p style="margin:28px 0"><a href="${venue.appUrl}" style="background:${venue.color};color:#fff;text-decoration:none;display:inline-block;padding:14px 24px;border-radius:8px;font-weight:bold">Open your league app</a></p><p style="line-height:1.6"><strong>Email:</strong> ${escape(email)}<br>${escape(login)}</p><p style="line-height:1.6">${escape(booking)}</p><p style="line-height:1.6">View your team, check standings, and enter your round when a week opens. On your first visit, check your name, partner, and handicap.</p><h2 style="font-size:18px;margin:28px 0 10px">Keep the app on your phone</h2><p style="line-height:1.6">Open the link in Safari on iPhone or Chrome on Android, then choose <strong>Add to Home Screen</strong> from the browser menu.</p><p style="line-height:1.6">${escape(help)}</p><p style="line-height:1.6;margin-bottom:0">See you at the league!<br>${escape(venue.name)}</p></td></tr></table></td></tr></table></body></html>`
  return { from:venue.from, reply_to:venue.replyTo, to:[email], subject:`Welcome to ${session} — ${venue.name}`, html, text }
}

export async function authUsersByEmail(admin) {
  const users = new Map()
  for (let page = 1; page <= 1000; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage:1000 })
    if (error) throw error
    for (const user of data?.users || []) if (user.email) users.set(user.email.trim().toLowerCase(), user)
    if ((data?.users?.length || 0) < 1000) return users
  }
  throw new Error('The account directory could not be fully checked. Retry or contact support.')
}

// Dependency injection keeps provider/auth tests entirely offline.
export async function processLeagueRegistration({ job, player, slug, leagueName, users, admin, save, sendEmail, emailConfigured, verifyPlayer = async () => {}, now = () => new Date() }) {
  let state = { ...job }
  const update = async patch => { await save(patch); state = { ...state, ...patch } }
  const result = () => ({ player_id:player.id, name:player.name, account_status:state.account_status, email_status:state.email_status, message:state.account_error || state.email_error || null })
  const email = String(player.email || '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    await update({ account_status:'needs_email', email_status:'needs_email', account_error:'Add a valid, separate email address to this golfer, then retry registration.' })
    return result()
  }
  if (state.email && state.email !== email && state.welcome_payload) {
    await update({ email_status:'review', email_error:'The email changed after a welcome was prepared. Staff must review this registration.' })
    return result()
  }
  try {
    await verifyPlayer()
    let user = users.get(email)
    let loginKind = state.login_kind || (user ? 'existing' : 'new')
    if (!user) {
      const { data, error } = await admin.auth.admin.createUser({ email, password:'password', email_confirm:true })
      if (error) {
        // Another venue may have created the same person's account concurrently.
        // Refresh once on an existing-email collision, never reset a password.
        if (['email_exists','email_address_exists','user_already_exists'].includes(error.code)) {
          const refreshed = await authUsersByEmail(admin)
          user = refreshed.get(email)
          if (!user) throw error
          loginKind = 'existing'
        } else throw error
      } else { user = data?.user; loginKind = 'new' }
      if (!user?.id) throw new Error('The app account could not be created. Retry registration.')
      users.set(email, user)
      // Record new/existing immediately. A retry after a interrupted link must
      // still give a newly created player the correct starting-password advice.
      await update({ auth_user_id:user.id, login_kind:loginKind, email })
    }
    const { error:linkError } = await admin.rpc('service_link_player_account', { p_player_id:player.id, p_user_id:user.id, p_email:email })
    if (linkError) throw linkError
    await update({ account_status:'ready', account_error:null, auth_user_id:user.id, login_kind:loginKind, email })
  } catch (error) {
    await update({ account_status:'error', account_error:error.message || 'Account creation failed. Retry registration.' })
    return result()
  }
  if (state.email_status === 'sent' || state.email_status === 'review') return result()
  if (!emailConfigured) {
    await update({ email_status:'not_configured', email_error:'App access is ready. Welcome emails are waiting for the email service to be connected.' })
    return result()
  }
  // Resend retains idempotency keys for 24 hours. An uncertain send outside
  // that window needs review, rather than risking a duplicate welcome.
  if (state.email_attempted_at && now().getTime() - new Date(state.email_attempted_at).getTime() >= 23 * 60 * 60 * 1000) {
    await update({ email_status:'review', email_error:'An earlier email attempt needs staff review before another send. App access is ready.' })
    return result()
  }
  try {
    const payload = state.welcome_payload || buildLeagueWelcome({ slug, leagueName, playerName:player.name, email, loginKind:state.login_kind })
    await update({ email_status:'sending', email_error:null, welcome_payload:payload, email_attempted_at:state.email_attempted_at || now().toISOString() })
    const sent = await sendEmail(payload, `league-welcome/${job.id}`)
    await update({ email_status:'sent', email_error:null, provider_message_id:sent.id, sent_at:now().toISOString() })
  } catch (error) {
    await update({ email_status:'error', email_error:error.message || 'The welcome email could not be sent. Retry registration.' })
  }
  return result()
}

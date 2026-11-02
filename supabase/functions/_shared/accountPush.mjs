// Dependency injection keeps push delivery testable without contacting phones.
export async function deliverAccountNotification(notification, { admin, send, finish, configured = true }) {
  const delivered = new Set(notification.delivered_endpoints || [])
  const done = (state, error = null) => finish(notification, state, [...delivered], error)
  try {
    const read = async query => {
      const { data, error } = await query
      if (error) throw error
      return data || []
    }
    if (notification.kind === 'sub_request') {
      const admins = await read(admin.from('location_admins').select('user_id').eq('location_id', notification.location_id).eq('user_id', notification.user_id))
      if (!admins.length) return await done('skipped')
    } else {
      const events = await read(admin.from('events').select('id').eq('id', notification.event_id).eq('location_id', notification.location_id).eq('status', 'open').eq('is_bye', false))
      if (!events.length) return await done('skipped')
      const players = await read(admin.from('players').select('id').eq('user_id', notification.user_id).eq('location_id', notification.location_id))
      if (!players.length) return await done('skipped')
      const roster = await read(admin.from('roster_at').select('player_id').eq('event_id', notification.event_id).eq('location_id', notification.location_id).in('player_id', players.map(p => p.id)))
      if (!roster.length) return await done('skipped')
      const scores = await read(admin.from('scores').select('player_id').eq('event_id', notification.event_id).eq('location_id', notification.location_id).eq('entry_type', 'played').in('status', ['pending', 'verified']).in('player_id', roster.map(p => p.player_id)))
      const entered = new Set(scores.map(s => s.player_id))
      if (roster.every(p => entered.has(p.player_id))) return await done('skipped')
    }
    if (!configured) return await done('pending', 'Push delivery configuration is missing.')
    const subscriptions = await read(admin.from('push_subscriptions').select('id,endpoint,p256dh,auth_key').eq('user_id', notification.user_id).eq('location_id', notification.location_id))
    if (!subscriptions.length) return await done(delivered.size ? 'sent' : 'no_devices')
    let failed = false
    for (const subscription of subscriptions) {
      if (delivered.has(subscription.endpoint)) continue
      try {
        await send(subscription, {
          title: notification.title, body: notification.body,
          url: notification.url, tag: `account-${notification.id}`, icon: '/icon-192.png',
        })
        delivered.add(subscription.endpoint)
      } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
          const { error: deletionError } = await admin.from('push_subscriptions').delete().eq('id', subscription.id).eq('user_id', notification.user_id).eq('location_id', notification.location_id)
          if (deletionError) failed = true
        } else failed = true
      }
    }
    return await done(failed ? 'pending' : delivered.size ? 'sent' : 'no_devices', failed ? 'Some devices could not be reached; retry scheduled.' : null)
  } catch {
    return await done('pending', 'Notification delivery failed; retry scheduled.')
  }
}

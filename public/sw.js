// GBIG App — Service Worker
// Handles background push notifications

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(clients.claim()))

// ── Push notification received ─────────────────────────────────
self.addEventListener('push', event => {
  let data = {}
  try { data = event.data?.json() ?? {} } catch { data = { title: 'GBIG Alert', body: event.data?.text() ?? '' } }

  const title   = data.title || 'Green Bay Indoor Golf'
  const options = {
    body:              data.body  || '',
    icon:              '/icon-192.png',
    badge:             '/icon-96.png',
    tag:               data.tag  || 'gbig-alert',
    renotify:          true,
    requireInteraction: false,
    data: { url: data.url || '/' },
    vibrate: [100, 50, 100],
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

// ── Notification tapped — open / focus the app ─────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close()
  const target = event.notification.data?.url || '/'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.focus()
          return
        }
      }
      clients.openWindow(target)
    })
  )
})

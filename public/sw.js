// GBIG App — Service Worker
// Handles background push notifications

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(clients.claim()))

// ── Push notification received ─────────────────────────────────
self.addEventListener('push', event => {
  let data = {}
  try { data = event.data?.json() ?? {} } catch { data = { title: 'GBIG Alert', body: event.data?.text() ?? '' } }

  const title   = data.title || 'League Alert'
  const options = {
    body:              data.body  || '',
    icon:              data.icon  || '/icon-192.png',
    badge:             data.badge || '/icon-96.png',
    tag:               data.tag  || 'gbig-alert',
    renotify:          true,
    requireInteraction: false,
    data: { url: data.url || '/' },
    vibrate: [100, 50, 100],
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

// Older payloads carried hash-router URLs; map them to the real routes.
const LEGACY_URLS = { '/#/alerts': '/alerts', '/#/social': '/league/friends' }

// ── Notification tapped — open / focus the app at the target URL ──
self.addEventListener('notificationclick', event => {
  event.notification.close()
  const raw    = event.notification.data?.url || '/'
  const target = new URL(LEGACY_URLS[raw] || raw, self.location.origin).href
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async list => {
      for (const client of list) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          // Focus first (needs the click's user activation), then route the
          // existing window to the notification's page. navigate() only
          // works on controlled clients — an uncontrolled one just focuses.
          const win = await client.focus()
          if (raw !== '/' && client.url !== target && 'navigate' in client) {
            try { await (win || client).navigate(target) } catch { /* uncontrolled */ }
          }
          return
        }
      }
      return clients.openWindow(target)
    })
  )
})

// ── Push subscription rotated/expired by the browser ─────────────
// No auth here, so we can't call subscribe_push — just resubscribe with the
// same key. The app re-syncs the new endpoint to the server on next open.
self.addEventListener('pushsubscriptionchange', event => {
  const options = event.oldSubscription?.options
  if (!options?.applicationServerKey) return
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly:      true,
      applicationServerKey: options.applicationServerKey,
    }).catch(() => {})
  )
})

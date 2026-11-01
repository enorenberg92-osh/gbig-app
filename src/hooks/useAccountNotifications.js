import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

export function useAccountNotifications(session, locationId) {
  const [items, setItems] = useState([])
  const [error, setError] = useState('')
  const userId = session?.user?.id
  useEffect(() => {
    let cancelled = false
    setItems([]); setError('')
    if (!userId || !locationId) return
    async function load() {
      const { data, error } = await supabase.from('account_notifications').select('*').eq('location_id', locationId).eq('user_id', userId).order('created_at', { ascending: false }).limit(50)
      if (cancelled) return
      if (error) setError('Your account alerts could not be loaded. Try refreshing.')
      else { setItems(data || []); setError('') }
    }
    load()
    const interval = setInterval(load, 60000)
    window.addEventListener('focus', load)
    const channel = supabase.channel(`account-alerts-${locationId}-${userId}`).on('postgres_changes', {
      event: '*', schema: 'public', table: 'account_notifications', filter: `user_id=eq.${userId}`,
    }, load).subscribe()
    return () => { cancelled = true; clearInterval(interval); window.removeEventListener('focus', load); supabase.removeChannel(channel) }
  }, [userId, locationId])
  async function markRead(id) {
    const { error } = await supabase.rpc('mark_account_notification_read', { p_id: id })
    if (error) { setError('Could not mark this alert as read. Try again.'); return }
    setItems(items => items.map(item => item.id === id ? { ...item, read_at: new Date().toISOString() } : item))
  }
  const visible = items.filter(item => item.user_id === userId && item.location_id === locationId)
  return { items: visible, error, markRead, unread: visible.filter(item => !item.read_at).length }
}

// Devices subscribed before sign-in need to be linked to the signed-in account.
// Signing out removes that private targeting while preserving public broadcasts.
export function usePushAccount(session, locationId, sessionLoading) {
  const userId = session?.user?.id
  useEffect(() => {
    if (sessionLoading || !locationId || !('serviceWorker' in navigator) || !('Notification' in window) || Notification.permission !== 'granted') return
    let cancelled = false
    async function link() {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (cancelled || !subscription) return
      const data = subscription.toJSON()
      const { error } = await supabase.rpc('subscribe_push', { p_endpoint: data.endpoint, p_p256dh: data.keys.p256dh, p_auth_key: data.keys.auth, p_location_id: locationId })
      if (error) console.warn('Could not link this device to the current account.')
    }
    link().catch(() => console.warn('Could not link push subscription.'))
    return () => { cancelled = true }
  }, [userId, locationId, sessionLoading])
}

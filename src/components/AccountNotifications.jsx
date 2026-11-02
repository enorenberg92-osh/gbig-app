import React from 'react'
import { Link } from 'react-router-dom'
import { Button } from './ui'
import './account-notifications.css'

export default function AccountNotifications({ notifications }) {
  return <section className="account-alerts" aria-labelledby="account-alerts-title">
    <h2 id="account-alerts-title">Your account alerts{notifications.unread > 0 ? ` (${notifications.unread} unread)` : ''}</h2>
    {notifications.error && <p role="alert">{notifications.error}</p>}
    {!notifications.items.length && !notifications.error && <p>Sub requests and score reminders for your account will appear here.</p>}
    {notifications.items.map(item => <article key={item.id} className="account-alert">
      <div className="account-alert-top"><h3>{item.title}{!item.read_at && <span className="account-alert-unread">New</span>}</h3><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</time></div>
      <p>{item.body}</p>
      <div className="account-alert-actions"><Link to={item.url} onClick={() => notifications.markRead(item.id)}>{item.kind === 'sub_request' ? 'Review sub requests' : 'Enter score'}</Link>
        {!item.read_at && <Button variant="ghost" size="sm" onClick={() => notifications.markRead(item.id)}>Mark as read</Button>}</div>
    </article>)}
  </section>
}

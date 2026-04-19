import React from 'react'
import { AlertTriangle, Info, CheckCircle2 } from 'lucide-react'

/**
 * Inline persistent callout banner.
 *
 * Different from <Toast> — callouts live inside the page flow and stay
 * visible as long as the condition holds (e.g. "3 pending subs need
 * your attention"). Toasts are transient top-center notifications.
 *
 * Usage:
 *   <Callout tone="warning">
 *     <strong>3 sub requests</strong> need your attention
 *   </Callout>
 */
export default function Callout({ tone = 'info', icon, children, style: overrideStyle = {} }) {
  const palette = {
    warning: { bg: '#fff3cd', border: '#ffc107', color: '#856404', Icon: AlertTriangle },
    info:    { bg: 'var(--green-xlight)', border: 'var(--green)', color: 'var(--green-dark)', Icon: Info },
    success: { bg: 'var(--green-xlight)', border: 'var(--green)', color: 'var(--green-dark)', Icon: CheckCircle2 },
    danger:  { bg: '#fff5f5', border: '#feb2b2', color: '#c53030', Icon: AlertTriangle },
  }
  const p = palette[tone] || palette.info
  const Icon = icon || <p.Icon size={16} strokeWidth={2.25} />

  return (
    <div style={{
      display:      'flex',
      alignItems:   'center',
      gap:          10,
      background:   p.bg,
      border:       `1px solid ${p.border}`,
      color:        p.color,
      padding:      '12px 16px',
      borderRadius: 'var(--radius-sm)',
      fontSize:     14,
      animation:    'uiFadeUp 0.28s cubic-bezier(0.2, 0.8, 0.2, 1)',
      ...overrideStyle,
    }}>
      <span style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>{Icon}</span>
      <span style={{ flex: 1, lineHeight: 1.4 }}>{children}</span>
    </div>
  )
}

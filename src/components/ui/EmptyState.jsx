import React from 'react'

/**
 * Centered empty-state block for lists that have nothing to show.
 *
 * Usage:
 *   <EmptyState
 *     icon={<Inbox size={40} strokeWidth={1.5} />}
 *     title="No pending sub requests"
 *     description="You'll see sub requests here when players submit them."
 *   />
 */
export default function EmptyState({
  icon,
  title,
  description,
  action,
  style: overrideStyle = {},
}) {
  return (
    <div style={{
      padding:        '32px 24px',
      textAlign:      'center',
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      gap:            10,
      color:          'var(--gray-500)',
      animation:      'uiFadeUp 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)',
      ...overrideStyle,
    }}>
      {icon && (
        <span style={{ display: 'flex', alignItems: 'center', color: 'var(--gray-400)' }}>
          {icon}
        </span>
      )}
      {title && (
        <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--gray-600)', margin: 0 }}>
          {title}
        </p>
      )}
      {description && (
        <p style={{ fontSize: 13, color: 'var(--gray-500)', margin: 0, maxWidth: 320, lineHeight: 1.5 }}>
          {description}
        </p>
      )}
      {action && <div style={{ marginTop: 4 }}>{action}</div>}
    </div>
  )
}

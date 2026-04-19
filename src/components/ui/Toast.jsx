import React from 'react'
import { CheckCircle2, AlertTriangle, Info } from 'lucide-react'

/**
 * Fixed top-center toast notification.
 *
 * Kept as a pure component — the parent still owns state and auto-dismiss
 * timing. This matches the `{toast && <Toast toast={toast} />}` pattern
 * each admin surface already uses, so migration is a one-line swap.
 *
 * Usage:
 *   <Toast toast={toast} />           // toast = { msg: '...', type: 'success' | 'error' | 'info' }
 *   <Toast message="..." type="..." /> // explicit props
 */
export default function Toast({ toast, message, type }) {
  const resolvedMsg  = message ?? toast?.msg
  const resolvedType = type    ?? toast?.type ?? 'success'
  if (!resolvedMsg) return null

  const palette = {
    success: { bg: 'var(--green)',    Icon: CheckCircle2 },
    error:   { bg: '#c53030',         Icon: AlertTriangle },
    info:    { bg: 'var(--gray-800)', Icon: Info },
  }
  const { bg, Icon } = palette[resolvedType] || palette.success

  return (
    <div style={{
      position:     'fixed',
      top:          16,
      left:         '50%',
      transform:    'translateX(-50%)',
      display:      'inline-flex',
      alignItems:   'center',
      gap:          8,
      background:   bg,
      color:        'var(--white)',
      padding:      '10px 18px',
      borderRadius: 20,
      fontSize:     13,
      fontWeight:   600,
      zIndex:       9999,
      boxShadow:    'var(--shadow-lg)',
      whiteSpace:   'nowrap',
      maxWidth:     'calc(100vw - 32px)',
    }}>
      <Icon size={15} strokeWidth={2.5} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{resolvedMsg}</span>
    </div>
  )
}

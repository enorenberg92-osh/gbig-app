import React from 'react'

/**
 * ConfirmDialog — replaces window.confirm() with a styled, mobile-friendly modal.
 *
 * Usage:
 *   const [dialog, setDialog] = useState(null)
 *
 *   // Trigger:
 *   setDialog({ message: 'Are you sure?', onConfirm: () => doTheThing() })
 *   setDialog({ message: 'Delete?', confirmLabel: 'Delete', destructive: true, onConfirm: () => ... })
 *
 *   // In JSX:
 *   {dialog && (
 *     <ConfirmDialog {...dialog} onCancel={() => setDialog(null)} onConfirm={() => { dialog.onConfirm(); setDialog(null) }} />
 *   )}
 */
export default function ConfirmDialog({
  message       = 'Are you sure?',
  confirmLabel  = 'Confirm',
  cancelLabel   = 'Cancel',
  destructive   = true,
  onConfirm,
  onCancel,
}) {
  return (
    <div style={st.overlay} onClick={onCancel}>
      <div style={st.card} onClick={e => e.stopPropagation()}>
        <p style={st.message}>{message}</p>
        <div style={st.btnRow}>
          <button style={st.cancelBtn} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            style={{ ...st.confirmBtn, background: destructive ? '#c53030' : 'var(--green-dark)' }}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

const st = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.45)',
    zIndex: 10000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
  },
  card: {
    background: '#fff',
    borderRadius: '16px',
    padding: '24px 22px 20px',
    width: '100%',
    maxWidth: '320px',
    boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
  },
  message: {
    fontSize: '14px',
    color: 'var(--black)',
    lineHeight: 1.6,
    marginBottom: '20px',
    whiteSpace: 'pre-line',  // preserves \n\n line breaks from messages
  },
  btnRow: {
    display: 'flex',
    gap: '10px',
  },
  cancelBtn: {
    flex: 1,
    padding: '11px',
    borderRadius: '8px',
    fontSize: '14px',
    fontWeight: 600,
    color: 'var(--gray-600)',
    background: 'var(--gray-100)',
    border: '1.5px solid var(--gray-200)',
    cursor: 'pointer',
  },
  confirmBtn: {
    flex: 1,
    padding: '11px',
    borderRadius: '8px',
    fontSize: '14px',
    fontWeight: 700,
    color: '#fff',
    cursor: 'pointer',
    border: 'none',
  },
}

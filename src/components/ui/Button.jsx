import React from 'react'

/**
 * Shared Button primitive for the GBIG app.
 *
 * Variants match the three roles already used across the codebase:
 *   - primary  : solid green — main action (Save, Create, Approve)
 *   - secondary: gray-filled  — neutral action (Cancel, Edit)
 *   - danger   : red outline  — destructive action (Delete, Deny)
 *   - ghost    : transparent  — low-emphasis action (subtle links / icon-only)
 *
 * Sizes keep the padding/font pairs consistent across screens:
 *   - sm : compact inline buttons (12px font, 6/12 padding)
 *   - md : default form actions (13px font, 10/16 padding)
 *   - lg : hero CTAs and full-width submits (14px font, 12/20 padding)
 */
export default function Button({
  variant       = 'primary',
  size          = 'md',
  icon          = null,
  iconRight     = null,
  loading       = false,
  loadingText   = null,
  disabled      = false,
  fullWidth     = false,
  type          = 'button',
  onClick,
  children,
  className     = '',
  style: overrideStyle = {},
  ...rest
}) {
  const isDisabled = disabled || loading

  const base = {
    display:       'inline-flex',
    alignItems:    'center',
    justifyContent:'center',
    gap:           8,
    border:        '1.5px solid transparent',
    borderRadius:  'var(--radius-sm)',
    fontFamily:    'inherit',
    fontWeight:    700,
    cursor:        isDisabled ? 'not-allowed' : 'pointer',
    opacity:       isDisabled ? 0.6 : 1,
    whiteSpace:    'nowrap',
    width:         fullWidth ? '100%' : 'auto',
  }

  const variants = {
    primary: {
      background:   'var(--green)',
      color:        'var(--white)',
      borderColor:  'var(--green)',
    },
    secondary: {
      background:   'var(--gray-100)',
      color:        'var(--gray-600)',
      borderColor:  'var(--gray-200)',
      fontWeight:   600,
    },
    danger: {
      background:   '#fff5f5',
      color:        '#c53030',
      borderColor:  '#fecaca',
    },
    ghost: {
      background:   'transparent',
      color:        'var(--gray-600)',
      borderColor:  'transparent',
    },
  }

  const sizes = {
    sm: { padding: '6px 12px',  fontSize: 12 },
    md: { padding: '10px 16px', fontSize: 13 },
    lg: { padding: '12px 20px', fontSize: 14 },
  }

  const style = {
    ...base,
    ...(variants[variant] || variants.primary),
    ...(sizes[size]       || sizes.md),
    ...overrideStyle,
  }

  const label = loading && loadingText ? loadingText : children
  const combinedClass = ['ui-pressable', className].filter(Boolean).join(' ')

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={isDisabled}
      style={style}
      className={combinedClass}
      {...rest}
    >
      {icon && <span style={{ display: 'inline-flex', alignItems: 'center' }}>{icon}</span>}
      {label && <span>{label}</span>}
      {iconRight && <span style={{ display: 'inline-flex', alignItems: 'center' }}>{iconRight}</span>}
    </button>
  )
}

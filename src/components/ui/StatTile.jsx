import React from 'react'

/**
 * Shared StatTile primitive for the GBIG app.
 *
 * Matches the icon + value + label tiles used in AdminDashboard's stat
 * strip and the 2x2 grid in LeagueDashboard. Use it anywhere you want a
 * compact, centered metric card.
 *
 * Props:
 *   - icon    : required Lucide element (already sized + colored by caller)
 *   - value   : optional — number or ReactNode; omit for action-tile use
 *   - label   : required string
 *   - size    : 'sm' | 'md'
 *               'sm' (default): compact admin stat-strip tile — 30px value,
 *                 11px uppercase gray label
 *               'md'           : larger action tile with a green-dark, mixed-case
 *                 14px label (used by LeagueDashboard 2x2 grid)
 *   - tone    : 'default' | 'accent' (accent = gold highlight on value)
 *   - onClick : optional — renders as a button
 *   - disabled: dims the tile (used for "coming soon" in LeagueDashboard)
 *   - badge   : optional corner badge string (e.g. "Soon")
 *   - style   : passthrough inline styles
 *
 * Usage:
 *   <StatTile icon={<Users size={20} color="var(--green)" />} value={42} label="Players" />
 */
export default function StatTile({
  icon,
  value,
  label,
  size     = 'sm',
  tone     = 'default',
  onClick  = null,
  disabled = false,
  badge    = null,
  style: overrideStyle = {},
  ...rest
}) {
  const tones = {
    default: { valueColor: 'var(--green-dark)' },
    accent:  { valueColor: 'var(--gold, #b8860b)' },
  }

  const sizes = {
    sm: {
      padding: '18px 12px',
      gap:     6,
      valueStyle: { fontSize: 30, fontWeight: 800, lineHeight: 1 },
      labelStyle: {
        fontSize:      11,
        color:         'var(--gray-500)',
        fontWeight:    600,
        textTransform: 'uppercase',
        letterSpacing: '0.4px',
        marginTop:     2,
      },
    },
    md: {
      padding: '24px 16px',
      gap:     10,
      valueStyle: { fontSize: 28, fontWeight: 800, lineHeight: 1 },
      labelStyle: {
        fontSize:   14,
        color:      'var(--green-dark)',
        fontWeight: 600,
      },
    },
  }

  const t = tones[tone] || tones.default
  const s = sizes[size] || sizes.sm
  const interactive = !!onClick

  const base = {
    background:     'var(--white)',
    border:         '1px solid var(--gray-200)',
    borderRadius:   'var(--radius)',
    padding:        s.padding,
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            s.gap,
    boxShadow:      'var(--shadow)',
    position:       'relative',
    cursor:         interactive && !disabled ? 'pointer' : 'default',
    opacity:        disabled ? 0.55 : 1,
    textAlign:      'center',
    minWidth:       0,
    width:          '100%',
    boxSizing:      'border-box',
    fontFamily:     'inherit',
    ...overrideStyle,
  }

  const content = (
    <>
      {icon && <span style={styles.icon}>{icon}</span>}
      {value != null && (
        <span style={{ ...s.valueStyle, color: t.valueColor }}>{value}</span>
      )}
      <span style={s.labelStyle}>{label}</span>
      {badge && <span style={styles.badge}>{badge}</span>}
    </>
  )

  if (interactive) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        style={base}
        className="ui-pressable"
        {...rest}
      >
        {content}
      </button>
    )
  }

  return <div style={base} {...rest}>{content}</div>
}

const styles = {
  icon: {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
  },
  badge: {
    position:      'absolute',
    top:           8,
    right:         8,
    background:    '#fff8e1',
    color:         '#7a5c00',
    fontSize:      9,
    fontWeight:    700,
    padding:       '2px 6px',
    borderRadius:  20,
    textTransform: 'uppercase',
    letterSpacing: '0.4px',
  },
}

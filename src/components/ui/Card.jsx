import React from 'react'

/**
 * Shared Card primitive for the GBIG app.
 *
 * Cards are the dominant surface in every admin + player screen: a white
 * panel on the off-white page background, with optional title row and
 * body content. This primitive canonicalizes that pattern.
 *
 * Props:
 *   - title    : optional heading string (rendered as the uppercase eyebrow
 *                used across admin surfaces)
 *   - count    : optional number — renders a green pill on the header row
 *   - actions  : optional node for the header right slot (usually Button)
 *   - padding  : 'sm' | 'md' | 'lg' | 'none'       (default 'md' = 16px)
 *   - tone     : 'default' | 'dark' | 'off-white'  (default white surface)
 *   - style    : passthrough inline styles for surface-specific overrides
 *
 * Usage:
 *   <Card title="Published Posts" count={posts.length}>
 *     …list…
 *   </Card>
 */
export default function Card({
  title    = null,
  count    = null,
  actions  = null,
  padding  = 'md',
  tone     = 'default',
  children,
  style: overrideStyle = {},
  ...rest
}) {
  const paddings = {
    none: 0,
    sm:   12,
    md:   16,
    lg:   24,
  }

  const tones = {
    default: {
      background: 'var(--white)',
      border:     '1px solid var(--gray-200)',
      color:      'var(--black)',
    },
    dark: {
      background: 'var(--green-dark)',
      border:     '1px solid var(--green-dark)',
      color:      '#fff',
    },
    'off-white': {
      background: 'var(--off-white)',
      border:     '1px solid var(--gray-200)',
      color:      'var(--black)',
    },
  }

  const base = {
    borderRadius: 'var(--radius)',
    boxShadow:    'var(--shadow)',
    padding:      paddings[padding] ?? paddings.md,
  }

  const style = {
    ...base,
    ...(tones[tone] || tones.default),
    ...overrideStyle,
  }

  const hasHeader = title != null || count != null || actions != null

  return (
    <div style={style} {...rest}>
      {hasHeader && (
        <div style={styles.header}>
          {title && <h3 style={{ ...styles.title, color: tone === 'dark' ? '#fff' : 'var(--green-dark)' }}>{title}</h3>}
          <div style={styles.headerRight}>
            {count != null && <span style={styles.count}>{count}</span>}
            {actions}
          </div>
        </div>
      )}
      {children}
    </div>
  )
}

const styles = {
  header: {
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'center',
    marginBottom:   12,
    gap:            8,
  },
  title: {
    fontSize:       14,
    fontWeight:     700,
    textTransform:  'uppercase',
    letterSpacing:  '0.4px',
    margin:         0,
  },
  headerRight: {
    display:    'flex',
    alignItems: 'center',
    gap:        8,
  },
  count: {
    fontSize:     13,
    fontWeight:   700,
    color:        'var(--green)',
    background:   'var(--green-xlight)',
    padding:      '2px 10px',
    borderRadius: 20,
  },
}

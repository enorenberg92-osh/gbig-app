import React from 'react'

/**
 * Shared PageHeader primitive for the GBIG app.
 *
 * Used at the top of each screen to present the title (and optional
 * subtitle) plus an optional actions slot on the right. This is a
 * screen-level header — distinct from Card's internal title row.
 *
 * Props:
 *   - title    : required string
 *   - subtitle : optional string — appears under the title
 *   - icon     : optional Lucide element rendered to the left of the title
 *   - actions  : optional node (usually Button) rendered on the right
 *   - tone     : 'default' | 'hero' — hero uses green-dark background
 *   - style    : passthrough inline styles
 *
 * Usage:
 *   <PageHeader
 *     title="Published Posts"
 *     subtitle="Updates your players see in the feed"
 *     actions={<Button>New Post</Button>}
 *   />
 */
export default function PageHeader({
  title,
  subtitle = null,
  icon     = null,
  actions  = null,
  tone     = 'default',
  style: overrideStyle = {},
  ...rest
}) {
  const tones = {
    default: {
      background: 'transparent',
      color:      'var(--green-dark)',
      subColor:   'var(--gray-500)',
      padding:    '0 0 16px',
      borderBottom: 'none',
    },
    hero: {
      background: 'var(--green-dark)',
      color:      '#fff',
      subColor:   'rgba(255,255,255,0.72)',
      padding:    '20px 24px',
      borderBottom: 'none',
      borderRadius: 'var(--radius)',
    },
  }

  const t = tones[tone] || tones.default

  const style = {
    display:        'flex',
    justifyContent: 'space-between',
    alignItems:     'flex-start',
    gap:            12,
    background:     t.background,
    padding:        t.padding,
    borderRadius:   t.borderRadius,
    ...overrideStyle,
  }

  return (
    <div style={style} {...rest}>
      <div style={styles.left}>
        {icon && <span style={styles.icon}>{icon}</span>}
        <div>
          <h1 style={{ ...styles.title, color: t.color }}>{title}</h1>
          {subtitle && <div style={{ ...styles.subtitle, color: t.subColor }}>{subtitle}</div>}
        </div>
      </div>
      {actions && <div style={styles.actions}>{actions}</div>}
    </div>
  )
}

const styles = {
  left: {
    display:    'flex',
    alignItems: 'center',
    gap:        12,
    minWidth:   0,
    flex:       1,
  },
  icon: {
    display:    'flex',
    alignItems: 'center',
    flexShrink: 0,
  },
  title: {
    fontSize:   20,
    fontWeight: 800,
    letterSpacing: '-0.2px',
    margin:     0,
    lineHeight: 1.2,
  },
  subtitle: {
    fontSize:   13,
    fontWeight: 400,
    marginTop:  4,
  },
  actions: {
    display:    'flex',
    alignItems: 'center',
    gap:        8,
    flexShrink: 0,
  },
}

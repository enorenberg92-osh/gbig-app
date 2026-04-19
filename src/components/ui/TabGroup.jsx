import React from 'react'

/**
 * Shared TabGroup primitive for the GBIG app.
 *
 * Canonicalizes the two tab-ish patterns we use:
 *   - 'pill'      : full-width rounded pill row (FriendsTab, AdminSubs filter)
 *   - 'underline' : inline tabs with an active underline (AdminDashboard
 *                   step bar — long horizontal list)
 *
 * Props:
 *   - options  : required array of { id, label, count?, icon? }
 *   - value    : id of the active option
 *   - onChange : fn(id) called when a tab is clicked
 *   - variant  : 'pill' | 'underline'  (default 'pill')
 *   - fullWidth: stretch tabs to fill the row (default true for pills)
 *   - style    : passthrough inline styles for the outer row
 *
 * Usage:
 *   <TabGroup
 *     options={[{ id: 'following', label: 'Following', count: 4 }, …]}
 *     value={tab}
 *     onChange={setTab}
 *   />
 */
export default function TabGroup({
  options   = [],
  value,
  onChange  = () => {},
  variant   = 'pill',
  fullWidth = true,
  style: overrideStyle = {},
  ...rest
}) {
  if (variant === 'underline') {
    return (
      <div style={{ ...styles.underlineRow, ...overrideStyle }} {...rest}>
        {options.map(({ id, label, count, icon }) => {
          const active = value === id
          return (
            <button
              key={id}
              type="button"
              onClick={() => onChange(id)}
              style={{
                ...styles.underlineTab,
                flex:         fullWidth ? 1 : 'initial',
                color:        active ? 'var(--green-dark)' : 'var(--gray-500)',
                fontWeight:   active ? 700 : 500,
                borderBottom: active ? '2.5px solid var(--green)' : '2.5px solid transparent',
                background:   active ? 'var(--white)' : 'transparent',
              }}
            >
              {icon && <span style={styles.iconWrap}>{icon}</span>}
              <span>{label}</span>
              {count != null && count > 0 && (
                <span style={{
                  ...styles.underlineCount,
                  background: active ? 'var(--green-xlight)' : 'var(--gray-100)',
                  color:      active ? 'var(--green-dark)'   : 'var(--gray-500)',
                }}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
      </div>
    )
  }

  // default: pill variant
  return (
    <div style={{ ...styles.pillRow, ...overrideStyle }} {...rest}>
      {options.map(({ id, label, count, icon }) => {
        const active = value === id
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            style={{
              ...styles.pill,
              flex:       fullWidth ? 1 : 'initial',
              background: active ? 'var(--green)' : 'var(--white)',
              color:      active ? '#fff'        : 'var(--gray-600)',
              border:     active ? '1.5px solid var(--green)' : '1.5px solid var(--gray-200)',
              fontWeight: active ? 700 : 500,
            }}
          >
            {icon && <span style={styles.iconWrap}>{icon}</span>}
            <span>{label}</span>
            {count != null && count > 0 && (
              <span style={{
                ...styles.pillCount,
                background: active ? 'rgba(255,255,255,0.25)' : 'var(--green-xlight)',
                color:      active ? '#fff'                    : 'var(--green-dark)',
              }}>
                {count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

const styles = {
  pillRow: {
    display: 'flex',
    gap:     8,
    width:   '100%',
  },
  pill: {
    padding:        '10px 14px',
    borderRadius:   'var(--radius-sm)',
    fontSize:       13,
    cursor:         'pointer',
    display:        'inline-flex',
    alignItems:     'center',
    justifyContent: 'center',
    gap:            6,
    transition:     'background 0.15s, color 0.15s, border-color 0.15s',
    fontFamily:     'inherit',
    whiteSpace:     'nowrap',
  },
  pillCount: {
    fontSize:     11,
    fontWeight:   700,
    padding:      '1px 7px',
    borderRadius: 10,
  },

  underlineRow: {
    display:       'flex',
    borderBottom:  '1px solid var(--gray-200)',
    overflowX:     'auto',
    scrollbarWidth:'none',
    background:    'var(--off-white)',
  },
  underlineTab: {
    display:    'flex',
    alignItems: 'center',
    gap:        7,
    padding:    '12px 16px',
    fontSize:   13,
    cursor:     'pointer',
    whiteSpace: 'nowrap',
    fontFamily: 'inherit',
    transition: 'all 0.15s',
  },
  underlineCount: {
    fontSize:     11,
    fontWeight:   700,
    padding:      '1px 7px',
    borderRadius: 10,
  },

  iconWrap: {
    display:    'inline-flex',
    alignItems: 'center',
  },
}

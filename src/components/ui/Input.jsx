import React, { forwardRef } from 'react'

/**
 * Shared Input primitive for the GBIG app.
 *
 * Covers the common text-field shape used across admin + player surfaces:
 * search boxes, text/email/password/date/number inputs. Selects and the
 * score-entry ±-box are intentionally not part of this primitive — they
 * have different semantics and deserve their own components.
 *
 * Props:
 *   - label        : optional uppercase eyebrow above the input
 *   - type         : native HTML input type (text/email/password/search/number/date)
 *   - size         : 'sm' | 'md' | 'lg'  (default 'md')
 *   - prefixIcon   : optional Lucide element rendered inside the left edge
 *   - suffixIcon   : optional Lucide element rendered inside the right edge
 *   - helperText   : optional muted hint below the input
 *   - error        : optional string — border turns red + message shows below
 *   - fullWidth    : default true
 *   - style        : passthrough overrides on the outer wrapper
 *   - inputStyle   : passthrough overrides on the <input> itself
 *   - everything else (value, onChange, placeholder, required, autoComplete,
 *     min, max, step, name, id, disabled, readOnly, etc.) is passed through
 *     to the native <input>.
 *
 * Usage:
 *   <Input
 *     label="New password"
 *     type="password"
 *     value={pwForm.next}
 *     onChange={e => setPwForm(f => ({ ...f, next: e.target.value }))}
 *     autoComplete="new-password"
 *     required
 *   />
 *
 *   <Input
 *     type="search"
 *     placeholder="Search by name…"
 *     prefixIcon={<Search size={14} />}
 *     value={q}
 *     onChange={e => setQ(e.target.value)}
 *   />
 */
const Input = forwardRef(function Input({
  label         = null,
  type          = 'text',
  size          = 'md',
  prefixIcon    = null,
  suffixIcon    = null,
  helperText    = null,
  error         = null,
  fullWidth     = true,
  disabled      = false,
  style:      overrideStyle      = {},
  inputStyle: overrideInputStyle = {},
  id,
  ...rest
}, ref) {
  const sizes = {
    sm: { padding: '8px 12px',  fontSize: 13 },
    md: { padding: '10px 12px', fontSize: 14 },
    lg: { padding: '12px 14px', fontSize: 15 },
  }
  const s = sizes[size] || sizes.md

  const hasPrefix = !!prefixIcon
  const hasSuffix = !!suffixIcon
  const hasError  = !!error

  // Reserve room for icons so the text doesn't slide under them.
  const leftPad  = hasPrefix ? 36 : undefined
  const rightPad = hasSuffix ? 36 : undefined

  const inputStyle = {
    width:          '100%',
    padding:        s.padding,
    paddingLeft:    leftPad,
    paddingRight:   rightPad,
    borderRadius:  'var(--radius-sm)',
    border:        `1.5px solid ${hasError ? '#fecaca' : 'var(--gray-200)'}`,
    background:    disabled ? 'var(--gray-100)' : 'var(--white)',
    color:         'var(--black)',
    fontSize:      s.fontSize,
    fontFamily:    'inherit',
    boxSizing:     'border-box',
    outline:       'none',
    transition:    'border-color 0.15s, background 0.15s, box-shadow 0.15s',
    ...overrideInputStyle,
  }

  // Focus ring via pseudo-class needs a real stylesheet; fall back to
  // onFocus/onBlur handlers that temporarily strengthen the border.
  const [focused, setFocused] = React.useState(false)
  if (focused && !hasError) {
    inputStyle.borderColor = 'var(--green)'
    inputStyle.boxShadow   = '0 0 0 3px var(--green-xlight)'
  } else if (focused && hasError) {
    inputStyle.boxShadow   = '0 0 0 3px #fff5f5'
  }

  const generatedId = id || (label ? `in-${label.toLowerCase().replace(/\s+/g, '-')}` : undefined)

  return (
    <div style={{ width: fullWidth ? '100%' : 'auto', ...overrideStyle }}>
      {label && (
        <label
          htmlFor={generatedId}
          style={{
            display:       'block',
            fontSize:      11,
            fontWeight:    700,
            color:         'var(--gray-500)',
            textTransform: 'uppercase',
            letterSpacing: '0.4px',
            marginBottom:  6,
          }}
        >
          {label}
        </label>
      )}

      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        {prefixIcon && (
          <span style={{
            position:   'absolute',
            left:       12,
            display:    'flex',
            alignItems: 'center',
            color:      'var(--gray-500)',
            pointerEvents: 'none',
          }}>
            {prefixIcon}
          </span>
        )}

        <input
          ref={ref}
          id={generatedId}
          type={type}
          disabled={disabled}
          style={inputStyle}
          onFocus={(e) => { setFocused(true);  rest.onFocus?.(e) }}
          onBlur ={(e) => { setFocused(false); rest.onBlur?.(e) }}
          {...rest}
        />

        {suffixIcon && (
          <span style={{
            position:   'absolute',
            right:      12,
            display:    'flex',
            alignItems: 'center',
            color:      'var(--gray-500)',
            pointerEvents: 'none',
          }}>
            {suffixIcon}
          </span>
        )}
      </div>

      {(helperText || error) && (
        <p style={{
          margin:    '6px 2px 0',
          fontSize:  12,
          lineHeight: 1.4,
          color:     hasError ? '#c53030' : 'var(--gray-500)',
        }}>
          {error || helperText}
        </p>
      )}
    </div>
  )
})

export default Input

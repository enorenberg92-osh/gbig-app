import React, { useEffect, useRef, useState } from 'react'

const BOOKING_URL =
  import.meta.env.VITE_BOOKING_URL ||
  'https://greenbayindoorgolf.com/app-page-booking/'

/**
 * ReservationsPage
 *
 * The reservation form itself is hosted on the location's WordPress site
 * (Bookly). We embed it via iframe so the site continues to drive the
 * actual booking transaction — this is the one piece we intentionally do
 * NOT replicate natively.
 *
 * Everything the player sees around the iframe — the skeleton while it
 * loads, the top chrome integration via App.jsx's gold header, the edge
 * masks that hide the underlying WordPress page template — is what we
 * control here to keep the experience feeling native.
 *
 * A matching Bookly "Custom CSS" snippet lives in docs/BOOKLY_CUSTOM_CSS.md
 * and should be pasted into Bookly → Settings → Appearance → Custom CSS
 * (or as WordPress "Additional CSS" on the dedicated app page) to modernize
 * the form typography, buttons, and inputs.
 */
export default function ReservationsPage() {
  const iframeRef = useRef(null)
  const [loaded, setLoaded]   = useState(false)
  const [errored, setErrored] = useState(false)

  // Fallback timeout — if the iframe doesn't fire 'load' within 12s we
  // surface a gentle error with a tap-to-retry option. Better than
  // staring at a skeleton forever on a flaky connection.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!loaded) setErrored(true)
    }, 12000)
    return () => clearTimeout(t)
  }, [loaded])

  function handleRetry() {
    setErrored(false)
    setLoaded(false)
    if (iframeRef.current) {
      // eslint-disable-next-line no-self-assign
      iframeRef.current.src = iframeRef.current.src
    }
  }

  return (
    <div style={styles.container}>
      {/* Skeleton — shown until the iframe finishes loading */}
      {!loaded && !errored && <ReservationsSkeleton />}

      {/* Error state */}
      {errored && (
        <div style={styles.errorState}>
          <p style={styles.errorTitle}>Couldn't load the reservation form</p>
          <p style={styles.errorBody}>
            Check your connection and try again.
          </p>
          <button style={styles.retryBtn} onClick={handleRetry}>
            Try again
          </button>
        </div>
      )}

      {/* The actual Bookly form */}
      <iframe
        ref={iframeRef}
        src={BOOKING_URL}
        style={{
          ...styles.iframe,
          opacity: loaded ? 1 : 0,
          pointerEvents: loaded ? 'auto' : 'none',
        }}
        title="Reserve a Bay"
        frameBorder="0"
        allow="payment"
        onLoad={() => setLoaded(true)}
      />

      {/*
        Edge masks — cover any WordPress page chrome that bleeds through
        at the top/bottom of the iframe (e.g. the site's page-title block
        that still renders on the dedicated app-booking page). Sized
        generously so it works across WP themes. Pointer-events: none so
        clicks still pass through to the form above.
      */}
      <div style={styles.topMask}    aria-hidden="true" />
      <div style={styles.bottomMask} aria-hidden="true" />
    </div>
  )
}

/* ─── Skeleton loader ─────────────────────────────────────────────────── */
function ReservationsSkeleton() {
  return (
    <div style={styles.skeleton} aria-hidden="true">
      <div style={styles.skeletonIntro}>
        <div style={{ ...styles.skelLine, width: '55%', height: '22px' }} />
        <div style={{ ...styles.skelLine, width: '80%', height: '14px', marginTop: '10px' }} />
      </div>

      <div style={styles.skeletonCard}>
        <div style={{ ...styles.skelLine, width: '40%', height: '14px' }} />
        <div style={{ ...styles.skelInput, marginTop: '8px' }} />
      </div>

      <div style={styles.skeletonCard}>
        <div style={{ ...styles.skelLine, width: '40%', height: '14px' }} />
        <div style={{ ...styles.skelInput, marginTop: '8px' }} />
      </div>

      <div style={styles.skeletonCard}>
        <div style={{ ...styles.skelLine, width: '40%', height: '14px' }} />
        <div style={styles.skelGrid}>
          <div style={styles.skelCell} />
          <div style={styles.skelCell} />
          <div style={styles.skelCell} />
          <div style={styles.skelCell} />
          <div style={styles.skelCell} />
          <div style={styles.skelCell} />
        </div>
      </div>

      <div style={{ ...styles.skelButton }} />
    </div>
  )
}

/* ─── Styles ──────────────────────────────────────────────────────────── */
const styles = {
  container: {
    height: '100%',
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    position: 'relative',
    background: 'var(--gray-50, #f7f6f2)',
  },
  iframe: {
    flex: 1,
    width: '100%',
    height: '100%',
    border: 'none',
    display: 'block',
    background: 'transparent',
    transition: 'opacity 0.35s ease',
  },

  // Masks — sit above the iframe and below any skeleton. Pointer-events
  // disabled so taps still hit the form underneath.
  topMask: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '4px',
    background: 'var(--gray-50, #f7f6f2)',
    pointerEvents: 'none',
    zIndex: 2,
  },
  bottomMask: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '72px',
    background:
      'linear-gradient(to bottom, rgba(247,246,242,0) 0%, rgba(247,246,242,1) 38%, rgba(247,246,242,1) 100%)',
    pointerEvents: 'none',
    zIndex: 2,
  },

  // ── Skeleton ────────────────────────────────────────────────────────
  skeleton: {
    position: 'absolute',
    inset: 0,
    padding: '20px 18px 24px',
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    background: 'var(--gray-50, #f7f6f2)',
    zIndex: 3,
  },
  skeletonIntro: {
    padding: '4px 2px 8px',
  },
  skeletonCard: {
    background: '#fff',
    borderRadius: '14px',
    padding: '18px 16px',
    boxShadow: '0 1px 3px rgba(16,24,32,0.04), 0 1px 2px rgba(16,24,32,0.03)',
  },
  skelLine: {
    borderRadius: '6px',
    background: 'linear-gradient(90deg, #eceae3 0%, #f6f5f0 50%, #eceae3 100%)',
    backgroundSize: '200% 100%',
    animation: 'skelShimmer 1.4s ease-in-out infinite',
  },
  skelInput: {
    height: '44px',
    borderRadius: '10px',
    background: 'linear-gradient(90deg, #eceae3 0%, #f6f5f0 50%, #eceae3 100%)',
    backgroundSize: '200% 100%',
    animation: 'skelShimmer 1.4s ease-in-out infinite',
  },
  skelGrid: {
    marginTop: '12px',
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '10px',
  },
  skelCell: {
    height: '64px',
    borderRadius: '10px',
    background: 'linear-gradient(90deg, #eceae3 0%, #f6f5f0 50%, #eceae3 100%)',
    backgroundSize: '200% 100%',
    animation: 'skelShimmer 1.4s ease-in-out infinite',
  },
  skelButton: {
    marginTop: '6px',
    height: '48px',
    borderRadius: '12px',
    background: 'linear-gradient(90deg, #d9cfa8 0%, #ebe2b8 50%, #d9cfa8 100%)',
    backgroundSize: '200% 100%',
    animation: 'skelShimmer 1.6s ease-in-out infinite',
    opacity: 0.7,
  },

  // ── Error ───────────────────────────────────────────────────────────
  errorState: {
    position: 'absolute',
    inset: 0,
    padding: '40px 28px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    background: 'var(--gray-50, #f7f6f2)',
    zIndex: 4,
    gap: '10px',
  },
  errorTitle: {
    fontFamily: "'Playfair Display', Georgia, serif",
    fontSize: '18px',
    fontWeight: 600,
    color: 'var(--gray-800, #1f2937)',
    margin: 0,
  },
  errorBody: {
    fontSize: '14px',
    color: 'var(--gray-500, #6b7280)',
    margin: '0 0 12px',
  },
  retryBtn: {
    padding: '10px 22px',
    borderRadius: '10px',
    background: 'var(--green, #1b4332)',
    color: '#fff',
    fontWeight: 600,
    fontSize: '14px',
    border: 'none',
    cursor: 'pointer',
    boxShadow: '0 2px 6px rgba(27,67,50,0.25)',
  },
}

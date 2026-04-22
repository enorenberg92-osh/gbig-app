import React, { useState, useEffect, useCallback } from 'react'

/**
 * InstallPrompt — lightweight "Install App" button for the header.
 *
 * Behaviour differs by platform:
 *   • Android / desktop Chrome + Edge: captures the `beforeinstallprompt`
 *     event, stashes the deferred prompt, and fires it when the user taps.
 *     The browser's native install sheet handles the rest.
 *   • iOS Safari: no beforeinstallprompt support. We render the same button
 *     on iOS and — on tap — open a modal walking the user through
 *     Share → Add to Home Screen. We detect iOS via UA sniff (the only
 *     option: the capability-detect APIs lie on iOS).
 *
 * The button hides itself in three cases:
 *   1. Already installed (standalone display-mode or iOS `navigator.standalone`).
 *   2. Android browser hasn't fired `beforeinstallprompt` yet (criteria not met,
 *      e.g. running inside an in-app browser, already installed, or unsupported).
 *   3. User dismissed the iOS modal within the last 7 days.
 *
 * No dependency on analytics or error reporting — the install APIs are
 * fire-and-forget and any failures surface in the native browser UI.
 */

const IOS_DISMISS_KEY     = 'gbig_ios_install_dismissed_at'
const IOS_DISMISS_MS      = 7 * 24 * 60 * 60 * 1000 // 7 days

// Tell iOS Safari from everything else. Modern iPads pretend to be desktop
// Safari, so we also accept "Macintosh + touch" as iPad-OS.
function detectIOS() {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  const isIOS       = /iPad|iPhone|iPod/.test(ua) && !window.MSStream
  const isIPadOS13  = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
  const isSafari    = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
  return (isIOS || isIPadOS13) && isSafari
}

// Detect standalone (already installed as PWA). Two APIs — Android via
// media-query, iOS via the (non-standard) navigator.standalone flag.
function detectStandalone() {
  if (typeof window === 'undefined') return false
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true
  if (window.navigator && window.navigator.standalone === true) return true
  return false
}

export default function InstallPrompt({ buttonStyle }) {
  const [deferredPrompt, setDeferredPrompt] = useState(null)  // Android beforeinstallprompt event
  const [isStandalone,  setIsStandalone]    = useState(detectStandalone())
  const [isIOS,         setIsIOS]           = useState(false)
  const [showIOSModal,  setShowIOSModal]    = useState(false)
  const [installing,    setInstalling]      = useState(false)

  // ── One-shot setup: platform detect + beforeinstallprompt handler ─────
  useEffect(() => {
    setIsIOS(detectIOS())

    const onBeforeInstall = (e) => {
      // Chrome/Edge/Android fire this when install criteria are met. Preventing
      // the default keeps the default "install" bar out of the viewport and
      // hands us the prompt() method to fire on our own button click.
      e.preventDefault()
      setDeferredPrompt(e)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)

    // appinstalled fires after successful install — clear state + mark standalone
    const onInstalled = () => {
      setDeferredPrompt(null)
      setIsStandalone(true)
    }
    window.addEventListener('appinstalled', onInstalled)

    // Keep standalone state fresh if the display-mode flips at runtime
    // (e.g. user opens the installed app from their home screen).
    const mq = window.matchMedia ? window.matchMedia('(display-mode: standalone)') : null
    const onModeChange = () => setIsStandalone(detectStandalone())
    if (mq?.addEventListener) mq.addEventListener('change', onModeChange)

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
      if (mq?.removeEventListener) mq.removeEventListener('change', onModeChange)
    }
  }, [])

  // ── iOS dismissal: check if user hid the modal recently ───────────────
  const iosDismissedRecently = useCallback(() => {
    try {
      const v = localStorage.getItem(IOS_DISMISS_KEY)
      if (!v) return false
      const n = parseInt(v, 10)
      if (Number.isNaN(n)) return false
      return (Date.now() - n) < IOS_DISMISS_MS
    } catch {
      return false
    }
  }, [])

  const dismissIOS = () => {
    try { localStorage.setItem(IOS_DISMISS_KEY, String(Date.now())) } catch {}
    setShowIOSModal(false)
  }

  // ── Tap handler — forks by platform ───────────────────────────────────
  const handleInstallClick = async () => {
    if (deferredPrompt) {
      setInstalling(true)
      try {
        deferredPrompt.prompt()
        // userChoice resolves to { outcome: 'accepted' | 'dismissed' }. Either
        // way the event is single-use so we drop our reference to it.
        await deferredPrompt.userChoice
      } catch (err) {
        console.error('[InstallPrompt] prompt failed:', err)
      } finally {
        setDeferredPrompt(null)
        setInstalling(false)
      }
      return
    }
    if (isIOS) {
      setShowIOSModal(true)
      return
    }
  }

  // ── Visibility rules ──────────────────────────────────────────────────
  // Nothing to show if we're already running as a PWA.
  if (isStandalone) return null
  // Otherwise show the button if EITHER Android has surfaced a prompt event,
  // OR we're on iOS and the user hasn't recently dismissed. Any other browser
  // (e.g. desktop Firefox w/o install support) gets no button at all.
  const canShowButton = !!deferredPrompt || (isIOS && !iosDismissedRecently())
  if (!canShowButton) return null

  return (
    <>
      <button
        type="button"
        onClick={handleInstallClick}
        disabled={installing}
        title="Install app"
        aria-label="Install app"
        style={buttonStyle || defaultBtnStyle}
      >
        {/* Download-to-device glyph. Strokes match the other header icons. */}
        <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path d="M12 3v12" />
          <path d="M7 10l5 5 5-5" />
          <path d="M4 21h16" />
        </svg>
      </button>

      {showIOSModal && (
        <IOSInstallModal onClose={() => setShowIOSModal(false)} onDismiss={dismissIOS} />
      )}
    </>
  )
}

// ── iOS install instruction modal ─────────────────────────────────────────
function IOSInstallModal({ onClose, onDismiss }) {
  // Lock body scroll while the modal is up
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // Esc-to-close
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div style={modalStyles.backdrop} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-modal-title"
        style={modalStyles.sheet}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={modalStyles.handle} />

        <div style={modalStyles.headerWrap}>
          <h3 id="install-modal-title" style={modalStyles.title}>Install GBIG</h3>
          <p style={modalStyles.subtitle}>
            Add the app to your Home Screen for a full-screen experience and faster access.
          </p>
        </div>

        <ol style={modalStyles.steps}>
          <li style={modalStyles.step}>
            <span style={modalStyles.stepNum}>1</span>
            <div style={modalStyles.stepBody}>
              <div style={modalStyles.stepText}>
                Tap the <strong>Share</strong> button
              </div>
              <div style={modalStyles.stepHint}>
                At the bottom of Safari (or top on iPad).
              </div>
            </div>
            <span style={modalStyles.stepIcon} aria-hidden="true">
              {/* iOS share glyph — arrow-up out of square */}
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 3v12" />
                <path d="M8 7l4-4 4 4" />
                <path d="M20 14v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5" />
              </svg>
            </span>
          </li>

          <li style={modalStyles.step}>
            <span style={modalStyles.stepNum}>2</span>
            <div style={modalStyles.stepBody}>
              <div style={modalStyles.stepText}>
                Scroll and tap <strong>Add to Home Screen</strong>
              </div>
              <div style={modalStyles.stepHint}>
                It's in the row of actions with a "+" icon.
              </div>
            </div>
            <span style={modalStyles.stepIcon} aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="4" width="16" height="16" rx="3" />
                <path d="M12 8v8M8 12h8" />
              </svg>
            </span>
          </li>

          <li style={modalStyles.step}>
            <span style={modalStyles.stepNum}>3</span>
            <div style={modalStyles.stepBody}>
              <div style={modalStyles.stepText}>
                Tap <strong>Add</strong> in the top-right
              </div>
              <div style={modalStyles.stepHint}>
                The GBIG icon will appear on your Home Screen.
              </div>
            </div>
            <span style={modalStyles.stepIcon} aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12l5 5L20 7" />
              </svg>
            </span>
          </li>
        </ol>

        <div style={modalStyles.actions}>
          <button type="button" onClick={onDismiss} style={modalStyles.dismissBtn}>
            Don't show again
          </button>
          <button type="button" onClick={onClose} style={modalStyles.gotItBtn}>
            Got it
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Styles ───────────────────────────────────────────────────────────────
// Default button style matches the other header action buttons; callers can
// override with their own prop to match local chrome.
const defaultBtnStyle = {
  color: 'rgba(255,255,255,0.75)',
  padding: '6px',
  borderRadius: '8px',
  display: 'flex',
  alignItems: 'center',
}

const modalStyles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    zIndex: 10000,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'center',
    animation: 'installFadeIn 0.2s ease',
  },
  sheet: {
    width: '100%',
    maxWidth: '480px',
    background: 'var(--white)',
    borderTopLeftRadius: '20px',
    borderTopRightRadius: '20px',
    padding: '8px 20px 28px',
    paddingBottom: 'calc(28px + env(safe-area-inset-bottom))',
    boxShadow: '0 -8px 40px rgba(0,0,0,0.25)',
    display: 'flex',
    flexDirection: 'column',
    gap: '18px',
    animation: 'installSlideUp 0.25s cubic-bezier(0.32, 0.72, 0, 1)',
  },
  handle: {
    width: '40px',
    height: '4px',
    borderRadius: '2px',
    background: 'var(--gray-200)',
    alignSelf: 'center',
    marginTop: '6px',
    marginBottom: '4px',
  },
  headerWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    padding: '0 4px',
  },
  title: {
    fontFamily: "'Playfair Display', Georgia, serif",
    fontSize: '22px',
    fontWeight: 700,
    color: 'var(--black)',
    margin: 0,
  },
  subtitle: {
    fontSize: '13px',
    color: 'var(--gray-600)',
    lineHeight: 1.5,
    margin: 0,
  },
  steps: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  step: {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    background: 'var(--off-white)',
    border: '1px solid var(--gray-200)',
    borderRadius: 'var(--radius, 12px)',
    padding: '12px 14px',
  },
  stepNum: {
    flexShrink: 0,
    width: '28px',
    height: '28px',
    borderRadius: '50%',
    background: 'var(--green-dark)',
    color: 'var(--white)',
    fontSize: '13px',
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBody: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  },
  stepText: {
    fontSize: '14px',
    color: 'var(--black)',
    fontWeight: 500,
    lineHeight: 1.35,
  },
  stepHint: {
    fontSize: '12px',
    color: 'var(--gray-400)',
    lineHeight: 1.4,
  },
  stepIcon: {
    flexShrink: 0,
    color: 'var(--green-dark)',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: {
    display: 'flex',
    gap: '10px',
    paddingTop: '4px',
  },
  dismissBtn: {
    flex: 1,
    background: 'transparent',
    color: 'var(--gray-600)',
    border: '1.5px solid var(--gray-200)',
    borderRadius: 'var(--radius-sm, 10px)',
    padding: '12px 16px',
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  gotItBtn: {
    flex: 1,
    background: 'var(--green-dark)',
    color: 'var(--white)',
    border: '1.5px solid var(--green-dark)',
    borderRadius: 'var(--radius-sm, 10px)',
    padding: '12px 16px',
    fontSize: '13px',
    fontWeight: 700,
    cursor: 'pointer',
  },
}

import React, { useEffect, useState } from 'react'

/**
 * HoleEventAnimation
 * Shown as a full-screen overlay when a player reaches the hole
 * that has a weekly hole event (e.g. Closest to the Pin).
 *
 * Props:
 *   holeName  {string}  - e.g. "Closest to the Pin"
 *   holeNum   {number}  - e.g. 5
 *   onDismiss {func}    - called when the player taps to continue
 */
export default function HoleEventAnimation({ holeName, holeNum, onDismiss }) {
  const [phase, setPhase] = useState('enter') // 'enter' | 'show' | 'exit'

  useEffect(() => {
    // Animate in → hold → auto-advance after 4s (player can also tap to skip)
    const t1 = setTimeout(() => setPhase('show'), 50)
    return () => clearTimeout(t1)
  }, [])

  const overlayStyle = {
    position: 'fixed',
    inset: 0,
    zIndex: 9000,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(26, 71, 42, 0.97)',
    transition: 'opacity 0.35s ease',
    opacity: phase === 'show' ? 1 : 0,
    padding: '32px 24px',
    textAlign: 'center',
  }

  return (
    <div style={overlayStyle} onClick={onDismiss}>
      {/* Animated ring */}
      <div style={styles.ring}>
        <div style={styles.innerRing}>
          <span style={styles.emoji}>🎯</span>
        </div>
      </div>

      <div style={styles.holeLabel}>HOLE {holeNum}</div>
      <div style={styles.eventTitle}>{holeName}</div>
      <div style={styles.subText}>
        Closest shot to the flag wins!{'\n'}Keep your eye on your opponent. 👀
      </div>

      <div style={styles.tapHint}>Tap anywhere to continue</div>
    </div>
  )
}

const styles = {
  ring: {
    width: 140,
    height: 140,
    borderRadius: '50%',
    border: '3px solid rgba(255,255,255,0.2)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
    animation: 'pulseRing 1.8s ease-in-out infinite',
  },
  innerRing: {
    width: 108,
    height: 108,
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.1)',
    border: '2px solid rgba(255,255,255,0.35)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    fontSize: 52,
    lineHeight: 1,
    filter: 'drop-shadow(0 0 12px rgba(255,220,100,0.6))',
  },
  holeLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: 'rgba(255,255,255,0.55)',
    letterSpacing: '3px',
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  eventTitle: {
    fontSize: 30,
    fontWeight: 800,
    color: '#ffffff',
    lineHeight: 1.15,
    marginBottom: 16,
    textShadow: '0 2px 12px rgba(0,0,0,0.4)',
  },
  subText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.70)',
    lineHeight: 1.6,
    whiteSpace: 'pre-line',
    maxWidth: 280,
    marginBottom: 40,
  },
  tapHint: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.35)',
    letterSpacing: '0.5px',
  },
}

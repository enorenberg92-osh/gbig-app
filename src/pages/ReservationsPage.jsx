import React from 'react'

const BOOKING_URL = import.meta.env.VITE_BOOKING_URL || 'https://greenbayindoorgolf.com/app-page-booking/'

export default function ReservationsPage() {
  return (
    <div style={styles.container}>
      <iframe
        src={BOOKING_URL}
        style={styles.iframe}
        title="Reserve a Bay"
        frameBorder="0"
        allow="payment"
      />
      {/* Mask the booking site's own "RESERVATIONS" footer text */}
      <div style={styles.bottomMask} />
    </div>
  )
}

const styles = {
  container: {
    height: '100%',
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    position: 'relative',
  },
  iframe: {
    flex: 1,
    width: '100%',
    height: '100%',
    border: 'none',
    display: 'block',
  },
  // Covers the booking site's decorative "RESERVATIONS" text
  // that bleeds through at the bottom of the iframe
  bottomMask: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: '52px',
    background: '#1b4332',
    pointerEvents: 'none',
  },
}

import React from 'react'
import Standings from '../Standings'

// Thin admin wrapper — reuses the full player-facing Standings component.
// Passing no onBack hides the internal dark-green header (admin panel provides its own).
export default function AdminStandings({ session }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Standings session={session} adminMode />
    </div>
  )
}

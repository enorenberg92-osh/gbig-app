import React from 'react'
import LoginScreen from '../components/LoginScreen'
import LeagueDashboard from '../components/LeagueDashboard'

export default function LeaguePage({ session }) {
  if (!session) {
    return <LoginScreen />
  }
  return <LeagueDashboard session={session} />
}

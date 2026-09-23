import React from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button, EmptyState } from './ui'

// Catches render crashes in a page so one bad screen shows a recovery card
// instead of blanking the whole app. App keys this by pathname, so moving to
// another tab clears the error.
export default class ErrorBoundary extends React.Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Screen crashed:', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <EmptyState
        icon={<AlertTriangle size={40} strokeWidth={1.5} />}
        title="Something went wrong on this screen"
        description="Try reloading. If it keeps happening, let your league admin know what you tapped."
        action={
          <Button icon={<RefreshCw size={16} />} onClick={() => window.location.reload()}>
            Reload
          </Button>
        }
        style={{ paddingTop: 64 }}
      />
    )
  }
}

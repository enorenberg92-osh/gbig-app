import { lazy } from 'react'

// React.lazy that survives deploys. A tab opened before a new deploy still
// references the old chunk hashes; those files are gone, so the dynamic
// import rejects. Reload once to pick up the new build instead of leaving a
// blank screen. The sessionStorage flag stops a reload loop if the chunk is
// genuinely unreachable (e.g. offline).
const FLAG = 'chunk-reload-attempted'

export function lazyWithReload(factory) {
  return lazy(() =>
    factory().then(
      (mod) => {
        try { sessionStorage.removeItem(FLAG) } catch { /* storage blocked */ }
        return mod
      },
      (err) => {
        let alreadyTried = false
        try {
          alreadyTried = sessionStorage.getItem(FLAG) === '1'
          if (!alreadyTried) sessionStorage.setItem(FLAG, '1')
        } catch { alreadyTried = true }
        if (!alreadyTried) {
          window.location.reload()
          return new Promise(() => {}) // hold Suspense until the reload lands
        }
        throw err
      },
    ),
  )
}

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import venueInstallPlugin from './scripts/venue-install-plugin.mjs'

export default defineConfig({
  plugins: [react(), venueInstallPlugin()],
})

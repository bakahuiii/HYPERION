import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    watch: {
      // Imported chat archives, avatar caches and Electron's Chromium profile
      // are runtime data, not source modules. Ignoring them prevents a large
      // archive from triggering rescans or UI rebuilds while analysis runs.
      ignored: [
        '**/.hyperion-*/**',
        '**/.exe-*/**',
        '**/release/**',
        '**/release-bin/**',
        '**/data/electron/**',
        '**/node_modules/**',
      ],
    },
    proxy: {
      '/api': `http://127.0.0.1:${process.env.AI_PORT || 8787}`,
    },
  },
})

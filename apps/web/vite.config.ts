import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The Content-Security-Policy this is served under has no 'unsafe-inline' and
// no 'unsafe-eval', so the build must emit external scripts and stylesheets
// only. Vite will otherwise inline small assets as data URIs and inject a tiny
// module-preload polyfill inline, both of which the policy blocks — and the
// failure is a blank page with a console error, not a build error.
export default defineConfig({
  plugins: [react()],
  build: {
    // Never inline an asset as a data: URI.
    assetsInlineLimit: 0,
    // The polyfill is written inline; every browser this targets has module
    // preload already.
    modulePreload: { polyfill: false },
    cssCodeSplit: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    // Talks to the real API in development, so the development build exercises
    // the same paths the deployed one does.
    proxy: {
      '/api': {
        target: process.env['VAULT_API'] ?? 'https://vault-shivam.duckdns.org',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})

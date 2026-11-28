import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: { setupFiles: ['./src/test-setup.ts'] },
  server: {
    proxy: {
      // xfwd: send x-forwarded-host so the server's same-origin terminal gate sees the browser host (changeOrigin rewrites Host to the target).
      '/api': { target: apiProxyTarget, changeOrigin: true, ws: true, xfwd: true },
    },
  },
})

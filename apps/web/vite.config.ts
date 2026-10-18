import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:3000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // xfwd: send x-forwarded-host so the server's same-origin terminal gate sees the browser host (changeOrigin rewrites Host to the target).
      '/api': { target: apiProxyTarget, changeOrigin: true, ws: true, xfwd: true },
    },
  },
})

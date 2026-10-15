import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev mode proxies API + WS to the local Python backend on 8756.
// Production build is served BY the backend itself (webapp/dist).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8756',
      '/ws': { target: 'ws://127.0.0.1:8756', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})

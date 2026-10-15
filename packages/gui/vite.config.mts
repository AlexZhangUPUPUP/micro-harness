import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The GUI talks to a micro-harness server. In dev, Vite proxies /api to it.
const target = process.env.MICRO_SERVER ?? 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.MICRO_GUI_PORT ?? 5273),
    proxy: { '/api': { target, changeOrigin: true } },
  },
  preview: {
    port: Number(process.env.MICRO_GUI_PORT ?? 5273),
    proxy: { '/api': { target, changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})

import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api/weather': {
        target: 'https://api.open-meteo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/weather/, ''),
      },
    },
  },
  resolve: {
    alias: [
      {
        find: 'three/addons',
        replacement: path.resolve(__dirname, 'node_modules/three/examples/jsm'),
      },
      {
        find: 'three',
        replacement: path.resolve(__dirname, 'src/three-mindar-shim.js'),
      },
    ],
  },
})

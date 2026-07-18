import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AdminDashboard from './AdminDashboard.jsx'
import { initAxeraiMobileShell } from './mobileShell.js'
import { unlockMobileSpeechAudio } from './elevenLabsTts.js'

const DASHBOARD_PATH = String(import.meta.env.VITE_DASHBOARD_PATH || 'axerai-insights-7k2m').replace(
  /^\/+|\/+$/g,
  '',
)

const isDashboard =
  window.location.pathname.includes(`/${DASHBOARD_PATH}`) ||
  window.location.hash === `#${DASHBOARD_PATH}`

if (!isDashboard) {
  initAxeraiMobileShell()
  // No extra "Tap for sound" UI — unlock on the first real touch/click (camera allow, etc.).
  const unlockOnce = () => {
    unlockMobileSpeechAudio({ force: true, speechPing: true })
  }
  document.addEventListener('pointerdown', unlockOnce, { capture: true, passive: true })
  document.addEventListener('touchstart', unlockOnce, { capture: true, passive: true })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>{isDashboard ? <AdminDashboard /> : <App />}</StrictMode>,
)

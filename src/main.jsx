import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AdminDashboard from './AdminDashboard.jsx'
import { initAxeraiMobileShell } from './mobileShell.js'

const DASHBOARD_PATH = String(import.meta.env.VITE_DASHBOARD_PATH || 'axerai-insights-7k2m').replace(
  /^\/+|\/+$/g,
  '',
)

const isDashboard =
  window.location.pathname.includes(`/${DASHBOARD_PATH}`) ||
  window.location.hash === `#${DASHBOARD_PATH}`

if (!isDashboard) {
  initAxeraiMobileShell()
}

createRoot(document.getElementById('root')).render(
  <StrictMode>{isDashboard ? <AdminDashboard /> : <App />}</StrictMode>,
)

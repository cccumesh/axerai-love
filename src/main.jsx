import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AdminDashboard from './AdminDashboard.jsx'

const isDashboard =
  window.location.pathname.endsWith('/dashboard') || window.location.hash === '#dashboard'

createRoot(document.getElementById('root')).render(
  <StrictMode>{isDashboard ? <AdminDashboard /> : <App />}</StrictMode>,
)

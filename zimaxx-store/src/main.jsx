import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { LanguageProvider } from './i18n'
import { CartProvider } from './context/CartContext'
import { initTheme } from './theme'
import { installGlobalErrorLogging } from './utils/systemLog'
import './index.css'

// Aplicar el tema antes del primer render para evitar flash de modo claro.
initTheme()

// Errores JS no atrapados (window.onerror + unhandledrejection) quedan en
// system_logs (2026-08-20) — hasta hoy morían en la consola del navegador del
// cliente y nadie se enteraba. Con throttle: máx. 5 por minuto y nunca el
// mismo mensaje dos veces seguidas. Va antes del primer render para atrapar
// también un error de montaje.
installGlobalErrorLogging()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <LanguageProvider>
        <CartProvider>
          <App />
        </CartProvider>
      </LanguageProvider>
    </BrowserRouter>
  </React.StrictMode>,
)

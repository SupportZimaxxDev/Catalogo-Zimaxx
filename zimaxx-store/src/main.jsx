import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import { LanguageProvider } from './i18n'
import { CartProvider } from './context/CartContext'
import { initTheme } from './theme'
import './index.css'

// Aplicar el tema antes del primer render para evitar flash de modo claro.
initTheme()

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

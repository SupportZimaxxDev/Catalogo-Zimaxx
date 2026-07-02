import { useState } from 'react'
import { isDark, setTheme } from '../theme'

// Botón sol/luna para el header (fondo tinta en ambos modos).
export default function ThemeToggle() {
  const [dark, setDark] = useState(isDark)

  const toggle = () => {
    const next = !dark
    setTheme(next ? 'dark' : 'light')
    setDark(next)
  }

  return (
    <button
      onClick={toggle}
      aria-label={dark ? 'Modo día' : 'Modo noche'}
      title={dark ? 'Modo día' : 'Modo noche'}
      className="flex h-8 w-8 items-center justify-center rounded-full border border-white/20 text-white/70 transition-colors hover:border-secondary hover:text-secondary"
    >
      {dark ? (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      )}
    </button>
  )
}

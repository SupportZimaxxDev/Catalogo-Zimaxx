// Tema día/noche: sigue al sistema por defecto; si el usuario elige
// manualmente, esa preferencia queda en localStorage y manda sobre el
// sistema. ?theme=dark|light en la URL fuerza el tema solo para esa
// visita (útil para previews) sin persistirlo.

const KEY = 'zimaxx_theme'

function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function getStoredTheme() {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'dark' || v === 'light' ? v : null
  } catch {
    return null
  }
}

function urlTheme() {
  const v = new URLSearchParams(window.location.search).get('theme')
  return v === 'dark' || v === 'light' ? v : null
}

export function applyTheme() {
  const pref = urlTheme() ?? getStoredTheme()
  const dark = pref ? pref === 'dark' : systemPrefersDark()
  document.documentElement.classList.toggle('dark', dark)
}

export function setTheme(pref) {
  try {
    if (pref) localStorage.setItem(KEY, pref)
    else localStorage.removeItem(KEY)
  } catch {
    /* modo incógnito sin storage: el tema aplica igual, solo no persiste */
  }
  applyTheme()
}

export function isDark() {
  return document.documentElement.classList.contains('dark')
}

export function initTheme() {
  applyTheme()
  // Si no hay elección manual, seguir los cambios del sistema en vivo.
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => {
      if (!getStoredTheme() && !urlTheme()) applyTheme()
    })
}

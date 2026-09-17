export function money(n) {
  return `$${Number(n ?? 0).toFixed(2)}`
}

export function cleanPhone(phone) {
  return String(phone ?? '').replace(/\D/g, '')
}

// wa.me exige el número completo CON código de país, sin "+" (ej.
// 13055551234, no 3055551234). Un número de 10 dígitos sin código a
// veces "funciona" en WhatsApp Android porque adivina el país del
// dispositivo, pero en iPhone el link simplemente no abre el chat — no
// hay forma de saberlo hasta que un cliente con iPhone se queja. En vez
// de adivinar qué código de país falta (podría meter uno equivocado),
// se valida un mínimo de dígitos: todo país real, con código incluido,
// tiene 11+ dígitos.
export function hasCountryCode(phone) {
  return cleanPhone(phone).length >= 11
}

// ---------- Fechas del panel (2026-09-11 → compartidas 2026-09-17) ----------
// Nacieron dentro de OrdersAdmin.jsx para el cuadro de fallos ("📅 mar, 8
// sept. 2026, 03:00 p. m. · hace 3 días"); se movieron acá para que la
// campanita de avisos y el cuadro "Pedidos recuperados" digan las fechas
// exactamente igual, en el idioma del panel, sin tres copias de lo mismo.
export const panelLocale = (lang) => (lang === 'en' ? 'en-US' : 'es-VE')

export function fmtDateTime(iso, lang) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(panelLocale(lang), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function fmtDay(date, lang) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(panelLocale(lang), { day: 'numeric', month: 'short', year: 'numeric' })
}

// Días de calendario local entre `iso` y hoy (no bloques de 24 h: algo de
// anoche a las 23:00 es "ayer" aunque hayan pasado 9 horas). null si la
// fecha no se puede leer.
export function calendarDaysAgo(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  return Math.round((dayStart(new Date()) - dayStart(d)) / 86400000)
}

// "hoy" / "ayer" / "hace N días" con las claves i18n del cuadro de fallos.
export function agoLabel(iso, t) {
  const days = calendarDaysAgo(iso)
  if (days === null) return null
  if (days <= 0) return t('failureAgoToday')
  if (days === 1) return t('failureAgoYesterday')
  return t('failureAgoDays', { n: days })
}

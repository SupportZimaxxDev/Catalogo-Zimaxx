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

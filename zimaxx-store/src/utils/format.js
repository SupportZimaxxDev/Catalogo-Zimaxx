export function money(n) {
  return `$${Number(n ?? 0).toFixed(2)}`
}

export function cleanPhone(phone) {
  return String(phone ?? '').replace(/\D/g, '')
}

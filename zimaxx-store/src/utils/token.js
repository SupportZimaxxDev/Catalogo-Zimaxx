// Token no adivinable de 10 caracteres alfanuméricos (sin caracteres
// ambiguos tipo 0/O, 1/l) generado con crypto.getRandomValues.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function generateToken(length = 10) {
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

// SKU interno autogenerado cuando el Excel de productos no trae uno.
// Solo se usa para identificar el producto puertas adentro: nunca se
// muestra en el catálogo del cliente.
const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g')

export function generateSku(name) {
  const base = String(name ?? '')
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return `${base || 'PROD'}-${generateToken(5)}`
}

// Búsqueda del catálogo del cliente (2026-10-02).
//
// El bug: la marca/diseñador NO está en el nombre del producto — llega en su
// propia columna (`category`, el PRODUCTBRAND de SellerCloud): marca
// "Mont Blanc", nombre "Legend 3.3 Oz Edp Men". El buscador viejo pedía que
// la frase entera apareciera dentro de UN campo, así que "mont blanc legend"
// o "valentino born in roma" daban cero resultados, y es justo como un
// cliente pide un perfume.
//
// A diferencia de `matchesTerms` (utils/search.js, el del panel), acá los
// términos SÍ se reparten entre marca y nombre: marca + nombre describen UN
// producto, no son dos personas distintas que puedan dar un falso positivo.
// El UPC va aparte: es un código, se busca entero.
import { normalizeText, searchTerms } from './search.js'

// Siglas y apodos con que se piden las marcas en el negocio. Las iniciales de
// las marcas de varias palabras salen solas (ver brandKey); acá va lo que no
// se deduce del nombre.
const BRAND_ALIASES = {
  'dolce & gabbana': 'd&g dg',
  'cristiano ronaldo': 'cr7',
  bvlgari: 'bulgari',
  'giorgio armani': 'armani',
  'christian dior': 'dior',
  'yves saint laurent': 'ysl saint laurent',
  'thierry mugler': 'mugler',
}

const compact = (s) => s.replace(/[^a-z0-9]/g, '')

// Texto buscable de una marca: el nombre normalizado, sus iniciales si tiene
// varias palabras ("Carolina Herrera" → "ch", "Jean Paul Gaultier" → "jpg")
// y los alias de arriba.
export function brandKey(brand) {
  const n = normalizeText(brand).trim()
  if (!n) return ''
  const words = n.split(/[^a-z0-9]+/).filter(Boolean)
  const initials = words.length > 1 ? words.map((w) => w[0]).join('') : ''
  return [n, initials, BRAND_ALIASES[n] ?? ''].filter(Boolean).join(' ')
}

// Se arma UNA vez por carga del catálogo (Catalog.jsx, en `enriched`), no en
// cada tecla: son miles de productos.
export function productSearchKey(p, lineLabel = (l) => l) {
  const text = normalizeText(
    [brandKey(p.category), p.name, p.product_line, p.product_line ? lineLabel(p.product_line) : '']
      .filter(Boolean)
      .join(' '),
  )
  // `compact` hace que "montblanc" encuentre "Mont Blanc" y "jeanpaul" a
  // "Jean Paul": los nombres de marca se escriben juntos o separados según
  // quién los tipee.
  return { text, compact: compact(text), upc: normalizeText(p.upc) }
}

const termHits = (key, t) => key.text.includes(t) || (compact(t) !== '' && key.compact.includes(compact(t)))

export function matchesProduct(terms, key) {
  if (terms.length === 0) return true
  if (terms.every((t) => termHits(key, t))) return true
  // UPC: solo si lo que se tipeó es un único código.
  return terms.length === 1 && key.upc !== '' && key.upc.includes(terms[0])
}

// Marcas que responden a la consulta, para las sugerencias bajo el buscador.
// `brands` = [{ name, count }]. Solo con 2+ letras: con una sola salen casi
// todas y no ayudan.
export function suggestBrands(query, brands, limit = 4) {
  const terms = searchTerms(query)
  if (terms.length === 0 || terms.join('').length < 2) return []
  return brands
    .map((b) => {
      const key = brandKey(b.name)
      const k = { text: key, compact: compact(key) }
      if (!terms.every((t) => termHits(k, t))) return null
      // Primero las que EMPIEZAN con lo tipeado, después por tamaño.
      const starts = normalizeText(b.name).startsWith(terms[0]) || compact(normalizeText(b.name)).startsWith(compact(terms.join('')))
      return { ...b, starts }
    })
    .filter(Boolean)
    .sort((a, b) => (a.starts === b.starts ? b.count - a.count : a.starts ? -1 : 1))
    .slice(0, limit)
}

export { searchTerms }

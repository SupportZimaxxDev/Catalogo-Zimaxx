// Tests del buscador del catálogo del cliente (src/utils/catalogSearch.js),
// en Node, sin navegador. Correr con `node tests/catalog-search-tests.mjs`.
//
// Los productos son filas reales de producción (2026-10-02): la marca vive en
// `category` y NO se repite en el nombre — por eso "mont blanc legend" daba
// cero resultados con el buscador viejo.
import { matchesProduct, productSearchKey, searchTerms, suggestBrands } from '../src/utils/catalogSearch.js'

let passed = 0
let failed = 0
const ok = (cond, msg) => {
  if (cond) {
    passed++
    console.log(`  ✓ ${msg}`)
  } else {
    failed++
    console.log(`  ✗ ${msg}`)
  }
}

const lineLabel = (l) => (l === 'Perfume' ? 'Diseñador' : l === 'Perfume - Arabes' ? 'Árabes' : l)
const PRODUCTS = [
  { id: 1, category: 'Mont Blanc', name: 'Legend 3.3 Oz Edp Men', product_line: 'Perfume', upc: '3386460032698' },
  { id: 2, category: 'Valentino', name: 'Set  Uomo Born In Roma 3.4 Oz Edt M + 10Ml Men', product_line: 'Perfume' },
  { id: 3, category: 'Lattafa', name: 'Fakhar Gold Extrait 3.4 Oz Edp Women', product_line: 'Perfume - Arabes' },
  { id: 4, category: 'Yves Saint Laurent', name: 'Y 3.3 Oz Edp Men', product_line: 'Perfume' },
  { id: 5, category: 'Carolina Herrera', name: '212 Vip Black 3.4 Oz Edp Men', product_line: 'Perfume' },
  { id: 6, category: 'Dolce & Gabbana', name: 'Light Blue 3.3 Oz Edt Women', product_line: 'Perfume' },
  { id: 7, category: 'Lancome', name: 'La Vie Est Belle 3.4 Oz Edp Women', product_line: 'Perfume' },
  { id: 8, category: 'Jean Paul Gaultier', name: 'Le Male Elixir 4.2 Oz Parfum Men', product_line: 'Perfume' },
  { id: 9, category: null, name: 'Sin Marca 1 Oz', product_line: null },
]
const keys = PRODUCTS.map((p) => ({ id: p.id, key: productSearchKey(p, lineLabel) }))
const search = (q) => {
  const terms = searchTerms(q)
  return keys.filter((k) => matchesProduct(terms, k.key)).map((k) => k.id)
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

console.log('Marca + nombre')
ok(same(search('mont blanc legend'), [1]), '"mont blanc legend" → Legend de Mont Blanc')
ok(same(search('legend montblanc'), [1]), 'en cualquier orden y con la marca junta')
ok(same(search('valentino born in roma'), [2]), '"valentino born in roma"')
ok(same(search('lattafa fakhar'), [3]), '"lattafa fakhar"')
ok(same(search('LANCÔME la vie'), [7]), 'sin acentos ni mayúsculas')
ok(same(search('valentino'), [2]), 'solo la marca')

console.log('Siglas y alias')
ok(search('ysl').includes(4), 'ysl → Yves Saint Laurent')
ok(search('ch 212').includes(5), 'ch 212 → Carolina Herrera 212')
ok(search('d&g light blue').includes(6), 'd&g light blue')
ok(search('dg light').includes(6), 'dg light')
ok(search('jpg le male').includes(8), 'jpg le male')

console.log('Línea y UPC')
ok(same(search('arabes'), [3]), 'la etiqueta de la línea también se busca')
ok(same(search('3386460032698'), [1]), 'UPC completo')
ok(same(search('33864600'), [1]), 'UPC parcial')
ok(same(search('3386460032698 legend'), []), 'el UPC no se mezcla con otros términos')

console.log('Sin falsos positivos ni roturas')
ok(same(search('mont blanc light blue'), []), 'términos de dos productos distintos no matchean')
ok(search('sin marca').includes(9), 'producto sin marca ni línea no rompe')
ok(search('').length === PRODUCTS.length, 'consulta vacía = todo')

console.log('Sugerencias de marca')
const BRANDS = [
  { name: 'Lattafa', count: 112 },
  { name: 'Lancome', count: 9 },
  { name: 'Lacoste', count: 6 },
  { name: 'Mont Blanc', count: 13 },
  { name: 'Yves Saint Laurent', count: 8 },
  { name: 'Maison Alhambra', count: 25 },
]
ok(suggestBrands('lat', BRANDS).map((b) => b.name)[0] === 'Lattafa', '"lat" → Lattafa')
ok(same(suggestBrands('montbl', BRANDS).map((b) => b.name), ['Mont Blanc']), '"montbl" → Mont Blanc')
ok(suggestBrands('ysl', BRANDS)[0]?.name === 'Yves Saint Laurent', '"ysl" → Yves Saint Laurent')
ok(suggestBrands('l', BRANDS).length === 0, 'una sola letra no sugiere')
ok(suggestBrands('la', BRANDS)[0]?.name === 'Lattafa', 'las que empiezan con lo tipeado van primero, por tamaño')
ok(suggestBrands('legend', BRANDS).length === 0, 'un nombre de perfume no sugiere marcas')

console.log(`\n${passed} ok, ${failed} fallaron`)
process.exit(failed ? 1 : 0)

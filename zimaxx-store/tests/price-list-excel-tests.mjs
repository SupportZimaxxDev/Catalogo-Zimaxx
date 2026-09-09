// Tests del Excel de la lista de precios (utils/excel.js) en Node, sin
// navegador. Correr con `node tests/price-list-excel-tests.mjs`.
//
// El módulo bajo prueba es el real: priceListExcelRows arma las filas desde el
// shape de get_catalog (catálogo del cliente) o de la matriz del panel, y
// buildPriceListWorkbook arma el workbook con SheetJS SIN escribirlo — acá se
// serializa a buffer y se vuelve a leer, así lo que se comprueba es lo que
// abriría el cliente en Excel, no un objeto intermedio.
//
// Foco (2026-09-08, "Excel de la lista de precios para el cliente"):
//   * membrete arriba (título + líneas de contexto), fila en blanco, tabla
//   * precios como NÚMERO con formato de moneda (sumables), no texto "$22.00"
//   * columna Precio ausente para la lista `quote` (catálogo sin precios)
//   * columna SKU solo desde el panel (withSku)
//   * disponibilidad traducida con el diccionario del catálogo
//   * autofiltro sobre la tabla; celdas vacías sin crear (null, no '')
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

// pathToFileURL: en Windows un path absoluto pelado no es un especificador ESM
// válido ("Received protocol 'c:'"), igual que en outbox-tests.mjs.
const here = dirname(fileURLToPath(import.meta.url))
const { priceListExcelRows, buildPriceListWorkbook, fileSlug } = await import(
  pathToFileURL(join(here, '..', 'src', 'utils', 'excel.js')).href
)
const XLSX = await import('xlsx')

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

// Diccionario mínimo: las MISMAS claves que usa el código real.
const es = {
  upc: 'UPC',
  product: 'Producto',
  inStock: 'Disponible',
  preorder: 'Pre-Order',
  flashSale: 'Flash Sale',
  excelColSku: 'SKU',
  excelColBrand: 'Marca',
  excelColLine: 'Línea',
  excelColAvailability: 'Disponibilidad',
  excelColPrice: 'Precio',
  lineDesigner: 'Diseñador',
  lineArabic: 'Árabes',
}
const t = (k) => es[k] ?? k
const lineLabel = (raw) =>
  raw === 'Perfume' ? t('lineDesigner') : raw === 'Perfume - Arabes' ? t('lineArabic') : raw

// Shape de get_catalog (sin sku, con upc), como llega al catálogo del cliente.
const catalogProducts = [
  {
    id: 'a',
    name: 'Adidas Ice Dive Men 100ml',
    upc: '3614272049901',
    category: 'Adidas',
    product_line: 'Perfume',
    availability: 'available',
    price: '22.5',
  },
  {
    id: 'b',
    name: 'Lattafa Asad Unisex 100ml',
    upc: null,
    category: 'Lattafa',
    product_line: 'Perfume - Arabes',
    availability: 'preorder',
    price: 18,
  },
  {
    id: 'c',
    name: 'Muestra sin código',
    upc: '',
    category: null,
    product_line: null,
    availability: 'flash',
    price: 1234.5,
  },
]

function roundTrip(wb) {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellStyles: true })
  return XLSX.read(buf, { type: 'buffer', cellStyles: true })
}
const cell = (ws, addr) => ws[addr]
const grid = (ws) => XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true })

// ---------- 1. Filas desde el shape del catálogo ----------
console.log('\n1. priceListExcelRows — catálogo del cliente (sin SKU, con precios)')
{
  const table = priceListExcelRows({ t, products: catalogProducts, lineLabel })
  ok(
    JSON.stringify(table.header) ===
      JSON.stringify(['UPC', 'Marca', 'Producto', 'Línea', 'Disponibilidad', 'Precio']),
    'encabezado UPC · Marca · Producto · Línea · Disponibilidad · Precio (sin SKU)',
  )
  ok(table.priceCol === 5, 'priceCol apunta a la última columna')
  ok(table.rows.length === 3, 'una fila por producto')
  ok(table.rows[0][0] === '3614272049901' && typeof table.rows[0][0] === 'string', 'el UPC va como texto (no pierde ceros ni pasa a notación científica)')
  ok(table.rows[0][5] === 22.5 && typeof table.rows[0][5] === 'number', 'el precio string "22.5" de get_catalog pasa a número')
  ok(table.rows[0][3] === 'Diseñador' && table.rows[1][3] === 'Árabes', 'la línea sale traducida con lineLabel')
  ok(
    table.rows[0][4] === 'Disponible' && table.rows[1][4] === 'Pre-Order' && table.rows[2][4] === 'Flash Sale',
    'disponibilidad traducida con el diccionario del catálogo',
  )
  ok(table.rows[1][0] === null && table.rows[2][0] === null, 'UPC null y UPC "" salen como null (celda sin crear)')
  ok(table.rows[2][1] === null && table.rows[2][3] === null, 'marca y línea faltantes salen como null')
  ok(table.widths.length === table.header.length, 'un ancho por columna')
}

// ---------- 2. withSku (panel) ----------
console.log('\n2. priceListExcelRows — panel (withSku)')
{
  const table = priceListExcelRows({
    t,
    products: catalogProducts.map((p, i) => ({ ...p, sku: i === 2 ? '' : `SKU-${p.id}` })),
    lineLabel,
    withSku: true,
  })
  ok(table.header[0] === 'SKU' && table.header[1] === 'UPC', 'el SKU va primero y corre el resto')
  ok(table.rows[0][0] === 'SKU-a', 'la fila trae el SKU')
  ok(table.rows[2][0] === null, 'SKU vacío → null')
  ok(table.priceCol === 6 && table.rows[1][6] === 18, 'priceCol se corre con la columna extra')
}

// ---------- 3. Lista quote: sin columna Precio ----------
console.log('\n3. priceListExcelRows — lista quote (sin precios)')
{
  const table = priceListExcelRows({
    t,
    products: catalogProducts.map((p) => ({ ...p, price: null })),
    lineLabel,
  })
  ok(!table.header.includes('Precio'), 'no hay columna Precio')
  ok(table.priceCol === -1, 'priceCol = -1')
  ok(table.rows.every((r) => r.length === 5), 'las filas tienen 5 celdas')
}

// ---------- 4. Workbook: membrete + tabla + formato ----------
console.log('\n4. buildPriceListWorkbook — archivo leído de vuelta')
{
  const table = priceListExcelRows({ t, products: catalogProducts, lineLabel })
  const wb = buildPriceListWorkbook(XLSX, {
    ...table,
    title: 'Zimaxx Store — Lista de precios',
    metaLines: ['Cliente: Perfumería Sol', 'Generado: hoy'],
    sheetName: 'Lista de precios',
  })
  const back = roundTrip(wb)
  ok(back.SheetNames[0] === 'Lista de precios', 'nombre de hoja')
  const ws = back.Sheets[back.SheetNames[0]]
  const g = grid(ws)
  ok(g[0][0] === 'Zimaxx Store — Lista de precios', 'fila 1: título')
  ok(g[1][0] === 'Cliente: Perfumería Sol' && g[2][0] === 'Generado: hoy', 'filas 2-3: líneas de contexto')
  ok((g[3] ?? []).every((c) => c === null), 'fila 4: en blanco')
  ok(JSON.stringify(g[4]) === JSON.stringify(table.header), 'fila 5: encabezados de la tabla')
  ok(g[5][2] === 'Adidas Ice Dive Men 100ml' && g[7][2] === 'Muestra sin código', 'filas 6+: productos en orden')
  const priceCell = cell(ws, 'F6')
  ok(priceCell?.t === 'n' && priceCell.v === 22.5, 'F6 es numérica (22.5)')
  ok(priceCell?.z === '"$"#,##0.00', 'F6 lleva formato de moneda')
  ok(cell(ws, 'F8')?.v === 1234.5 && cell(ws, 'F8')?.z === '"$"#,##0.00', 'F8 también (1234.5)')
  ok(cell(ws, 'F5')?.t === 's' && cell(ws, 'F5').v === 'Precio', 'el encabezado Precio NO recibe formato numérico')
  ok(cell(ws, 'A7') === undefined && cell(ws, 'A8') === undefined, 'los UPC null no crean celda')
  ok(cell(ws, 'B8') === undefined && cell(ws, 'D8') === undefined, 'marca y línea faltantes tampoco')
  ok(ws['!autofilter']?.ref === 'A5:F8', 'autofiltro sobre la tabla (A5:F8), no sobre el membrete')
  ok(Array.isArray(ws['!cols']) && ws['!cols'][2].wch === 60, 'ancho de la columna Producto')
}

// ---------- 5. Workbook sin filas y sin precios ----------
console.log('\n5. buildPriceListWorkbook — casos borde')
{
  const empty = buildPriceListWorkbook(XLSX, {
    title: 'T',
    header: ['UPC', 'Producto'],
    rows: [],
    widths: [10, 10],
    sheetName: 'Vacía',
  })
  const ws = empty.Sheets['Vacía']
  ok(ws['!autofilter'] === undefined, 'sin filas no se pone autofiltro (Excel lo rechaza)')
  ok(cell(ws, 'A3')?.v === 'UPC', 'sin metaLines el encabezado queda en la fila 3 (título, blanco, tabla)')

  const quote = buildPriceListWorkbook(XLSX, {
    ...priceListExcelRows({ t, products: catalogProducts.map((p) => ({ ...p, price: null })), lineLabel }),
    title: 'Zimaxx Store — Catálogo',
    metaLines: ['Cliente: X'],
    sheetName: 'Catálogo',
  })
  const wq = roundTrip(quote).Sheets['Catálogo']
  // título (1) + 1 línea de contexto (2) + blanco (3) + encabezado (4) + 3 filas (5-7)
  ok(wq['!autofilter']?.ref === 'A4:E7', 'quote: tabla de 5 columnas (A4:E7)')
  ok(Object.keys(wq).every((k) => k.startsWith('!') || !/^F\d+$/.test(k)), 'quote: ninguna celda en la columna F')
}

// ---------- 6. fileSlug ----------
console.log('\n6. fileSlug')
{
  ok(fileSlug('Perfumería Sol & Cía.') === 'perfumeria-sol-cia', 'sin acentos, minúsculas, guiones')
  ok(fileSlug('  ---Ñandú---  ') === 'nandu', 'recorta guiones de los bordes')
  ok(fileSlug('x'.repeat(100)).length === 40, 'tope de 40 caracteres')
  ok(fileSlug(null) === '' && fileSlug(undefined) === '', 'null/undefined → ""')
  ok(fileSlug('us_wholesale') === 'us-wholesale', 'el code de una lista queda legible')
}

console.log(`\n${passed} OK, ${failed} fallidas`)
process.exit(failed === 0 ? 0 : 1)

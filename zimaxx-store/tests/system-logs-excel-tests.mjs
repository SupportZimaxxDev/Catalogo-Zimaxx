// Tests del Excel de la pestaña ⚙️ Sistema (utils/excel.js) en Node, sin
// navegador. Correr con `node tests/system-logs-excel-tests.mjs`.
//
// systemLogsExcelRows aplana el `context` jsonb de cada fila en columnas (una
// por clave, en orden de aparición, con etiqueta si se conoce) y
// buildTableWorkbook arma el workbook con membrete + tabla + autofiltro. Acá se
// serializa a buffer y se vuelve a leer, así lo que se comprueba es lo que
// abriría el superadmin en Excel (2026-09-09, "exportar un excel con los
// datos que se filtren").
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const { systemLogsExcelRows, buildTableWorkbook } = await import(
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

// Diccionario mínimo con las MISMAS claves que usa el código real.
const es = {
  date: 'Fecha',
  systemSeverity: 'Severidad',
  systemSource: 'Origen',
  systemEvent: 'Evento',
  systemMessage: 'Mensaje',
  systemContext: 'Detalle',
  yes: 'Sí',
  no: 'No',
}
const t = (k) => es[k] ?? k
const labels = { client_id: 'ID cliente', name: 'Cliente', phone: 'Teléfono', price_list: 'Lista de precio', via: 'Vía', sellercloud_requested: 'Crear en SellerCloud' }
const stamp = (iso) => `F(${iso})`

const rows = [
  {
    id: 3,
    created_at: '2026-09-09T15:00:00Z',
    severity: 'info',
    source: 'clients',
    event: 'client_created',
    message: 'Pedro Gómez · 17865559999',
    context: {
      client_id: 'c-1',
      name: 'Pedro Gómez',
      phone: '17865559999',
      email: null,
      price_list: 'US Wholesale ($2,000+)',
      via: 'formulario',
      sellercloud_requested: true,
      comments: 'Mayorista',
    },
  },
  {
    id: 2,
    created_at: '2026-09-09T14:00:00Z',
    severity: 'error',
    source: 'sellercloud_customers',
    event: 'create_failed',
    message: 'boom',
    context: { client_id: 'c-2', client: 'Ana', applied: ['Phone1', 'Comments'], nested: { a: 1 } },
  },
  { id: 1, created_at: '2026-09-09T13:00:00Z', severity: 'warning', source: 'frontend', event: 'js_error', message: null, context: {} },
]

console.log('systemLogsExcelRows: columnas fijas + context aplanado')
{
  const table = systemLogsExcelRows({ t, rows, labels, stamp })
  ok(
    table.header.slice(0, 5).join('|') === 'Fecha|Severidad|Origen|Evento|Mensaje',
    'las 5 columnas fijas primero',
  )
  const ctxCols = table.header.slice(5)
  ok(
    ctxCols.join('|') === 'ID cliente|Cliente|Teléfono|email|Lista de precio|Vía|Crear en SellerCloud|comments|client|applied|nested',
    `claves del context en orden de aparición, etiquetadas si se conocen (${ctxCols.join('|')})`,
  )
  ok(table.contextKeys.length === 11 && table.rows.length === 3, '11 claves, 3 filas')
  const r0 = table.rows[0]
  ok(r0[0] === 'F(2026-09-09T15:00:00Z)', 'fecha pasa por stamp (inyectable)')
  ok(r0[1] === 'info' && r0[2] === 'clients' && r0[3] === 'client_created' && r0[4] === 'Pedro Gómez · 17865559999', 'columnas fijas de la fila')
  ok(r0[5] === 'c-1' && r0[6] === 'Pedro Gómez' && r0[7] === '17865559999', 'valores del context en sus columnas')
  ok(r0[8] === null, 'null del context → celda vacía (null, no "")')
  ok(r0[11] === 'Sí', 'booleano → Sí/No')
  const r1 = table.rows[1]
  ok(r1[5] === 'c-2' && r1[13] === 'Ana', 'claves que solo tiene la segunda fila caen en su columna')
  ok(r1[14] === '["Phone1","Comments"]' && r1[15] === '{"a":1}', 'arrays/objetos anidados → JSON en la celda')
  ok(r1[6] === null && r1[9] === null, 'claves ausentes en una fila → vacías')
  const r2 = table.rows[2]
  ok(r2[4] === null && r2.slice(5).every((v) => v === null), 'fila sin mensaje ni context: solo las fijas')
  ok(table.widths.length === table.header.length, 'un ancho por columna')
}

console.log('systemLogsExcelRows: tope de columnas de context')
{
  const wide = [{ id: 1, created_at: '2026-09-09T13:00:00Z', severity: 'info', source: 'x', event: 'e', message: null, context: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`k${i}`, i])) }]
  const table = systemLogsExcelRows({ t, rows: wide, labels: {}, stamp, maxContextCols: 4 })
  ok(table.header.length === 5 + 4 + 1 && table.header.at(-1) === 'Detalle', 'las que sobran van juntas en una última columna "Detalle"')
  ok(table.rows[0].at(-1) === '{"k4":4,"k5":5}', 'la columna de sobrantes es un JSON con solo esas claves')
}

console.log('buildTableWorkbook: membrete + tabla + autofiltro, leído de vuelta')
{
  const table = systemLogsExcelRows({ t, rows, labels, stamp })
  const wb = buildTableWorkbook(XLSX, {
    title: 'Zimaxx Store — Logs del sistema',
    metaLines: ['Filtro: info · clients', 'Generado: hoy · 3 resultados'],
    header: table.header,
    rows: table.rows,
    widths: table.widths,
    priceCol: -1,
    sheetName: 'Sistema',
  })
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const back = XLSX.read(buf, { type: 'buffer' })
  ok(back.SheetNames[0] === 'Sistema', 'hoja "Sistema"')
  const ws = back.Sheets.Sistema
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
  ok(aoa[0][0] === 'Zimaxx Store — Logs del sistema', 'título en A1')
  ok(aoa[1][0] === 'Filtro: info · clients' && aoa[2][0] === 'Generado: hoy · 3 resultados', 'líneas de contexto')
  ok(aoa[3].every((v) => v === null), 'fila en blanco antes de la tabla')
  ok(aoa[4].join('|') === table.header.join('|'), 'encabezados en la fila 5')
  ok(aoa[5][6] === 'Pedro Gómez' && aoa[6][14] === '["Phone1","Comments"]', 'datos en su lugar tras releer')
  // 3 líneas de membrete + blanco → encabezado en la fila 5; 3 filas de datos
  // → la última es la 8. 16 columnas (5 fijas + 11 de context) → P.
  ok(ws['!autofilter']?.ref === 'A5:P8', `autofiltro sobre la tabla (${ws['!autofilter']?.ref})`)
  // Los anchos se comprueban en el workbook construido: XLSX.read no los
  // vuelve a poblar sin cellStyles.
  ok(wb.Sheets.Sistema['!cols']?.length === table.header.length, 'anchos de columna')
}

console.log(`\n${passed} OK, ${failed} fallidas`)
process.exit(failed ? 1 : 0)

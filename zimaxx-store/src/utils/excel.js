const DIACRITICS = new RegExp('[\\u0300-\\u036f]', 'g')

// Columnas que delatan la fila de encabezados en cualquiera de nuestros
// formatos (productos, precios, clientes, listas con membrete arriba).
const HEADER_HINT =
  /sku|codigo|c[oó]digo|upc|producto|product|nombre|name|title|price|precio|telefono|phone|cliente|client|brand|marca|type|tipo|qty|cantidad/i

// Lee la primera hoja de un Excel/CSV y devuelve filas como objetos
// { encabezado: valor } con encabezados normalizados a minúsculas sin
// acentos. Los archivos reales suelen traer membrete/título antes de la
// tabla: se busca la primera fila con 2+ celdas que parezcan encabezados
// y se parsea desde ahí. SheetJS se carga bajo demanda: solo pesa en el
// panel admin al subir archivos.
export async function parseSheet(file) {
  const XLSX = await import('xlsx')
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array' })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const grid = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false, header: 1 })

  let headerIdx = 0
  for (let i = 0; i < Math.min(grid.length, 25); i++) {
    const hits = (grid[i] ?? []).filter(
      (c) => typeof c === 'string' && c.trim() && HEADER_HINT.test(c),
    ).length
    if (hits >= 2) {
      headerIdx = i
      break
    }
  }

  const headers = (grid[headerIdx] ?? []).map((h) => normalizeHeader(h))
  return grid
    .slice(headerIdx + 1)
    .filter((r) => (r ?? []).some((c) => String(c).trim() !== ''))
    .map((r) => {
      const out = {}
      headers.forEach((h, i) => {
        if (!h) return
        const v = r[i]
        out[h] = typeof v === 'string' ? v.trim() : (v ?? '')
      })
      return out
    })
}

// Exporta un pedido en el formato de UploadTemplate.xls (el bulk-order
// upload de SellerCloud): mismo orden y nombre de columnas exacto para
// poder subirlo ahí sin retocarlo. 'Zimaxx' es el único almacén propio,
// así que va fijo en todas las filas.
export async function downloadOrderExcel(items, filenameStamp) {
  const XLSX = await import('xlsx')
  const rows = items.map((i) => ({
    ProductID: i.sku,
    ProductName: i.name,
    UnitPrice: i.price ?? '',
    Qty: i.qty,
    ShipFromWarehouseName: 'Zimaxx',
  }))
  const ws = XLSX.utils.json_to_sheet(rows, {
    header: ['ProductID', 'ProductName', 'UnitPrice', 'Qty', 'ShipFromWarehouseName'],
  })
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  XLSX.writeFile(wb, `zimaxx-order-${filenameStamp}.xlsx`)
}

// Exporta los productos sin foto en el MISMO formato que acepta la carga
// "Fotos por Excel" de la pestaña Productos (SKU / Nombre / Imagen, los
// tres son alias de IMAGE_COLS): se completa la columna Imagen con los
// links y se re-sube el archivo tal cual, sin retocar encabezados.
export async function downloadMissingPhotosExcel(products, filenameStamp) {
  const XLSX = await import('xlsx')
  const rows = products.map((p) => ({ SKU: p.sku, Nombre: p.name, Imagen: '' }))
  const ws = XLSX.utils.json_to_sheet(rows, { header: ['SKU', 'Nombre', 'Imagen'] })
  ws['!cols'] = [{ wch: 24 }, { wch: 50 }, { wch: 70 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sin foto')
  XLSX.writeFile(wb, `zimaxx-productos-sin-foto-${filenameStamp}.xlsx`)
}

// Exporta el Registro de movimientos (`admin_audit_log`) a Excel
// (2026-08-05). A diferencia de los otros dos exports, acá las filas y los
// encabezados llegan **ya armados** desde `AuditLogAdmin.jsx`: las etiquetas de
// acción y el texto de detalle dependen de `t()` (idioma del panel) y de la
// forma del `detail` jsonb de cada acción, que ya vive resuelta ahí. Esta
// función solo escribe el archivo.
export async function downloadAuditLogExcel({ rows, header, widths, sheetName, filenameStamp }) {
  const XLSX = await import('xlsx')
  const ws = XLSX.utils.json_to_sheet(rows, { header })
  if (widths) ws['!cols'] = widths.map((wch) => ({ wch }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  XLSX.writeFile(wb, `zimaxx-registro-movimientos-${filenameStamp}.xlsx`)
}

// Exporta la tabla "Adopción por vendedora" de la pestaña Métricas
// (2026-08-06). Mismo criterio que downloadAuditLogExcel: las filas llegan ya
// armadas desde MetricsAdmin.jsx porque los encabezados dependen de t()
// (idioma del panel) y los números ya vienen agregados desde
// sa_metrics_overview. `periodStamp` va en el nombre del archivo para no
// confundir un export de 7 días con uno de 30.
export async function downloadMetricsExcel({ rows, header, widths, sheetName, periodStamp }) {
  const XLSX = await import('xlsx')
  const ws = XLSX.utils.json_to_sheet(rows, { header })
  if (widths) ws['!cols'] = widths.map((wch) => ({ wch }))
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  XLSX.writeFile(wb, `zimaxx-metricas-${periodStamp}.xlsx`)
}

// ---------- Lista de precios en Excel (2026-09-08) ----------
// Puente para los clientes que siguen pidiendo "el catálogo en Excel" mientras
// se acostumbran al link: el MISMO archivo se genera desde el catálogo del
// cliente (PriceListExcel.jsx, con lo que ya devolvió get_catalog — no hay RPC
// ni migración detrás) y desde la pestaña Precios (PricesUpload.jsx, para que
// la vendedora se lo mande por WhatsApp a quien lo prefiera así). Las dos
// pantallas arman las filas con priceListExcelRows para que el archivo sea
// uno solo, venga de donde venga.

const AVAILABILITY_KEY = { available: 'inStock', preorder: 'preorder', flash: 'flashSale' }

// Convierte productos (shape de get_catalog o de la matriz del panel) en
// { header, rows, widths, priceCol }. `withSku` solo desde el panel: el SKU es
// dato interno (get_catalog no lo expone) y el cliente identifica por UPC.
// Sin precios (lista `quote`) la columna Precio no va: un catálogo de
// cotización no tiene precio que mostrar. Las celdas vacías van como null
// (SheetJS no crea la celda) y no como '' (crearía una celda de texto vacío).
export function priceListExcelRows({ t, products, lineLabel, withSku = false }) {
  const hasPrices = products.some((p) => p.price != null)
  const header = [
    ...(withSku ? [t('excelColSku')] : []),
    t('upc'),
    t('excelColBrand'),
    t('product'),
    t('excelColLine'),
    t('excelColAvailability'),
    ...(hasPrices ? [t('excelColPrice')] : []),
  ]
  const widths = [...(withSku ? [24] : []), 16, 22, 60, 18, 16, ...(hasPrices ? [12] : [])]
  const rows = products.map((p) => [
    ...(withSku ? [p.sku || null] : []),
    p.upc || null,
    p.category || null,
    p.name,
    p.product_line ? lineLabel(p.product_line) : null,
    AVAILABILITY_KEY[p.availability] ? t(AVAILABILITY_KEY[p.availability]) : p.availability || null,
    ...(hasPrices ? [p.price == null ? null : Number(p.price)] : []),
  ])
  return { header, rows, widths, priceCol: hasPrices ? header.length - 1 : -1 }
}

// Arma el workbook SIN escribirlo — separado de la descarga para poder
// probarlo en Node leyendo el resultado (tests/price-list-excel-tests.mjs).
// Membrete arriba (título + líneas de contexto), una fila en blanco y la tabla
// con autofiltro, como las listas wholesale que el negocio siempre mandó. Los
// precios van como NÚMERO con formato de moneda (sumables en Excel), no como
// texto "$22.00".
export function buildPriceListWorkbook(
  XLSX,
  { title, metaLines = [], header, rows, widths, priceCol = -1, sheetName },
) {
  const aoa = [[title], ...metaLines.map((line) => [line]), [], header, ...rows]
  const headerRow = 1 + metaLines.length + 1
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  if (priceCol >= 0) {
    for (let r = headerRow + 1; r < aoa.length; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: priceCol })]
      if (cell && typeof cell.v === 'number') cell.z = '"$"#,##0.00'
    }
  }
  if (widths) ws['!cols'] = widths.map((wch) => ({ wch }))
  if (rows.length > 0) {
    ws['!autofilter'] = {
      ref: XLSX.utils.encode_range({
        s: { r: headerRow, c: 0 },
        e: { r: aoa.length - 1, c: header.length - 1 },
      }),
    }
  }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  return wb
}

export async function downloadPriceListExcel({ filename, ...opts }) {
  const XLSX = await import('xlsx')
  const wb = buildPriceListWorkbook(XLSX, opts)
  XLSX.writeFile(wb, filename)
}

// El mismo generador membrete + tabla + autofiltro sirve para cualquier export
// tabular del panel — alias con nombre neutro (2026-09-09, logs del sistema).
export const buildTableWorkbook = buildPriceListWorkbook
export const downloadTableExcel = downloadPriceListExcel

// ---------- Logs del sistema en Excel (2026-09-09) ----------
// Exporta lo que la pestaña ⚙️ Sistema tiene filtrado (a pedido del usuario:
// "poder descargar/exportar un excel con los datos que se filtren"). Las
// columnas fijas son las de la tabla; el `context` jsonb se APLANA: cada clave
// que aparezca en alguna fila es una columna (en orden de aparición, con la
// etiqueta de `labels` si la hay), así un filtro de "clientes creados desde el
// catálogo" sale con Cliente / Teléfono / Empresa / Grupo / … en columnas
// propias y no como un JSON pegado. Valores anidados (objetos, arrays) van
// como JSON en su celda; booleanos como Sí/No; null sin celda. Si hay más
// claves que `maxContextCols`, el resto va junto en una última columna JSON.
// `stamp` formatea la fecha (inyectable para probarlo sin depender del locale).
export function systemLogsExcelRows({
  t,
  rows,
  labels = {},
  maxContextCols = 40,
  stamp = (iso) => new Date(iso).toLocaleString(),
}) {
  const keys = []
  const seen = new Set()
  for (const r of rows) {
    for (const k of Object.keys(r.context ?? {})) {
      if (!seen.has(k)) {
        seen.add(k)
        keys.push(k)
      }
    }
  }
  const cols = keys.slice(0, maxContextCols)
  const overflow = keys.slice(maxContextCols)
  const header = [
    t('date'),
    t('systemSeverity'),
    t('systemSource'),
    t('systemEvent'),
    t('systemMessage'),
    ...cols.map((k) => labels[k] ?? k),
    ...(overflow.length ? [t('systemContext')] : []),
  ]
  const cell = (v) => {
    if (v == null) return null
    if (typeof v === 'boolean') return v ? t('yes') : t('no')
    if (typeof v === 'object') return JSON.stringify(v)
    return v
  }
  const out = rows.map((r) => {
    const ctx = r.context && typeof r.context === 'object' ? r.context : {}
    return [
      r.created_at ? stamp(r.created_at) : null,
      r.severity,
      r.source,
      r.event,
      r.message ?? null,
      ...cols.map((k) => cell(ctx[k])),
      ...(overflow.length
        ? [
            JSON.stringify(
              Object.fromEntries(overflow.filter((k) => k in ctx).map((k) => [k, ctx[k]])),
            ),
          ]
        : []),
    ]
  })
  const widths = [20, 10, 20, 28, 50, ...cols.map(() => 22), ...(overflow.length ? [40] : [])]
  return { header, rows: out, widths, contextKeys: cols }
}

// Trozo seguro para un nombre de archivo (sin acentos, minúsculas, guiones).
export function fileSlug(s, max = 40) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
}

export function normalizeHeader(h) {
  return String(h)
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// Busca en una fila la primera clave que coincida con alguno de los alias.
export function pick(row, aliases) {
  for (const alias of aliases) {
    if (row[alias] !== undefined && row[alias] !== '') return row[alias]
  }
  return undefined
}

const IMG_URL = /^https?:\/\/\S+\.(jpe?g|png|webp|gif|avif)(\?\S*)?$/i

export function looksLikeImageUrl(v) {
  return IMG_URL.test(String(v ?? '').trim())
}

// Detecta la columna de fotos aunque venga con un encabezado inservible
// (los exports reales traen "Column1"): gana la columna donde la mayoría
// de los valores no vacíos son URLs de imagen.
export function detectImageColumn(rows) {
  const scores = new Map()
  for (const row of rows.slice(0, 200)) {
    for (const [key, value] of Object.entries(row)) {
      if (String(value).trim() === '') continue
      const s = scores.get(key) ?? { hits: 0, total: 0 }
      s.total++
      if (looksLikeImageUrl(value)) s.hits++
      scores.set(key, s)
    }
  }
  let best = null
  for (const [key, s] of scores) {
    if (s.hits >= 3 && s.hits / s.total > 0.5 && (!best || s.hits > best.hits)) {
      best = { key, hits: s.hits }
    }
  }
  return best?.key
}

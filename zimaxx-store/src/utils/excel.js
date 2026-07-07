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

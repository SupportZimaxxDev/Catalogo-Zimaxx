import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase, fetchAll, updateByIds } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { parseSheet, pick, detectImageColumn, looksLikeImageUrl, downloadMissingPhotosExcel } from '../../utils/excel'
import { generateSku } from '../../utils/token'
import { logEvent } from '../../utils/systemLog'
import {
  UploadZone,
  ProductFilters,
  isNewProduct as isNew,
  isNonCatalogSku,
  productMatchesFilters,
  inputCls,
  useInfiniteRows,
} from './ui'

const EMPTY = { sku: '', upc: '', name: '', category: '', image_url: '', active: true, new_until: '', stock: '' }

// Etiqueta "Nuevo" (2026-07-09): los productos recién creados la llevan
// automáticamente por ~10 días ("una semana, quizás un poco más") y el
// catálogo permite filtrar por ellos. La fecha queda editable en el
// formulario de edición por si una promo necesita más o menos tiempo.
const NEW_TAG_DAYS = 10

const toIso = (local) => (local ? new Date(local).toISOString() : null)
const isoToLocal = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}
// ISO para la base; la variante local es la misma fecha en el formato que
// entiende un <input type="datetime-local">.
const newUntilIn = (days) => {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString()
}
const defaultNewUntilLocal = () => isoToLocal(newUntilIn(NEW_TAG_DAYS))

// Alias aceptados en el Excel de productos. El SKU es opcional (se
// autogenera si falta) y nunca se expone en el catálogo del cliente.
const COLS = {
  sku: ['sku', 'codigo', 'código', 'code', 'productid'],
  upc: ['upc', 'codigo de barras', 'código de barras', 'barcode', 'ean'],
  name: ['nombre', 'name', 'producto', 'product', 'productname', 'title product', 'title'],
  category: ['categoria', 'categoría', 'category', 'categoria/talla', 'category/size', 'brand', 'marca'],
  image: ['imagen', 'image', 'image_url', 'foto', 'url imagen', 'imagen url', 'url'],
  active: ['activo', 'active', 'estado', 'status'],
  // Disponibilidad (columna Type de las listas wholesale): Available /
  // Pre Order / Flash Sale. Flash Sale es una ETIQUETA del producto, sin
  // precio promo ni vencimiento: marca lo que se quiere mover. Desde
  // 2026-08-07 es la única Flash Sale del sistema (la pestaña de ofertas
  // con cuenta regresiva se eliminó) y se pone por acá, por el Excel de
  // Flash Sales, o a mano con la selección en bloque de la tabla.
  availability: ['type', 'tipo', 'disponibilidad', 'availability'],
  // PRODUCT_CATEGORY del export de SellerCloud (2026-07-08): distinto de
  // COLS.category (que acá guarda la MARCA/Brand) — esto es el tipo real
  // del perfume, ej. "Perfume" (diseñador) vs "Perfume - Arabes" (dupes
  // árabes), para poder filtrar por eso en el admin y en el catálogo.
  line: ['product_category', 'product category', 'línea', 'linea', 'segmento'],
  // Inventario / stock (2026-07-14): si el archivo trae esta columna, se
  // guarda en products.stock (oculto al cliente) y decide la
  // DISPONIBILIDAD — >= 1 available, 0/negativo preorder, respetando flash.
  // El estado activo NO lo toca (es manual, ver bulk). Mismo criterio que el
  // sync de SellerCloud (InventoryAvailableQTY, ver
  // migration-2026-07-14-inventory-stock.sql).
  inventory: [
    'inventoryavailableqty', 'inventory available qty', 'inventory', 'inventario',
    'stock', 'available qty', 'availableqty', 'qty disponible',
  ],
}
const FALSY_ACTIVE = new Set(['no', 'false', '0', 'inactivo', 'inactive'])

function parseAvailability(raw) {
  const v = String(raw ?? '')
  if (/pre.?order/i.test(v)) return 'preorder'
  if (/flash/i.test(v)) return 'flash'
  return 'available'
}

// Normaliza PRODUCT_CATEGORY a los dos valores que importan para filtrar
// (diseñador vs árabes), absorbiendo variantes/typos del export ("Perfums",
// "Perfume Arabes", etc.). Todo lo demás (Beauty, Electronics...) se deja
// tal cual viene, ya recortado por parseSheet.
function parseLine(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return null
  if (/arabe/i.test(v)) return 'Perfume - Arabes'
  if (/^perfum(e|s)?$/i.test(v)) return 'Perfume'
  return v
}

// Filas internas de sistemas de inventario (pruebas de soporte, ajustes
// de crédito) que no son productos reales y no deben entrar al catálogo.
const JUNK_PATTERN = /skustack|support-cost-test|support-s-\d+|client credit discount|^discount$/i

// Productos que no son catálogo vendible y no deben jalarse por ninguna
// vía (2026-07-13, a pedido del usuario). Misma regla que el lado SQL en
// migration-2026-07-13-exclude-noncatalog.sql (sync_is_noncatalog_product);
// si se cambia una lista, cambiar también la otra.
//   * SKU terminado en -SPECIAL (variante interna de SellerCloud) o en -BOX
//     (el mismo perfume vendido por caja, 2026-08-13) → isNonCatalogSku, en
//     ui.jsx porque también lo usan la tabla y los filtros.
//   * PRODUCT_CATEGORY (COLS.line → product_line) igual a una de estas.
//     Se compara normalizado (minúsculas, sin espacios de más).
const EXCLUDED_LINES = new Set([
  'test',
  'electronics',
  'packing and shipping supplies',
  'support',
  'beauty',
])
const normLine = (v) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
const isNonCatalog = (skuRaw, lineRaw) =>
  isNonCatalogSku(skuRaw) || EXCLUDED_LINES.has(normLine(lineRaw))

// Links a paneles administrativos de inventario (ej. SellerCloud) que
// vimos colados en exports como si fueran la foto del producto. Nunca
// son la imagen real: si se cargan como image_url, la foto sale rota.
const NOT_AN_IMAGE_PATTERN = /sellercloud\.com\/inventory\/product\.aspx/i

// Excel dedicado solo para imágenes: cruza por SKU (o por nombre si no
// hay SKU) y actualiza image_url de productos que ya existen. Nunca crea
// productos nuevos, así separa el problema de "conseguir fotos" del de
// "cargar el catálogo".
const IMAGE_COLS = {
  sku: COLS.sku,
  name: COLS.name,
  image: [
    'imagen', 'image', 'image_url', 'foto', 'url imagen', 'imagen url', 'url',
    'link', 'link imagen', 'imagen link', 'foto url', 'link de imagen', 'image link',
  ],
}

function parseActive(raw) {
  if (raw === undefined || raw === '') return true
  return !FALSY_ACTIVE.has(String(raw).trim().toLowerCase())
}

// Stock (InventoryAvailableQTY) → entero, o null si viene vacío/no numérico.
// El stock decide la disponibilidad (0 → pre-order, >= 1 → available), no
// el estado activo (eso es manual). Ver migration-2026-07-14-inventory-stock.sql.
function parseStock(raw) {
  const cleaned = String(raw ?? '').replace(/[^0-9.-]/g, '')
  if (cleaned === '') return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? Math.floor(n) : null
}

// Disponibilidad final según el stock, respetando 'flash'. Misma regla que
// el SQL del sync (coalesce(entrante, existente)): el Type entrante gana
// sobre lo guardado, y 'flash' se conserva cuando es la disponibilidad
// efectiva (entrante si vino, si no la ya guardada). Si no es flash, el
// stock manda (>= 1 available, si no preorder); sin stock, la disponibilidad
// efectiva o 'available'.
function resolveAvailability(typeAvail, stock, existingAvail) {
  const effective = typeAvail ?? existingAvail
  if (effective === 'flash') return 'flash'
  if (stock != null) return stock >= 1 ? 'available' : 'preorder'
  return effective ?? 'available'
}

// Espejo del trigger products_availability_from_stock: con qué disponibilidad
// va a quedar REALMENTE este producto si le escribimos `value`. Sirve para
// saber de antemano si una acción en bloque cambia algo o no hace nada —
// 'flash' siempre gana, el resto lo decide el stock cuando hay dato.
function availabilityAfter(product, value) {
  if (value === 'flash') return 'flash'
  if (product.stock != null) return product.stock >= 1 ? 'available' : 'preorder'
  return value
}

// El otro lado del mismo trigger (2026-08-12): un producto sin stock no se
// publica, así que pedir "Activar" sobre él no lo saca al catálogo. No es un
// no-op igual: queda marcado (deactivated_by_stock) y se publica solo cuando
// entre stock, y eso es justo lo que el aviso del panel tiene que decir.
const stockKeepsOff = (product) => product.stock != null && product.stock <= 0

// Botón de la barra de selección. `blocked` es el motivo por el que la acción
// no haría nada (null = habilitado). Un `<button disabled>` no dispara eventos
// de mouse y su `title` no se ve en todos los navegadores, así que apagado va
// envuelto en un span que sí lo muestra.
function BulkButton({ blocked, busy, onClick, className, children }) {
  const btn = (
    <button
      type="button"
      disabled={busy || !!blocked}
      onClick={onClick}
      title={blocked ?? undefined}
      className={className}
    >
      {children}
    </button>
  )
  return blocked ? (
    <span title={blocked} className="inline-flex cursor-not-allowed">
      {btn}
    </span>
  ) : (
    btn
  )
}

export default function ProductsAdmin() {
  const { t } = useI18n()
  // Los dos valores que importan para filtrar se leen en español claro en
  // vez del texto crudo del export; el resto (Beauty, Electronics...) se
  // muestra tal cual.
  const lineLabel = (raw) =>
    raw === 'Perfume' ? t('lineDesigner') : raw === 'Perfume - Arabes' ? t('lineArabic') : raw
  const { role } = useOutletContext()
  const isAdmin = role === 'admin'
  const [products, setProducts] = useState([])
  const [form, setForm] = useState(null) // null = sin formulario abierto
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [uploadBusy, setUploadBusy] = useState(false)
  const [uploadResult, setUploadResult] = useState(null)
  const [imgBusy, setImgBusy] = useState(false)
  const [imgResult, setImgResult] = useState(null)
  // Carga de Flash Sales por Excel (2026-08-07): el archivo semanal solo
  // decide QUIÉN lleva la etiqueta 🔥. Se muestra una vista previa antes de
  // tocar nada porque, en modo reemplazo, la carga también DESMARCA lo que
  // no viene en el archivo — igual que la carga de precios, que también
  // desactiva por omisión y por eso pide confirmar.
  const [flashBusy, setFlashBusy] = useState(false)
  const [flashResult, setFlashResult] = useState(null)
  const [flashPreview, setFlashPreview] = useState(null)
  const [flashReplace, setFlashReplace] = useState(true)
  const [flashCommitting, setFlashCommitting] = useState(false)

  // Búsqueda y filtros de la tabla
  const [query, setQuery] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [lineFilter, setLineFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  // Selección para acciones en bloque (por casillas). Set de ids.
  const [selected, setSelected] = useState(() => new Set())
  // Resultado de la última acción en bloque: se muestra aparte porque al
  // aplicarla la selección se limpia y la barra sticky desaparece con ella.
  const [bulkNotice, setBulkNotice] = useState(null)
  const [visibleRows, sentinelRef] = useInfiniteRows(100, [query, catFilter, lineFilter, statusFilter])

  // Devuelve las filas recargadas (además de guardarlas en el estado): las
  // acciones en bloque las necesitan para verificar qué quedó realmente
  // guardado, y `products` todavía tiene el valor viejo en ese mismo tick.
  const load = async () => {
    try {
      const all = await fetchAll('products', '*', ['name', 'id'])
      setProducts(all)
      return all
    } catch {
      /* la tabla queda como estaba; el próximo load reintenta */
      return null
    }
  }

  useEffect(() => {
    load()
  }, [])

  const categories = useMemo(
    () => [...new Set(products.map((p) => p.category).filter(Boolean))].sort(),
    [products],
  )

  const lines = useMemo(
    () => [...new Set(products.map((p) => p.product_line).filter(Boolean))].sort(),
    [products],
  )

  const filtered = useMemo(
    () =>
      products.filter((p) => productMatchesFilters(p, { query, catFilter, lineFilter, statusFilter })),
    [products, query, catFilter, lineFilter, statusFilter],
  )

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setUploadBusy(true)
    setUploadResult(null)

    try {
      const rows = await parseSheet(file)
      if (rows.length === 0) throw new Error('Archivo vacío')

      const existingSkus = new Set(products.map((p) => String(p.sku).toLowerCase()))
      const bySku = new Map(products.map((p) => [String(p.sku).toLowerCase(), p]))
      const upserts = []
      const skipped = []
      let junk = 0
      let excluded = 0

      // Solo tocar cada campo si el archivo trae su columna: un Excel sin
      // Type/foto/categoría no debe pisar lo ya cargado al re-subirse.
      // Las claves del upsert deben ser uniformes en todas las filas
      // (PostgREST), por eso se decide una vez por archivo.
      const autoImageCol = detectImageColumn(rows) // fotos con encabezado inservible (ej. "Column1")
      const hasAvailability = rows.length > 0 && COLS.availability.some((a) => a in rows[0])
      const hasImage = rows.length > 0 && (COLS.image.some((a) => a in rows[0]) || !!autoImageCol)
      const hasCategory = rows.length > 0 && COLS.category.some((a) => a in rows[0])
      const hasLine = rows.length > 0 && COLS.line.some((a) => a in rows[0])
      const hasInventory = rows.length > 0 && COLS.inventory.some((a) => a in rows[0])
      const hasUpc = rows.length > 0 && COLS.upc.some((a) => a in rows[0])

      for (const [idx, row] of rows.entries()) {
        const name = pick(row, COLS.name)
        if (!name) {
          skipped.push(`fila ${idx + 2}`)
          continue
        }
        const skuRaw = pick(row, COLS.sku)
        if (JUNK_PATTERN.test(String(skuRaw ?? '')) || JUNK_PATTERN.test(String(name))) {
          junk++
          continue
        }
        // No-catálogo: SKU -SPECIAL/-BOX o categoría excluida (beauty,
        // electronics, support, packing and shipping supplies, test). No se jala.
        if (isNonCatalog(skuRaw, pick(row, COLS.line))) {
          excluded++
          continue
        }
        const sku = skuRaw ? String(skuRaw).trim() : generateSku(name)
        const aliasImage = pick(row, COLS.image)
        const autoImage = autoImageCol && row[autoImageCol] !== '' ? row[autoImageCol] : undefined
        const image = aliasImage ?? autoImage
        const imageOk =
          image &&
          !NOT_AN_IMAGE_PATTERN.test(String(image)) &&
          (aliasImage ? true : looksLikeImageUrl(image))
        // El stock (si el archivo lo trae) decide la disponibilidad: 0 →
        // pre-order, >= 1 → available, respetando 'flash'. El estado activo
        // NO lo toca el inventario (es manual, ver bulk); se usa la columna
        // Activo como siempre.
        const typeAvail = hasAvailability ? parseAvailability(pick(row, COLS.availability)) : null
        const stock = hasInventory ? parseStock(pick(row, COLS.inventory)) : null
        const existing = bySku.get(sku.toLowerCase())
        upserts.push({
          sku,
          name: String(name).trim(),
          active: parseActive(pick(row, COLS.active)),
          // La columna Activo del archivo es intención explícita del admin, así
          // que borra la marca de "lo apagó el stock" (2026-08-12): un Activo=No
          // deja el producto apagado incluso si después entra stock. Si el
          // archivo dice Activo=Sí y el producto está en 0, el trigger lo vuelve
          // a marcar y se publica solo cuando haya stock.
          deactivated_by_stock: false,
          ...(hasUpc ? { upc: pick(row, COLS.upc) || null } : {}),
          ...(hasCategory ? { category: pick(row, COLS.category) || null } : {}),
          ...(hasLine ? { product_line: parseLine(pick(row, COLS.line)) } : {}),
          ...(hasImage ? { image_url: imageOk ? String(image).trim() : null } : {}),
          ...(hasInventory ? { stock } : {}),
          ...(hasAvailability || hasInventory
            ? { availability: resolveAvailability(typeAvail, stock, existing?.availability) }
            : {}),
        })
      }

      // Los SKUs que no existían llevan la etiqueta "Nuevo" con vencimiento
      // automático. Se sube en dos tandas porque PostgREST exige que todas
      // las filas de un upsert tengan las mismas columnas, y a los
      // existentes no hay que pisarles new_until al re-subir el archivo.
      const newUntilIso = newUntilIn(NEW_TAG_DAYS)
      const newRows = upserts
        .filter((p) => !existingSkus.has(p.sku.toLowerCase()))
        .map((p) => ({ ...p, new_until: newUntilIso }))
      const existingRows = upserts.filter((p) => existingSkus.has(p.sku.toLowerCase()))

      for (const batch of [newRows, existingRows]) {
        if (batch.length === 0) continue
        const { error } = await supabase.from('products').upsert(batch, { onConflict: 'sku' })
        if (error) throw error
      }

      const created = newRows.length
      const updated = existingRows.length

      setUploadResult({
        ok: true,
        message: `${created} ${t('created')} · ${updated} ${t('updated')} · ${skipped.length} ${t('skipped')}${
          skipped.length ? ` (${skipped.slice(0, 10).join(', ')})` : ''
        }${junk ? ` · ${junk} ${t('junkExcluded')}` : ''}${
          excluded ? ` · ${excluded} ${t('nonCatalogExcluded')}` : ''
        }`,
      })
      // Resumen por corrida en system_logs (2026-08-20), mismo patrón que
      // price_apply_summary. Acá lo emite el frontend porque la carga son
      // upserts directos a products, no una RPC donde dejarlo del lado SQL.
      logEvent(
        'info',
        'product_upload',
        'product_upload_summary',
        `Excel de productos: ${created} creados, ${updated} actualizados`,
        {
          rows_in_file: rows.length,
          created,
          updated,
          skipped: skipped.length,
          junk,
          non_catalog_excluded: excluded,
        },
      )
      await load()
    } catch (err) {
      setUploadResult({ ok: false, message: err.message })
      logEvent('error', 'product_upload', 'product_upload_failed', err.message)
    }
    setUploadBusy(false)
  }

  const handleImageFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setImgBusy(true)
    setImgResult(null)

    try {
      const rows = await parseSheet(file)
      if (rows.length === 0) throw new Error('Archivo vacío')

      const bySku = new Map(products.map((p) => [String(p.sku).toLowerCase(), p]))
      const byName = new Map(products.map((p) => [String(p.name).toLowerCase(), p]))

      // Map por SKU final: si el Excel repite un producto, se queda con
      // la última fila (evita que el upsert intente tocar el mismo SKU
      // dos veces en la misma pasada, lo cual Postgres rechaza).
      const bySkuToUpdate = new Map()
      let noImage = 0
      let notFound = 0
      let invalidLink = 0
      const autoImageCol = detectImageColumn(rows)

      for (const row of rows) {
        const image =
          pick(row, IMAGE_COLS.image) ??
          (autoImageCol && row[autoImageCol] !== '' ? row[autoImageCol] : undefined)
        if (!image) {
          noImage++
          continue
        }
        if (NOT_AN_IMAGE_PATTERN.test(String(image))) {
          invalidLink++
          continue
        }
        const skuRaw = pick(row, IMAGE_COLS.sku)
        const nameRaw = pick(row, IMAGE_COLS.name)
        const existing =
          (skuRaw && bySku.get(String(skuRaw).trim().toLowerCase())) ||
          (nameRaw && byName.get(String(nameRaw).trim().toLowerCase()))
        if (!existing) {
          notFound++
          continue
        }
        bySkuToUpdate.set(existing.sku, {
          sku: existing.sku,
          name: existing.name,
          image_url: String(image).trim(),
        })
      }

      const upserts = [...bySkuToUpdate.values()]
      if (upserts.length > 0) {
        const { error } = await supabase
          .from('products')
          .upsert(upserts, { onConflict: 'sku' })
        if (error) throw error
      }

      setImgResult({
        ok: true,
        message: `${upserts.length} ${t('updated')} · ${notFound} ${t('notMatched')} · ${noImage} ${t('skipped')}${
          invalidLink ? ` · ${invalidLink} ${t('invalidImageLink')}` : ''
        }`,
      })
      await load()
    } catch (err) {
      setImgResult({ ok: false, message: err.message })
    }
    setImgBusy(false)
  }

  // ---------- Flash Sales por Excel: la etiqueta 🔥, nada más ----------
  // Reemplaza a la vieja pestaña Flash Sales (2026-08-07). El archivo semanal
  // ("Special Flash Sale.xlsx") solo aporta la lista de SKUs a destacar: se
  // les pone la etiqueta y, en modo reemplazo, se le quita a los que la
  // tenían y no vienen en el archivo. No crea productos (el SKU desconocido
  // se reporta) y **la columna Price se ignora a propósito**: una Flash Sale
  // ya no tiene precio propio, el precio sale de la lista del cliente y se
  // carga en la pestaña Precios como el de cualquier otro producto.
  const handleFlashFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setFlashBusy(true)
    setFlashResult(null)
    setFlashPreview(null)

    try {
      const rows = await parseSheet(file)
      if (rows.length === 0) throw new Error('Archivo vacío')

      const bySku = new Map(products.map((p) => [String(p.sku).trim().toLowerCase(), p]))
      const fileSkus = new Set()
      const matched = []
      const unknown = []
      for (const row of rows) {
        const raw = pick(row, COLS.sku)
        const sku = String(raw ?? '').trim().toLowerCase()
        if (!sku || fileSkus.has(sku)) continue
        fileSkus.add(sku)
        const p = bySku.get(sku)
        if (p) matched.push(p)
        else unknown.push(String(raw).trim())
      }
      if (fileSkus.size === 0) throw new Error('El archivo no tiene filas con SKU')

      setFlashPreview({
        toTag: matched.filter((p) => p.availability !== 'flash'),
        toUntag: products.filter(
          (p) => p.availability === 'flash' && !fileSkus.has(String(p.sku).trim().toLowerCase()),
        ),
        unknown,
        already: matched.filter((p) => p.availability === 'flash').length,
        inactive: matched.filter((p) => !p.active).length,
      })
    } catch (err) {
      setFlashResult({ ok: false, message: err.message })
    }
    setFlashBusy(false)
  }

  const confirmFlashTags = async () => {
    if (!flashPreview) return
    setFlashCommitting(true)
    try {
      const tagIds = flashPreview.toTag.map((p) => p.id)
      const untagIds = flashReplace ? flashPreview.toUntag.map((p) => p.id) : []
      if (tagIds.length > 0) {
        const { error } = await updateByIds('products', { availability: 'flash' }, tagIds)
        if (error) throw error
      }
      // Desmarcar = devolver el producto a la disponibilidad que manda su
      // stock. Se escribe 'available' y el trigger de la base
      // (products_availability_from_stock) baja a 'preorder' lo que tenga
      // stock 0 o menos. Los que no tienen stock cargado quedan Disponible:
      // la disponibilidad que tenían antes de ser 🔥 no se guardó en ningún
      // lado, así que no hay a qué volver.
      if (untagIds.length > 0) {
        const { error } = await updateByIds('products', { availability: 'available' }, untagIds)
        if (error) throw error
      }
      setFlashResult({
        ok: true,
        message: `${tagIds.length} ${t('flashTagged')} · ${untagIds.length} ${t('flashUntagged')} · ${flashPreview.unknown.length} ${t('unknownSkusLabel')}`,
      })
      setFlashPreview(null)
      await load()
    } catch (err) {
      setFlashResult({ ok: false, message: err.message })
    }
    setFlashCommitting(false)
  }

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const payload = {
      sku: form.sku.trim() || generateSku(form.name),
      upc: form.upc?.trim() || null,
      name: form.name.trim(),
      category: form.category.trim() || null,
      image_url: form.image_url.trim() || null,
      active: form.active,
      new_until: toIso(form.new_until),
      // Vacío = "sin dato de stock" (null), distinto de 0 = "sin stock". La
      // disponibilidad la deriva el trigger de la base, no se manda de acá.
      stock: parseStock(form.stock),
    }
    const { error } = form.id
      ? await supabase.from('products').update(payload).eq('id', form.id)
      : await supabase.from('products').insert(payload)
    if (error) {
      setError(error.message)
    } else {
      setForm(null)
      await load()
    }
    setBusy(false)
  }

  // Activar/desactivar una fila. Al desactivar se apaga también la bandera de
  // "lo apagó el stock": el admin lo está apagando a mano, así que no tiene que
  // volver solo cuando entre stock. Al activar puede no quedar activo (stock 0);
  // en ese caso se relee y se explica, en vez de dejar el botón en rojo sin
  // motivo aparente.
  const toggleActive = async (p) => {
    const value = !p.active
    setBulkNotice(null)
    // Un SKU -BOX/-SPECIAL no se publica nunca (trigger
    // products_enforce_noncatalog): pedir "Activar" sobre él no es un update que
    // falla, es uno que la base revierte. Mejor decirlo que mandarlo.
    if (value && isNonCatalogSku(p.sku)) {
      setBulkNotice({ ok: true, message: t('activateBlockedNonCatalog') })
      return
    }
    const { error: err } = await supabase
      .from('products')
      .update(value ? { active: true } : { active: false, deactivated_by_stock: false })
      .eq('id', p.id)
    if (err) {
      setError(err.message)
      return
    }
    const fresh = await load()
    const after = fresh?.find((r) => r.id === p.id)
    if (value && after && !after.active) {
      setBulkNotice({ ok: true, message: t('activateBlockedByStock') })
    }
  }

  // ----- Selección + acciones en bloque -----
  const toggleSelect = (id) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // Casilla de encabezado: selecciona/deselecciona todos los productos que
  // pasan los filtros actuales (no solo los renderizados por scroll).
  const allFilteredSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id))
  const toggleSelectAll = () =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (filtered.length > 0 && filtered.every((p) => next.has(p.id))) {
        filtered.forEach((p) => next.delete(p.id))
      } else {
        filtered.forEach((p) => next.add(p.id))
      }
      return next
    })

  // Una acción en bloque que no cambiaría nada no se ofrece: marcar 🔥 sobre
  // una selección que ya es toda 🔥 mandaría un update inútil y devolvería un
  // "300 con la etiqueta aplicada" que suena a que hizo algo. Cada botón se
  // apaga cuando ningún seleccionado cambiaría, y el título dice por qué —
  // que no siempre es "ya la tienen": pedir Pre-Order sobre productos con
  // stock tampoco cambia nada, porque la disponibilidad la manda el stock.
  const selectedProducts = useMemo(
    () => products.filter((p) => selected.has(p.id)),
    [products, selected],
  )

  // null = la acción sí hace algo (botón habilitado); string = motivo por el
  // que está apagado.
  const availabilityBlocked = (value) => {
    if (selectedProducts.some((p) => availabilityAfter(p, value) !== p.availability)) return null
    return selectedProducts.every((p) => p.availability === value)
      ? t('bulkAlreadyThat')
      : t('bulkStockKeeps')
  }
  const activeBlocked = (value) => {
    if (value) {
      const pending = selectedProducts.filter((p) => !p.active)
      if (pending.length === 0) return t('bulkAlreadyThat')
      // Dos motivos por los que un inactivo no se va a publicar igual:
      //   * -BOX/-SPECIAL: no se publican nunca (2026-08-13).
      //   * sin stock y YA marcados para volver: activarlos no cambia nada, ni
      //     ahora ni cuando entre stock (2026-08-12). Si alguno todavía no está
      //     marcado, el botón sí sirve.
      // Si todos los inactivos caen en alguno de los dos, el botón se apaga con
      // los motivos que apliquen — mezclados los dos, se dicen los dos.
      const noCatalog = pending.filter((p) => isNonCatalogSku(p.sku))
      const stockHeld = pending.filter(
        (p) => !isNonCatalogSku(p.sku) && stockKeepsOff(p) && p.deactivated_by_stock,
      )
      if (noCatalog.length + stockHeld.length < pending.length) return null
      return [
        noCatalog.length ? t('activateBlockedNonCatalog') : '',
        stockHeld.length ? t('activateBlockedByStock') : '',
      ]
        .filter(Boolean)
        .join(' ')
    }
    // "Desactivar" sirve también sobre un producto que YA está inactivo si lo
    // apagó la regla de stock (2026-08-12): apagarlo a mano cancela ese regreso
    // automático. Es la única forma de decir "este no vuelve" desde el panel —
    // el badge de la fila solo ofrece activar mientras esté inactivo.
    if (selectedProducts.some((p) => p.active || p.deactivated_by_stock)) return null
    return t('bulkAlreadyThat')
  }
  const newBlocked = (on) =>
    selectedProducts.some((p) => isNew(p) !== on)
      ? null
      : on
        ? t('bulkAlreadyThat')
        : t('bulkNothingToClear')

  // Toda acción en bloque pasa por acá: update en tandas (una selección de
  // miles de ids no entra en la URL de PostgREST), limpiar la selección y
  // recargar. Devuelve los ids tocados y las filas frescas para que quien
  // llame pueda verificar qué quedó guardado de verdad.
  const bulkUpdate = async (patch) => {
    const ids = [...selected]
    if (ids.length === 0) return null
    setBusy(true)
    setError('')
    setBulkNotice(null)
    const { done, error } = await updateByIds('products', patch, ids)
    if (error) {
      // No es atómico: si se cortó a mitad, decir cuántos alcanzó a tocar en
      // vez de dejar pensando que no se aplicó nada.
      setError(done > 0 ? `${error.message} — ${done}/${ids.length}` : error.message)
      await load()
      setBusy(false)
      return null
    }
    setSelected(new Set())
    const fresh = await load()
    setBusy(false)
    return { ids, fresh }
  }

  // Igual que la disponibilidad, el estado activo tampoco es libre desde
  // 2026-08-12: un producto con stock 0 no se publica. "Activar" sobre uno así
  // igual sirve (queda marcado para publicarse cuando entre stock), así que el
  // botón no se apaga — pero el aviso separa cuántos quedaron visibles de verdad
  // y cuántos siguen esperando stock. Desactivar apaga la bandera: si el admin
  // lo apaga a mano, no tiene que volver solo.
  const bulkSetActive = async (value) => {
    const res = await bulkUpdate(
      value ? { active: true } : { active: false, deactivated_by_stock: false },
    )
    if (!res) return
    const label = value ? t('activated') : t('deactivated')
    if (!res.fresh) {
      setBulkNotice({ ok: true, message: `${res.ids.length} ${label}` })
      return
    }
    const byId = new Map(res.fresh.map((p) => [p.id, p]))
    if (value) {
      // Los que no quedaron activos tienen dos motivos distintos y no da lo mismo
      // cuál: sin stock vuelven solos cuando entre mercadería, los -BOX/-SPECIAL
      // no vuelven nunca.
      const notApplied = res.ids.filter((id) => !byId.get(id)?.active)
      const applied = res.ids.length - notApplied.length
      const nonCatalog = notApplied.filter((id) => isNonCatalogSku(byId.get(id)?.sku)).length
      const keptOff = notApplied.length - nonCatalog
      setBulkNotice({
        ok: true,
        message: [
          `${applied} ${label}`,
          keptOff > 0 ? `${keptOff} ${t('bulkStockKeptOff')}` : '',
          nonCatalog > 0 ? `🚫 ${nonCatalog} ${t('bulkNonCatalogKeptOff')}` : '',
        ]
          .filter(Boolean)
          .join(' · '),
      })
      return
    }
    // Al desactivar hay dos efectos distintos y conviene no mezclarlos: los que
    // estaban visibles y ahora no, y los que ya estaban inactivos por stock y lo
    // único que cambió es que dejaron de tener el regreso automático pendiente.
    const wasActive = new Set(selectedProducts.filter((p) => p.active).map((p) => p.id))
    const turnedOff = res.ids.filter((id) => wasActive.has(id) && byId.get(id)?.active === false)
      .length
    const cancelled = selectedProducts.filter((p) => !p.active && p.deactivated_by_stock).length
    const parts = []
    if (turnedOff > 0 || cancelled === 0) parts.push(`${turnedOff} ${label}`)
    if (cancelled > 0) parts.push(`${cancelled} ${t('bulkStockReturnCancelled')}`)
    setBulkNotice({ ok: true, message: parts.join(' · ') })
  }

  // Disponible y Pre-Order NO son libres: la base las deriva del stock
  // (trigger products_availability_from_stock, invariante de la tabla desde
  // 2026-08-04). Pedir Pre-Order sobre un producto con 5 unidades no queda —
  // solo 🔥 Flash Sale se respeta siempre. Por eso se compara contra lo que
  // quedó guardado y se informa el número real en vez de dar por hecho que
  // se aplicó a todos.
  const bulkSetAvailability = async (value) => {
    const res = await bulkUpdate({ availability: value })
    if (!res) return
    if (!res.fresh) {
      setBulkNotice({ ok: true, message: `${res.ids.length} ${t('bulkTagged')}` })
      return
    }
    const byId = new Map(res.fresh.map((p) => [p.id, p]))
    const applied = res.ids.filter((id) => byId.get(id)?.availability === value).length
    const overridden = res.ids.length - applied
    setBulkNotice({
      ok: true,
      message: `${applied} ${t('bulkTagged')}${
        overridden > 0 ? ` · ${overridden} ${t('bulkStockOverrode')}` : ''
      }`,
    })
  }

  const bulkSetNew = async (on) => {
    const res = await bulkUpdate({ new_until: on ? newUntilIn(NEW_TAG_DAYS) : null })
    if (res) {
      setBulkNotice({
        ok: true,
        message: `${res.ids.length} ${on ? t('bulkNewTagged') : t('bulkNewCleared')}`,
      })
    }
  }

  const noImageCount = products.filter((p) => !p.image_url).length
  const preorderCount = products.filter((p) => p.availability === 'preorder').length
  const flashCount = products.filter((p) => p.availability === 'flash').length
  const newCount = products.filter(isNew).length
  const nonCatalogCount = products.filter((p) => isNonCatalogSku(p.sku)).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h2 className="font-brand text-2xl font-semibold">
            {t('products')}
            <span className="ml-2 text-base font-normal text-primary/40">{products.length}</span>
          </h2>
          {noImageCount > 0 && (
            <button
              onClick={() => setStatusFilter(statusFilter === 'noimage' ? '' : 'noimage')}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                statusFilter === 'noimage'
                  ? 'bg-ink text-secondary ring-1 ring-secondary/40'
                  : 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/50 dark:text-red-300 dark:hover:bg-red-900'
              }`}
              title={t('noImage')}
            >
              📷 {noImageCount} {t('noImage').toLowerCase()}
            </button>
          )}
          {/* Mismo formato que acepta "Fotos por Excel": se completa la
              columna Imagen y se re-sube el archivo tal cual. */}
          {noImageCount > 0 && isAdmin && (
            <button
              onClick={() =>
                downloadMissingPhotosExcel(
                  products.filter((p) => !p.image_url),
                  new Date().toISOString().slice(0, 10),
                )
              }
              className="rounded-full border border-line px-3 py-1 text-xs font-semibold text-primary/60 transition-colors hover:border-secondary hover:text-secondary-dark"
              title={t('downloadMissingPhotos')}
            >
              ⬇️ {t('downloadExcel')}
            </button>
          )}
          {preorderCount > 0 && (
            <button
              onClick={() => setStatusFilter(statusFilter === 'preorder' ? '' : 'preorder')}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                statusFilter === 'preorder'
                  ? 'bg-ink text-secondary ring-1 ring-secondary/40'
                  : 'bg-gold-pale text-secondary-dark hover:bg-secondary/30'
              }`}
              title={t('preorder')}
            >
              {preorderCount} {t('preorder')}
            </button>
          )}
          {newCount > 0 && (
            <button
              onClick={() => setStatusFilter(statusFilter === 'new' ? '' : 'new')}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                statusFilter === 'new'
                  ? 'bg-ink text-secondary ring-1 ring-secondary/40'
                  : 'bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-900/50 dark:text-green-300 dark:hover:bg-green-900'
              }`}
              title={t('newTag')}
            >
              ✨ {newCount} {t('newTag')}
            </button>
          )}
          {/* 2026-08-13: los -BOX/-SPECIAL están inactivos para siempre. El
              contador es para poder mirarlos (son ~190) sin que se mezclen con
              los inactivos que sí hay que revisar. */}
          {nonCatalogCount > 0 && (
            <button
              onClick={() => setStatusFilter(statusFilter === 'noncatalog' ? '' : 'noncatalog')}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                statusFilter === 'noncatalog'
                  ? 'bg-ink text-secondary ring-1 ring-secondary/40'
                  : 'bg-primary/10 text-primary/60 hover:bg-primary/20'
              }`}
              title={t('nonCatalogSkuTitle')}
            >
              🚫 {nonCatalogCount} {t('nonCatalogSku')}
            </button>
          )}
          {flashCount > 0 && (
            <button
              onClick={() => setStatusFilter(statusFilter === 'flash' ? '' : 'flash')}
              className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                statusFilter === 'flash'
                  ? 'bg-ink text-secondary ring-1 ring-secondary/40'
                  : 'bg-secondary/20 text-secondary-dark hover:bg-secondary/30'
              }`}
              title={t('flashSale')}
            >
              🔥 {flashCount} {t('flashSale')}
            </button>
          )}
        </div>
        {isAdmin && (
          <button
            onClick={() => setForm({ ...EMPTY, new_until: defaultNewUntilLocal() })}
            className="rounded-full bg-ink px-5 py-2 text-sm font-semibold text-secondary transition-colors hover:bg-ink-soft"
          >
            + {t('newProduct')}
          </button>
        )}
      </div>

      {isAdmin && (
        <div className="grid gap-3 md:grid-cols-3">
          <UploadZone
            icon="📦"
            title={t('bulkUpload')}
            hint={t('productUploadHint')}
            busy={uploadBusy}
            result={uploadResult}
            onFile={handleFile}
          />
          <UploadZone
            icon="🖼️"
            title={t('imageUpload')}
            hint={t('imageUploadHint')}
            busy={imgBusy}
            result={imgResult}
            onFile={handleImageFile}
          />
          <UploadZone
            icon="🔥"
            title={t('flashTagUpload')}
            hint={t('flashTagUploadHint')}
            busy={flashBusy}
            result={flashResult}
            onFile={handleFlashFile}
          />
        </div>
      )}

      {/* Vista previa de la carga de Flash Sales: en modo reemplazo también
          DESMARCA, así que se confirma antes de tocar nada (mismo criterio
          que la carga de precios, que desactiva por omisión). */}
      {isAdmin && flashPreview && (
        <div className="animate-fade-up space-y-3 rounded-2xl border border-secondary/40 bg-gold-pale/10 p-4">
          <h3 className="font-brand text-lg font-semibold">
            🔥 {t('previewTitle')} — {t('flashTagUpload')}
          </h3>
          <div className="flex flex-wrap gap-2 text-xs font-semibold">
            <span className="rounded-full bg-secondary/20 px-3 py-1 text-secondary-dark">
              {flashPreview.toTag.length} {t('flashTagToTag')}
            </span>
            <span className="rounded-full bg-red-100 px-3 py-1 text-red-700 dark:bg-red-900/50 dark:text-red-300">
              {flashReplace ? flashPreview.toUntag.length : 0} {t('flashTagToUntag')}
            </span>
            <span className="rounded-full bg-primary/10 px-3 py-1 text-primary/60">
              {flashPreview.already} {t('flashTagAlready')}
            </span>
            <span className="rounded-full bg-primary/10 px-3 py-1 text-primary/60">
              {flashPreview.unknown.length} {t('unknownSkusLabel')}
            </span>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={flashReplace}
              onChange={(e) => setFlashReplace(e.target.checked)}
              className="mt-0.5 accent-secondary"
            />
            <span>
              {t('flashTagReplace')} ({flashPreview.toUntag.length})
              <span className="mt-0.5 block text-xs text-primary/50">{t('flashTagReplaceHint')}</span>
            </span>
          </label>

          {flashPreview.inactive > 0 && (
            <p className="rounded-lg bg-red-50 p-2.5 text-xs leading-relaxed text-red-700 dark:bg-red-950/50 dark:text-red-300">
              {t('flashTagInactiveWarn', { n: flashPreview.inactive })}
            </p>
          )}

          {flashPreview.unknown.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-primary/60">{t('unknownSampleHint')}</p>
              <p className="max-h-24 overflow-y-auto break-words font-mono text-xs text-primary/70">
                {flashPreview.unknown.slice(0, 60).join(', ')}
                {flashPreview.unknown.length > 60 ? '…' : ''}
              </p>
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={confirmFlashTags}
              disabled={flashCommitting}
              className="rounded-xl bg-secondary px-4 py-2 text-sm font-bold text-ink transition-colors hover:bg-secondary-dark disabled:opacity-50"
            >
              {flashCommitting ? t('applying') : t('confirmApply')}
            </button>
            <button
              onClick={() => setFlashPreview(null)}
              disabled={flashCommitting}
              className="rounded-xl border border-line px-4 py-2 text-sm text-primary/60 transition-colors hover:border-primary/40 disabled:opacity-50"
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      )}

      {isAdmin && form && (
        <form
          onSubmit={save}
          className="grid animate-fade-up gap-3 rounded-2xl border border-secondary/40 bg-surface p-5 shadow-sm md:grid-cols-2"
        >
          <input
            placeholder="SKU (interno, opcional)"
            value={form.sku}
            onChange={(e) => setForm({ ...form, sku: e.target.value })}
            className={inputCls}
          />
          <input
            placeholder="UPC (opcional)"
            value={form.upc ?? ''}
            onChange={(e) => setForm({ ...form, upc: e.target.value })}
            className={inputCls}
          />
          <input
            required
            placeholder={t('name')}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={inputCls}
          />
          <input
            placeholder={t('category')}
            value={form.category ?? ''}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            className={inputCls}
            list="product-categories"
          />
          <datalist id="product-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <input
            placeholder={t('imageUrl')}
            value={form.image_url ?? ''}
            onChange={(e) => setForm({ ...form, image_url: e.target.value })}
            className={inputCls}
          />
          <label className="text-sm">
            ✨ {t('newUntil')}
            <input
              type="datetime-local"
              value={form.new_until ?? ''}
              onChange={(e) => setForm({ ...form, new_until: e.target.value })}
              className={`${inputCls} mt-1 w-full`}
            />
            <span className="mt-1 block text-xs text-primary/50">{t('newUntilHint')}</span>
          </label>
          {/* Stock editable a mano (2026-08-04): hace falta para cerrar el
              ciclo del descuento por pedido — cuando entra mercadería, el
              admin repone acá y el producto vuelve solo a Disponible (lo
              deriva el trigger products_availability_from_stock). Hasta ahora
              el stock solo entraba por el Excel de productos o el sync. */}
          <label className="text-sm">
            📦 {t('stock')}
            <input
              type="number"
              step={1}
              placeholder="—"
              value={form.stock ?? ''}
              onChange={(e) => setForm({ ...form, stock: e.target.value })}
              className={`${inputCls} mt-1 w-full`}
            />
            <span className="mt-1 block text-xs text-primary/50">{t('stockHint')}</span>
          </label>
          <div className="text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
                className="accent-secondary"
              />
              {t('active')}
            </label>
            {/* Tildar Activo con stock 0 no publica nada (trigger
                products_availability_from_stock, 2026-08-12): mejor decirlo acá
                que dejar al admin guardando dos veces sin entender. Lo mismo con
                un SKU -BOX/-SPECIAL (trigger products_enforce_noncatalog,
                2026-08-13), que además no vuelve nunca. */}
            {form.active && isNonCatalogSku(form.sku) && (
              <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                {t('activeBlockedNonCatalogHint')}
              </p>
            )}
            {form.active &&
              !isNonCatalogSku(form.sku) &&
              stockKeepsOff({ stock: parseStock(form.stock) }) && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                  {t('activeBlockedByStockHint')}
                </p>
              )}
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400 md:col-span-2">{error}</p>}
          <div className="flex gap-2 md:col-span-2">
            <button
              disabled={busy}
              className="rounded-full bg-secondary px-6 py-2 text-sm font-bold text-ink transition-colors hover:bg-secondary-dark disabled:opacity-50"
            >
              {t('save')}
            </button>
            <button
              type="button"
              onClick={() => setForm(null)}
              className="rounded-full border border-line px-6 py-2 text-sm transition-colors hover:border-primary/40"
            >
              {t('cancel')}
            </button>
          </div>
        </form>
      )}

      {/* Buscador + filtros (los mismos que la pestaña Precios, ver ui.jsx) */}
      <ProductFilters
        query={query}
        onQueryChange={setQuery}
        categories={categories}
        catFilter={catFilter}
        onCatChange={setCatFilter}
        lines={lines}
        lineFilter={lineFilter}
        onLineChange={setLineFilter}
        lineLabel={lineLabel}
        statusFilter={statusFilter}
        onStatusChange={setStatusFilter}
        withPhotoStatus
      />

      {/* Barra de acción para la selección en bloque (solo admin) */}
      {isAdmin && selected.size > 0 && (
        <div className="sticky top-0 z-10 space-y-2 rounded-2xl border border-secondary/40 bg-gold-pale/60 px-4 py-2.5 shadow-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-primary">
              {selected.size} {t('selected')}
            </span>
            <div className="ml-auto flex gap-2">
              <BulkButton
                busy={busy}
                blocked={activeBlocked(true)}
                onClick={() => bulkSetActive(true)}
                className="rounded-full bg-green-600 px-4 py-1.5 text-xs font-bold text-white transition-colors hover:bg-green-700 disabled:opacity-40"
              >
                {t('activate')}
              </BulkButton>
              <BulkButton
                busy={busy}
                blocked={activeBlocked(false)}
                onClick={() => bulkSetActive(false)}
                className="rounded-full bg-red-600 px-4 py-1.5 text-xs font-bold text-white transition-colors hover:bg-red-700 disabled:opacity-40"
              >
                {t('deactivate')}
              </BulkButton>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="rounded-full border border-line px-4 py-1.5 text-xs font-semibold text-primary/60 transition-colors hover:border-primary/40"
              >
                {t('clearSelection')}
              </button>
            </div>
          </div>

          {/* Etiquetas en bloque (2026-08-07): poner/quitar 🔥 Flash Sale y
              Pre-Order, y marcar/desmarcar ✨ Nuevo sin abrir producto por
              producto. Quitar 🔥 = volver a Disponible (el stock decide). */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-t border-secondary/25 pt-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-primary/50">
              {t('tagLabel')}
            </span>
            <BulkButton
              busy={busy}
              blocked={availabilityBlocked('flash')}
              onClick={() => bulkSetAvailability('flash')}
              className="rounded-full bg-secondary px-3.5 py-1.5 text-xs font-bold text-ink transition-colors hover:bg-secondary-dark disabled:opacity-40"
            >
              🔥 {t('flashSale')}
            </BulkButton>
            <BulkButton
              busy={busy}
              blocked={availabilityBlocked('preorder')}
              onClick={() => bulkSetAvailability('preorder')}
              className="rounded-full bg-gold-pale px-3.5 py-1.5 text-xs font-bold text-secondary-dark ring-1 ring-secondary/40 transition-colors hover:bg-secondary/30 disabled:opacity-40"
            >
              {t('preorder')}
            </BulkButton>
            <BulkButton
              busy={busy}
              blocked={availabilityBlocked('available')}
              onClick={() => bulkSetAvailability('available')}
              className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-xs font-semibold text-primary/70 transition-colors hover:border-secondary disabled:opacity-40"
            >
              {t('availableTag')}
            </BulkButton>
            <span className="ml-2 text-xs font-semibold uppercase tracking-wider text-primary/50">
              ✨ {t('newTag')}
            </span>
            <BulkButton
              busy={busy}
              blocked={newBlocked(true)}
              onClick={() => bulkSetNew(true)}
              className="rounded-full bg-green-100 px-3.5 py-1.5 text-xs font-bold text-green-800 transition-colors hover:bg-green-200 disabled:opacity-40 dark:bg-green-900/50 dark:text-green-300 dark:hover:bg-green-900"
            >
              {t('markTag')}
            </BulkButton>
            <BulkButton
              busy={busy}
              blocked={newBlocked(false)}
              onClick={() => bulkSetNew(false)}
              className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-xs font-semibold text-primary/70 transition-colors hover:border-secondary disabled:opacity-40"
            >
              {t('unmarkTag')}
            </BulkButton>
          </div>
          <p className="text-[11px] leading-relaxed text-primary/50">{t('bulkAvailabilityHint')}</p>
        </div>
      )}

      {bulkNotice && (
        <p className="rounded-lg bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950/50 dark:text-green-300">
          {bulkNotice.message}
        </p>
      )}
      {error && !form && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-primary/45">
              {isAdmin && (
                <th className="p-3">
                  <input
                    type="checkbox"
                    checked={allFilteredSelected}
                    onChange={toggleSelectAll}
                    className="accent-secondary"
                    title={t('selectAll')}
                  />
                </th>
              )}
              <th className="p-3" />
              <th className="p-3">SKU</th>
              <th className="p-3">UPC</th>
              <th className="p-3">{t('name')}</th>
              <th className="p-3">{t('category')}</th>
              <th className="p-3">{t('stock')}</th>
              <th className="p-3">{t('active')}</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, visibleRows).map((p) => (
              <tr
                key={p.id}
                className={`border-b border-line/60 transition-colors hover:bg-gold-pale/20 ${
                  selected.has(p.id) ? 'bg-gold-pale/40' : ''
                }`}
              >
                {isAdmin && (
                  <td className="py-2 pl-3">
                    <input
                      type="checkbox"
                      checked={selected.has(p.id)}
                      onChange={() => toggleSelect(p.id)}
                      className="accent-secondary"
                    />
                  </td>
                )}
                <td className="py-2 pl-3">
                  {p.image_url ? (
                    <img
                      src={p.image_url}
                      alt=""
                      loading="lazy"
                      className="h-9 w-9 rounded-lg border border-line object-cover"
                    />
                  ) : (
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink font-brand text-xs italic text-secondary/40">
                      Z
                    </span>
                  )}
                </td>
                <td className="p-3 font-mono text-xs text-primary/60">{p.sku}</td>
                <td className="p-3 font-mono text-xs text-primary/60">{p.upc}</td>
                <td className="p-3 font-medium">
                  {p.name}
                  {p.availability === 'preorder' && (
                    <span className="ml-2 rounded-full bg-gold-pale px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-secondary-dark">
                      {t('preorder')}
                    </span>
                  )}
                  {p.availability === 'flash' && (
                    <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink">
                      🔥 {t('flashSale')}
                    </span>
                  )}
                  {isNew(p) && (
                    <span
                      className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-green-800 dark:bg-green-900/50 dark:text-green-300"
                      title={`${t('newUntil')}: ${new Date(p.new_until).toLocaleString()}`}
                    >
                      ✨ {t('newTag')}
                    </span>
                  )}
                  {/* 2026-08-13: si no se dice acá, un -BOX se lee como un
                      producto normal que alguien apagó por error. */}
                  {isNonCatalogSku(p.sku) && (
                    <span
                      className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-primary/60"
                      title={t('nonCatalogSkuTitle')}
                    >
                      🚫 {t('nonCatalogSku')}
                    </span>
                  )}
                </td>
                <td className="p-3 text-primary/60">
                  {p.category}
                  {p.product_line && (
                    <span className="ml-1.5 rounded-full bg-primary/5 px-2 py-0.5 text-[10px] font-semibold text-primary/50">
                      {lineLabel(p.product_line)}
                    </span>
                  )}
                </td>
                <td className="p-3">
                  {p.stock == null ? (
                    <span className="text-primary/30">—</span>
                  ) : (
                    <span
                      className={
                        p.stock <= 0 ? 'font-semibold text-red-600 dark:text-red-400' : 'text-primary/70'
                      }
                    >
                      {p.stock}
                    </span>
                  )}
                </td>
                <td className="p-3">
                  {/* 📦 en el badge = lo apagó el stock, no una persona; vuelve
                      solo cuando entre stock (2026-08-12). El title lo explica:
                      si no, el admin lo intenta activar a mano y no pasa nada. */}
                  {isAdmin ? (
                    <button
                      onClick={() => toggleActive(p)}
                      title={
                        isNonCatalogSku(p.sku)
                          ? t('nonCatalogSkuTitle')
                          : p.deactivated_by_stock
                            ? `${t('inactiveByStockTitle')} ${t('inactiveByStockCancelHint')}`
                            : undefined
                      }
                      className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                        p.active
                          ? 'bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-900/50 dark:text-green-300 dark:hover:bg-green-900'
                          : 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/50 dark:text-red-300 dark:hover:bg-red-900'
                      }`}
                    >
                      {p.active ? t('active') : t('inactive')}
                      {!p.active && p.deactivated_by_stock ? ' 📦' : ''}
                    </button>
                  ) : (
                    <span
                      title={
                        isNonCatalogSku(p.sku)
                          ? t('nonCatalogSkuTitle')
                          : p.deactivated_by_stock
                            ? t('inactiveByStockTitle')
                            : undefined
                      }
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        p.active
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300'
                          : 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300'
                      }`}
                    >
                      {p.active ? t('active') : t('inactive')}
                      {!p.active && p.deactivated_by_stock ? ' 📦' : ''}
                    </span>
                  )}
                </td>
                <td className="p-3 text-right">
                  {isAdmin && (
                    <button
                      onClick={() => setForm({ ...p, new_until: isoToLocal(p.new_until) })}
                      className="text-xs font-semibold text-secondary-dark hover:underline"
                    >
                      {t('edit')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {filtered.length > visibleRows && (
          <div ref={sentinelRef} className="py-4 text-center text-xs text-primary/40">
            {t('loading')}
          </div>
        )}
        <div className="border-t border-line px-4 py-2.5 text-xs text-primary/50">
          {filtered.length} {t('results')}
        </div>
      </div>
    </div>
  )
}

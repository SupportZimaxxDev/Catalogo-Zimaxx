import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase, fetchAll } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { parseSheet, pick, detectImageColumn, looksLikeImageUrl, downloadMissingPhotosExcel } from '../../utils/excel'
import { generateSku } from '../../utils/token'
import { SearchIcon, UploadZone, inputCls, useInfiniteRows } from './ui'

const EMPTY = { sku: '', name: '', category: '', image_url: '', active: true, new_until: '' }

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
const defaultNewUntilLocal = () => {
  const d = new Date()
  d.setDate(d.getDate() + NEW_TAG_DAYS)
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

const isNew = (p) => p.new_until && new Date(p.new_until).getTime() > Date.now()

// Alias aceptados en el Excel de productos. El SKU es opcional (se
// autogenera si falta) y nunca se expone en el catálogo del cliente.
const COLS = {
  sku: ['sku', 'codigo', 'código', 'code', 'productid'],
  name: ['nombre', 'name', 'producto', 'product', 'productname', 'title product', 'title'],
  category: ['categoria', 'categoría', 'category', 'categoria/talla', 'category/size', 'brand', 'marca'],
  image: ['imagen', 'image', 'image_url', 'foto', 'url imagen', 'imagen url', 'url'],
  active: ['activo', 'active', 'estado', 'status'],
  // Disponibilidad (columna Type de las listas wholesale): Available /
  // Pre Order / Flash Sale. Flash Sale acá es solo una etiqueta del
  // producto (viene del inventario), distinta de la tabla `flash_sales`
  // de ofertas con precio promo que se gestiona en su propia pestaña.
  availability: ['type', 'tipo', 'disponibilidad', 'availability'],
  // PRODUCT_CATEGORY del export de SellerCloud (2026-07-08): distinto de
  // COLS.category (que acá guarda la MARCA/Brand) — esto es el tipo real
  // del perfume, ej. "Perfume" (diseñador) vs "Perfume - Arabes" (dupes
  // árabes), para poder filtrar por eso en el admin y en el catálogo.
  line: ['product_category', 'product category', 'línea', 'linea', 'segmento'],
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

  // Búsqueda y filtros de la tabla
  const [query, setQuery] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [lineFilter, setLineFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [visibleRows, sentinelRef] = useInfiniteRows(100, [query, catFilter, lineFilter, statusFilter])

  const load = async () => {
    try {
      setProducts(await fetchAll('products', '*', 'name'))
    } catch {
      /* la tabla queda como estaba; el próximo load reintenta */
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return products.filter((p) => {
      if (catFilter === '__none__' ? p.category : catFilter && p.category !== catFilter) return false
      if (lineFilter === '__none__' ? p.product_line : lineFilter && p.product_line !== lineFilter)
        return false
      if (statusFilter === 'active' && !p.active) return false
      if (statusFilter === 'inactive' && p.active) return false
      if (statusFilter === 'noimage' && p.image_url) return false
      if (statusFilter === 'preorder' && p.availability !== 'preorder') return false
      if (statusFilter === 'flash' && p.availability !== 'flash') return false
      if (statusFilter === 'new' && !isNew(p)) return false
      if (q && !p.name.toLowerCase().includes(q) && !String(p.sku).toLowerCase().includes(q))
        return false
      return true
    })
  }, [products, query, catFilter, lineFilter, statusFilter])

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
      const upserts = []
      const skipped = []
      let junk = 0

      // Solo tocar cada campo si el archivo trae su columna: un Excel sin
      // Type/foto/categoría no debe pisar lo ya cargado al re-subirse.
      // Las claves del upsert deben ser uniformes en todas las filas
      // (PostgREST), por eso se decide una vez por archivo.
      const autoImageCol = detectImageColumn(rows) // fotos con encabezado inservible (ej. "Column1")
      const hasAvailability = rows.length > 0 && COLS.availability.some((a) => a in rows[0])
      const hasImage = rows.length > 0 && (COLS.image.some((a) => a in rows[0]) || !!autoImageCol)
      const hasCategory = rows.length > 0 && COLS.category.some((a) => a in rows[0])
      const hasLine = rows.length > 0 && COLS.line.some((a) => a in rows[0])

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
        const sku = skuRaw ? String(skuRaw).trim() : generateSku(name)
        const aliasImage = pick(row, COLS.image)
        const autoImage = autoImageCol && row[autoImageCol] !== '' ? row[autoImageCol] : undefined
        const image = aliasImage ?? autoImage
        const imageOk =
          image &&
          !NOT_AN_IMAGE_PATTERN.test(String(image)) &&
          (aliasImage ? true : looksLikeImageUrl(image))
        upserts.push({
          sku,
          name: String(name).trim(),
          active: parseActive(pick(row, COLS.active)),
          ...(hasCategory ? { category: pick(row, COLS.category) || null } : {}),
          ...(hasLine ? { product_line: parseLine(pick(row, COLS.line)) } : {}),
          ...(hasImage ? { image_url: imageOk ? String(image).trim() : null } : {}),
          ...(hasAvailability
            ? { availability: parseAvailability(pick(row, COLS.availability)) }
            : {}),
        })
      }

      // Los SKUs que no existían llevan la etiqueta "Nuevo" con vencimiento
      // automático. Se sube en dos tandas porque PostgREST exige que todas
      // las filas de un upsert tengan las mismas columnas, y a los
      // existentes no hay que pisarles new_until al re-subir el archivo.
      const newUntilIso = toIso(defaultNewUntilLocal())
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
        }${junk ? ` · ${junk} ${t('junkExcluded')}` : ''}`,
      })
      await load()
    } catch (err) {
      setUploadResult({ ok: false, message: err.message })
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

  const save = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const payload = {
      sku: form.sku.trim() || generateSku(form.name),
      name: form.name.trim(),
      category: form.category.trim() || null,
      image_url: form.image_url.trim() || null,
      active: form.active,
      new_until: toIso(form.new_until),
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

  const toggleActive = async (p) => {
    await supabase.from('products').update({ active: !p.active }).eq('id', p.id)
    await load()
  }

  const noImageCount = products.filter((p) => !p.image_url).length
  const preorderCount = products.filter((p) => p.availability === 'preorder').length
  const flashCount = products.filter((p) => p.availability === 'flash').length
  const newCount = products.filter(isNew).length

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
        <div className="grid gap-3 md:grid-cols-2">
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
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => setForm({ ...form, active: e.target.checked })}
              className="accent-secondary"
            />
            {t('active')}
          </label>
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

      {/* Buscador + filtros */}
      <div className="flex flex-col gap-2 md:flex-row">
        <div className="relative flex-1">
          <SearchIcon />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchProducts')}
            className={`${inputCls} w-full pl-10`}
          />
        </div>
        <select
          value={catFilter}
          onChange={(e) => setCatFilter(e.target.value)}
          className={inputCls}
        >
          <option value="">{t('allCategories')}</option>
          <option value="__none__">{t('uncategorized')}</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {lines.length > 0 && (
          <select
            value={lineFilter}
            onChange={(e) => setLineFilter(e.target.value)}
            className={inputCls}
          >
            <option value="">{t('allLines')}</option>
            <option value="__none__">{t('uncategorized')}</option>
            {lines.map((l) => (
              <option key={l} value={l}>
                {lineLabel(l)}
              </option>
            ))}
          </select>
        )}
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className={inputCls}
        >
          <option value="">{t('allStatuses')}</option>
          <option value="active">{t('active')}</option>
          <option value="inactive">{t('inactive')}</option>
          <option value="noimage">{t('noImage')}</option>
          <option value="preorder">{t('preorder')}</option>
          <option value="flash">{t('flashSale')}</option>
          <option value="new">✨ {t('newTag')}</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-primary/45">
              <th className="p-3" />
              <th className="p-3">SKU</th>
              <th className="p-3">{t('name')}</th>
              <th className="p-3">{t('category')}</th>
              <th className="p-3">{t('active')}</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, visibleRows).map((p) => (
              <tr key={p.id} className="border-b border-line/60 transition-colors hover:bg-gold-pale/20">
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
                  {isAdmin ? (
                    <button
                      onClick={() => toggleActive(p)}
                      className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                        p.active
                          ? 'bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-900/50 dark:text-green-300 dark:hover:bg-green-900'
                          : 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/50 dark:text-red-300 dark:hover:bg-red-900'
                      }`}
                    >
                      {p.active ? t('active') : t('inactive')}
                    </button>
                  ) : (
                    <span
                      className={`rounded-full px-3 py-1 text-xs font-semibold ${
                        p.active
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300'
                          : 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300'
                      }`}
                    >
                      {p.active ? t('active') : t('inactive')}
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

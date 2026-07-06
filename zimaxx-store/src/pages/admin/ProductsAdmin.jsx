import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase, fetchAll } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { parseSheet, pick, detectImageColumn, looksLikeImageUrl } from '../../utils/excel'
import { generateSku } from '../../utils/token'
import { SearchIcon, UploadZone, inputCls, useInfiniteRows } from './ui'

const EMPTY = { sku: '', name: '', category: '', image_url: '', active: true }

// Alias aceptados en el Excel de productos. El SKU es opcional (se
// autogenera si falta) y nunca se expone en el catálogo del cliente.
const COLS = {
  sku: ['sku', 'codigo', 'código', 'code', 'productid'],
  name: ['nombre', 'name', 'producto', 'product', 'productname', 'title product', 'title'],
  category: ['categoria', 'categoría', 'category', 'categoria/talla', 'category/size', 'brand', 'marca'],
  image: ['imagen', 'image', 'image_url', 'foto', 'url imagen', 'imagen url', 'url'],
  active: ['activo', 'active', 'estado', 'status'],
  // Disponibilidad (columna Type de las listas wholesale): Available /
  // Pre Order / Flash Sale. Flash Sale se trata como disponible: las
  // ofertas se gestionan en la pestaña Flash Sales, no acá.
  availability: ['type', 'tipo', 'disponibilidad', 'availability'],
}
const FALSY_ACTIVE = new Set(['no', 'false', '0', 'inactivo', 'inactive'])

function parseAvailability(raw) {
  return /pre.?order/i.test(String(raw ?? '')) ? 'preorder' : 'available'
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
  const [statusFilter, setStatusFilter] = useState('')
  const [visibleRows, sentinelRef] = useInfiniteRows(100, [query, catFilter, statusFilter])

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return products.filter((p) => {
      if (catFilter === '__none__' ? p.category : catFilter && p.category !== catFilter) return false
      if (statusFilter === 'active' && !p.active) return false
      if (statusFilter === 'inactive' && p.active) return false
      if (statusFilter === 'noimage' && p.image_url) return false
      if (statusFilter === 'preorder' && p.availability !== 'preorder') return false
      if (q && !p.name.toLowerCase().includes(q) && !String(p.sku).toLowerCase().includes(q))
        return false
      return true
    })
  }, [products, query, catFilter, statusFilter])

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
          ...(hasImage ? { image_url: imageOk ? String(image).trim() : null } : {}),
          ...(hasAvailability
            ? { availability: parseAvailability(pick(row, COLS.availability)) }
            : {}),
        })
      }

      if (upserts.length > 0) {
        const { error } = await supabase
          .from('products')
          .upsert(upserts, { onConflict: 'sku' })
        if (error) throw error
      }

      const created = upserts.filter((p) => !existingSkus.has(p.sku.toLowerCase())).length
      const updated = upserts.length - created

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
        </div>
        {isAdmin && (
          <button
            onClick={() => setForm({ ...EMPTY })}
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
                </td>
                <td className="p-3 text-primary/60">{p.category}</td>
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
                      onClick={() => setForm({ ...p })}
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

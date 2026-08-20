import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase, fetchAll } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { parseSheet, normalizeHeader } from '../../utils/excel'
import { money } from '../../utils/format'
import { logEvent } from '../../utils/systemLog'
import {
  ProductFilters,
  isNewProduct,
  productMatchesFilters,
  inputCls,
  useInfiniteRows,
} from './ui'

// Alias aceptados por lista para la columna de precio del Excel (algunos
// archivos reales nombran la columna igual que la lista, ej. "US Minimum
// Order", en vez de un genérico "Price").
const LIST_ALIASES = {
  us_min: ['us minimum order', 'us min', 'us minimum', 'us_min'],
  us_wholesale: ['us wholesale', 'us_wholesale'],
  ve_min: ['ve minimum order', 've min', 've minimum', 've_min'],
  ve_wholesale: ['ve wholesale', 've_wholesale'],
  special: ['special', 'special order', 'us special', 've special'],
  luzmar: ['luzmar', 'luzmar special', 'precio luzmar', 'luzmar especial'],
}
const SKU_ALIASES = ['sku', 'codigo', 'código', 'code', 'productid']

// Columna de precio genérica (la mayoría de los archivos reales, ej.
// "Wholesale Perfume": una sola columna de precio sin decir a qué lista
// pertenece — por eso el admin elige la lista destino en un selector
// antes de subir el archivo).
const GENERIC_PRICE_ALIASES = ['price', 'precio', 'precio unitario', 'unit price']

// Columna de disponibilidad (misma que usa ProductsAdmin para el Excel
// de productos): Available / Pre Order / Flash Sale. La RPC hace el
// mapeo a 'available'/'preorder'/'flash', acá solo se detecta y se manda
// el texto crudo.
const TYPE_ALIASES = ['type', 'tipo', 'disponibilidad']

// Orden fijo de columnas en la matriz de precios.
const LIST_ORDER = ['us_min', 'us_wholesale', 've_min', 've_wholesale', 'special', 'luzmar']

export default function PricesUpload() {
  const { t } = useI18n()
  // Mismo criterio que ProductsAdmin/Catalog: los dos valores canónicos se
  // leen traducidos, el resto (Beauty, Electronics…) tal cual viene.
  const lineLabel = (raw) =>
    raw === 'Perfume' ? t('lineDesigner') : raw === 'Perfume - Arabes' ? t('lineArabic') : raw
  const { role } = useOutletContext()
  const isAdmin = role === 'admin'
  const [priceLists, setPriceLists] = useState([])
  const [busy, setBusy] = useState(false)
  const [committing, setCommitting] = useState(false)
  const [result, setResult] = useState(null)
  const [selectedListCode, setSelectedListCode] = useState('')
  // Preview de apply_price_list (p_commit: false) pendiente de confirmar:
  // { rows, data } | null. rows es lo mismo que se manda al confirmar, así
  // no hay que re-parsear el Excel al aplicar.
  const [preview, setPreview] = useState(null)

  // Matriz de precios: producto × lista.
  const [products, setProducts] = useState([])
  const [priceMap, setPriceMap] = useState(new Map()) // product_id -> { price_list_id: price }
  const [query, setQuery] = useState('')
  const [priceFilter, setPriceFilter] = useState('') // '' | 'has' | 'missing'
  const [listFilter, setListFilter] = useState('') // '' = todas las listas
  // Filtros por grupo de producto (2026-08-07): mirar los precios de un
  // recorte concreto — los 🔥 Flash Sale, los ✨ Nuevos, los Pre-Order, una
  // marca, los árabes. Son los mismos de la pestaña Productos (ui.jsx).
  const [catFilter, setCatFilter] = useState('')
  const [lineFilter, setLineFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [visibleRows, sentinelRef] = useInfiniteRows(100, [
    query,
    priceFilter,
    listFilter,
    catFilter,
    lineFilter,
    statusFilter,
  ])

  const load = async () => {
    try {
      const [pls, ps, pps] = await Promise.all([
        fetchAll('price_lists'),
        // Los campos de más son los que necesitan los filtros por grupo
        // (marca, línea, disponibilidad, ✨ nuevo, activo, stock).
        fetchAll(
          'products',
          'id, sku, upc, name, category, product_line, availability, new_until, active, stock, deactivated_by_stock',
          'name',
        ),
        fetchAll('product_prices', 'product_id, price_list_id, price', ['product_id', 'price_list_id']),
      ])
      // 'quote' nunca usa product_prices (get_catalog la ignora por
      // completo): no tiene sentido subirle ni mostrarle precios acá.
      setPriceLists(pls.filter((l) => l.code !== 'quote'))
      setProducts(ps)
      const map = new Map()
      for (const pp of pps) {
        const entry = map.get(pp.product_id) ?? {}
        entry[pp.price_list_id] = pp.price
        map.set(pp.product_id, entry)
      }
      setPriceMap(map)
    } catch {
      /* la vista queda como estaba; el próximo load reintenta */
    }
  }

  useEffect(() => {
    load()
  }, [])

  const orderedLists = useMemo(
    () => [...priceLists].sort((a, b) => LIST_ORDER.indexOf(a.code) - LIST_ORDER.indexOf(b.code)),
    [priceLists],
  )

  const categories = useMemo(
    () => [...new Set(products.map((p) => p.category).filter(Boolean))].sort(),
    [products],
  )
  const lines = useMemo(
    () => [...new Set(products.map((p) => p.product_line).filter(Boolean))].sort(),
    [products],
  )

  // Filtrar por lista: la matriz muestra solo esa columna, y "solo sin
  // precios" pasa a significar "sin precio en esa lista".
  const visibleLists = useMemo(
    () => (listFilter ? orderedLists.filter((l) => l.id === listFilter) : orderedLists),
    [orderedLists, listFilter],
  )

  // "Tiene precio" es lo MISMO que decide get_catalog: un 0 no cuenta
  // (2026-08-06, migration-2026-08-06-require-price.sql). Si acá se contara
  // como precio, el panel diría "con precios" de un producto que el catálogo
  // esconde — la misma clase de contradicción panel/catálogo que hubo con los
  // grupos de Flash Sales.
  const hasPrice = (productId, listId) => {
    const value = priceMap.get(productId)?.[listId]
    return value != null && Number(value) > 0
  }

  // Universo sobre el que se cuenta y se lista. Los filtros por grupo
  // (marca/línea/estado) SÍ recortan los contadores: el sentido de filtrar
  // por 🔥 Flash Sale es justamente saber cuántos de ESOS están sin precio.
  // El buscador de texto no entra, para que el número no baile tecla a tecla.
  const inGroup = useMemo(
    () => products.filter((p) => productMatchesFilters(p, { catFilter, lineFilter, statusFilter })),
    [products, catFilter, lineFilter, statusFilter],
  )

  const withPricesCount = useMemo(
    () => inGroup.filter((p) => visibleLists.some((l) => hasPrice(p.id, l.id))).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inGroup, priceMap, visibleLists],
  )
  const missingPricesCount = inGroup.length - withPricesCount

  const filtered = useMemo(
    () =>
      inGroup.filter((p) => {
        const hasVisiblePrice = visibleLists.some((l) => hasPrice(p.id, l.id))
        if (priceFilter === 'has' && !hasVisiblePrice) return false
        if (priceFilter === 'missing' && hasVisiblePrice) return false
        return productMatchesFilters(p, { query })
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inGroup, priceMap, visibleLists, query, priceFilter],
  )

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setResult(null)
    setPreview(null)

    if (!selectedListCode) {
      setResult({ ok: false, message: t('chooseTargetList') })
      return
    }

    setBusy(true)
    try {
      const rows = await parseSheet(file)
      if (rows.length === 0) throw new Error('Archivo vacío')

      const headers = Object.keys(rows[0])
      const skuHeader = headers.find((h) => SKU_ALIASES.includes(h))
      if (!skuHeader) throw new Error('No se encontró la columna SKU')

      const selectedList = priceLists.find((l) => l.code === selectedListCode)
      const priceAliases = [
        ...GENERIC_PRICE_ALIASES,
        ...(LIST_ALIASES[selectedListCode] ?? []),
        normalizeHeader(selectedList?.label ?? ''),
        selectedListCode,
      ]
      const priceHeader = headers.find((h) => priceAliases.includes(h))
      if (!priceHeader) throw new Error('No se encontró ninguna columna de precio')

      const typeHeader = headers.find((h) => TYPE_ALIASES.includes(h))

      // La RPC deduplica por SKU y valida el precio/tipo del lado del
      // servidor: acá solo se arma { sku, price, type } por fila, sin
      // filtrar nada (para que el preview reporte precios inválidos y
      // SKU desconocidos con precisión, en vez de descartarlos en
      // silencio).
      const filas = []
      for (const row of rows) {
        const sku = String(row[skuHeader] ?? '').trim()
        if (!sku) continue
        const price = String(row[priceHeader] ?? '').replace(/[$,\s]/g, '')
        const type = typeHeader ? String(row[typeHeader] ?? '').trim() : ''
        filas.push({ sku, price, type })
      }
      if (filas.length === 0) throw new Error('El archivo no tiene filas con SKU')

      const { data, error } = await supabase.rpc('apply_price_list', {
        p_price_list_code: selectedListCode,
        p_rows: filas,
        p_commit: false,
      })
      if (error) throw error

      setPreview({ rows: filas, data })
    } catch (err) {
      setResult({ ok: false, message: err.message })
    }
    setBusy(false)
  }

  const confirmApply = async () => {
    if (!preview) return
    setCommitting(true)
    try {
      const { data, error } = await supabase.rpc('apply_price_list', {
        p_price_list_code: selectedListCode,
        p_rows: preview.rows,
        p_commit: true,
      })
      if (error) throw error
      setResult({
        ok: true,
        message: `${data.to_upsert} ${t('updated')} · ${data.to_reactivate} ${t('reactivated')} · ${data.to_deactivate} ${t('deactivated')}${
          data.blocked_by_stock > 0 ? ` · 📦 ${data.blocked_by_stock} ${t('blockedByStockLabel')}` : ''
        }${
          data.blocked_noncatalog > 0
            ? ` · 🚫 ${data.blocked_noncatalog} ${t('blockedNonCatalogLabel')}`
            : ''
        }`,
      })
      setPreview(null)
      await load()
    } catch (err) {
      setResult({ ok: false, message: err.message })
      // El resumen de una carga que SÍ entró lo escribe la propia RPC dentro
      // de su transacción (price_apply_summary). El fallo solo puede loguearse
      // desde acá: una excepción en la RPC revierte la transacción entera,
      // incluido cualquier log que hubiera dejado adentro (2026-08-20, ver
      // migration-2026-08-20-price-apply-log.sql).
      logEvent('error', 'price_upload', 'price_apply_failed', err.message, {
        list_code: selectedListCode,
        rows_in_file: preview.rows.length,
      })
    }
    setCommitting(false)
  }

  const cancelPreview = () => setPreview(null)

  return (
    <div className="space-y-4">
      <div className="max-w-2xl space-y-4">
        <h2 className="font-brand text-2xl font-semibold">{t('prices')}</h2>
        {isAdmin && (
          <>
            <p className="text-sm leading-relaxed text-primary/60">{t('priceUploadHint')}</p>

            <label className="block text-sm">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-primary/50">
                {t('targetListLabel')}
              </span>
              <select
                value={selectedListCode}
                onChange={(e) => {
                  setSelectedListCode(e.target.value)
                  setPreview(null)
                  setResult(null)
                }}
                className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none transition-colors focus:border-secondary md:max-w-xs"
              >
                <option value="">—</option>
                {orderedLists.map((l) => (
                  <option key={l.id} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>

            {!preview && (
              <label className="block cursor-pointer rounded-2xl border-2 border-dashed border-secondary/50 bg-surface p-10 text-center shadow-sm transition-colors hover:border-secondary hover:bg-gold-pale/20">
                <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} className="hidden" />
                <span className="text-3xl">📊</span>
                <p className="mt-2 font-semibold">{busy ? t('processing') : t('uploadExcel')}</p>
              </label>
            )}

            {preview && (
              <div className="space-y-3 rounded-2xl border border-secondary/40 bg-gold-pale/10 p-4">
                <h3 className="font-brand text-lg font-semibold">{t('previewTitle')}</h3>
                <div className="flex flex-wrap gap-2 text-xs font-semibold">
                  <span className="rounded-full bg-green-100 px-3 py-1 text-green-800 dark:bg-green-900/50 dark:text-green-300">
                    {preview.data.to_upsert} {t('toUpsertLabel')}
                  </span>
                  <span className="rounded-full bg-secondary/15 px-3 py-1 text-secondary-dark">
                    {preview.data.to_reactivate} {t('toReactivateLabel')}
                  </span>
                  {/* 2026-08-12: los que traen precio y están inactivos pero NO
                      vuelven al catálogo con esta carga porque su stock está en
                      0 — el trigger los deja marcados para publicarse cuando
                      entre stock. Sin este chip, "a reactivar" prometía de más. */}
                  {preview.data.blocked_by_stock > 0 && (
                    <span
                      className="rounded-full bg-amber-100 px-3 py-1 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300"
                      title={t('inactiveByStockTitle')}
                    >
                      📦 {preview.data.blocked_by_stock} {t('blockedByStockLabel')}
                    </span>
                  )}
                  {/* 2026-08-13: las filas -BOX/-SPECIAL del archivo. Se les
                      guarda el precio, pero no se publican nunca — sin este chip
                      contaban como "a reactivar" y no volvía ninguna. */}
                  {preview.data.blocked_noncatalog > 0 && (
                    <span
                      className="rounded-full bg-primary/10 px-3 py-1 text-primary/60"
                      title={t('nonCatalogSkuTitle')}
                    >
                      🚫 {preview.data.blocked_noncatalog} {t('blockedNonCatalogLabel')}
                    </span>
                  )}
                  <span className="rounded-full bg-red-100 px-3 py-1 text-red-700 dark:bg-red-900/50 dark:text-red-300">
                    {preview.data.to_deactivate} {t('toDeactivateLabel')}
                  </span>
                  <span className="rounded-full bg-primary/10 px-3 py-1 text-primary/60">
                    {preview.data.unknown_skus} {t('unknownSkusLabel')}
                  </span>
                  <span className="rounded-full bg-primary/10 px-3 py-1 text-primary/60">
                    {preview.data.invalid_prices} {t('invalidPricesLabel')}
                  </span>
                </div>

                {preview.data.deactivate_sample?.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-primary/60">{t('deactivateSampleHint')}</p>
                    <ul className="max-h-40 space-y-0.5 overflow-y-auto text-xs">
                      {preview.data.deactivate_sample.map((p) => (
                        <li
                          key={p.sku}
                          className="flex justify-between gap-2 border-b border-line/40 py-0.5"
                        >
                          <span className="truncate">{p.name}</span>
                          <span className="shrink-0 font-mono text-primary/45">{p.sku}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {preview.data.unknown_sample?.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-primary/60">{t('unknownSampleHint')}</p>
                    <p className="max-h-24 overflow-y-auto break-words font-mono text-xs text-primary/70">
                      {preview.data.unknown_sample.join(', ')}
                    </p>
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <button
                    onClick={confirmApply}
                    disabled={committing}
                    className="rounded-xl bg-secondary px-4 py-2 text-sm font-bold text-ink transition-colors hover:bg-secondary-dark disabled:opacity-50"
                  >
                    {committing ? t('applying') : t('confirmApply')}
                  </button>
                  <button
                    onClick={cancelPreview}
                    disabled={committing}
                    className="rounded-xl border border-line px-4 py-2 text-sm text-primary/60 transition-colors hover:border-primary/40 disabled:opacity-50"
                  >
                    {t('cancel')}
                  </button>
                </div>
              </div>
            )}

            {result && (
              <p
                className={`rounded-lg p-3 text-sm ${
                  result.ok ? 'bg-green-50 text-green-800 dark:bg-green-950/50 dark:text-green-300' : 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300'
                }`}
              >
                {result.message}
              </p>
            )}
          </>
        )}
      </div>

      {/* Matriz de precios por lista */}
      <div className="space-y-3 pt-2">
        <h3 className="font-brand text-xl font-semibold">{t('priceMatrixTitle')}</h3>
        {/* Filtros por grupo de producto: los mismos de la pestaña Productos
            (ui.jsx), para poder mirar los precios de un recorte concreto. */}
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
        />
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <select
            value={listFilter}
            onChange={(e) => setListFilter(e.target.value)}
            className={`${inputCls} md:flex-1`}
          >
            <option value="">{t('allLists')}</option>
            {orderedLists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => setPriceFilter(priceFilter === 'has' ? '' : 'has')}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
              priceFilter === 'has'
                ? 'bg-ink text-secondary ring-1 ring-secondary/40'
                : 'bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-900/50 dark:text-green-300 dark:hover:bg-green-900'
            }`}
          >
            {withPricesCount} {t('withPrices')}
          </button>
          <button
            onClick={() => setPriceFilter(priceFilter === 'missing' ? '' : 'missing')}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
              priceFilter === 'missing'
                ? 'bg-ink text-secondary ring-1 ring-secondary/40'
                : 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/50 dark:text-red-300 dark:hover:bg-red-900'
            }`}
          >
            {missingPricesCount} {t('withoutPrices')}
          </button>
        </div>

        <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-primary/45">
                <th className="p-3">{t('name')}</th>
                {visibleLists.map((l) => (
                  <th key={l.id} className="p-3 text-right">
                    {l.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, visibleRows).map((p) => {
                const row = priceMap.get(p.id)
                return (
                  <tr key={p.id} className="border-b border-line/60 transition-colors hover:bg-gold-pale/20">
                    <td className="p-3">
                      <span className="font-medium">{p.name}</span>
                      {/* Mismas etiquetas que la pestaña Productos: con los
                          filtros por grupo puestos hay que poder ver de qué
                          producto se está mirando el precio. */}
                      {p.availability === 'flash' && (
                        <span className="ml-2 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink">
                          🔥 {t('flashSale')}
                        </span>
                      )}
                      {p.availability === 'preorder' && (
                        <span className="ml-2 rounded-full bg-gold-pale px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-secondary-dark">
                          {t('preorder')}
                        </span>
                      )}
                      {isNewProduct(p) && (
                        <span className="ml-2 rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-green-800 dark:bg-green-900/50 dark:text-green-300">
                          ✨ {t('newTag')}
                        </span>
                      )}
                      {!p.active && (
                        <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-700 dark:bg-red-900/50 dark:text-red-300">
                          {t('inactive')}
                        </span>
                      )}
                      <span className="block font-mono text-[11px] text-primary/45">{p.sku}</span>
                    </td>
                    {visibleLists.map((l) => {
                      const price = row?.[l.id]
                      return (
                        <td key={l.id} className="p-3 text-right font-brand">
                          {hasPrice(p.id, l.id) ? (
                            <span className="font-semibold">{money(price)}</span>
                          ) : price != null ? (
                            // Hay fila en product_prices pero con 0: no es
                            // "sin precio cargado", es un precio inválido, y el
                            // catálogo esconde el producto. Se marca distinto
                            // para poder encontrarlo y corregirlo.
                            <span
                              title={t('invalidZeroPriceHint')}
                              className="font-semibold text-red-600 dark:text-red-400"
                            >
                              {money(price)} ⚠
                            </span>
                          ) : (
                            <span className="text-primary/25">—</span>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
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
    </div>
  )
}

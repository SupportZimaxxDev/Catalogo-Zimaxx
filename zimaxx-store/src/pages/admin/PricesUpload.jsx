import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase, fetchAll } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { parseSheet, normalizeHeader } from '../../utils/excel'
import { money } from '../../utils/format'
import { SearchIcon, inputCls, useInfiniteRows } from './ui'

// Alias aceptados por lista para las columnas del Excel de precios.
const LIST_ALIASES = {
  us_min: ['us minimum order', 'us min', 'us minimum', 'us_min'],
  us_wholesale: ['us wholesale', 'us_wholesale'],
  ve_min: ['ve minimum order', 've min', 've minimum', 've_min'],
  ve_wholesale: ['ve wholesale', 've_wholesale'],
  special: ['special', 'special order', 'us special', 've special'],
  luzmar: ['luzmar', 'luzmar special', 'precio luzmar', 'luzmar especial'],
}
const SKU_ALIASES = ['sku', 'codigo', 'código', 'code', 'productid']

// Listas "generales" reales (ej. "Wholesale Perfume"): una sola columna
// de precio sin decir a qué lista pertenece. Se detecta y el admin elige
// la lista destino en un selector antes de subir.
const GENERIC_PRICE_ALIASES = ['price', 'precio', 'precio unitario', 'unit price']

// Orden fijo de columnas en la matriz de precios.
const LIST_ORDER = ['us_min', 'us_wholesale', 've_min', 've_wholesale', 'special', 'luzmar']

export default function PricesUpload() {
  const { t } = useI18n()
  const { role } = useOutletContext()
  const isAdmin = role === 'admin'
  const [priceLists, setPriceLists] = useState([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [targetList, setTargetList] = useState('')

  // Matriz de precios: producto × lista.
  const [products, setProducts] = useState([])
  const [priceMap, setPriceMap] = useState(new Map()) // product_id -> { price_list_id: price }
  const [query, setQuery] = useState('')
  const [priceFilter, setPriceFilter] = useState('') // '' | 'has' | 'missing'
  const [listFilter, setListFilter] = useState('') // '' = todas las listas
  const [visibleRows, sentinelRef] = useInfiniteRows(100, [query, priceFilter, listFilter])

  const load = async () => {
    try {
      const [pls, ps, pps] = await Promise.all([
        fetchAll('price_lists'),
        fetchAll('products', 'id, sku, name', 'name'),
        fetchAll('product_prices', 'product_id, price_list_id, price', 'product_id'),
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

  // Filtrar por lista: la matriz muestra solo esa columna, y "solo sin
  // precios" pasa a significar "sin precio en esa lista".
  const visibleLists = useMemo(
    () => (listFilter ? orderedLists.filter((l) => l.id === listFilter) : orderedLists),
    [orderedLists, listFilter],
  )

  // Contadores de los botones de filtro: sobre todos los productos (no
  // solo los que matchea el buscador), igual que los contadores de la
  // pestaña Productos — así el número no cambia al escribir en el buscador.
  const withPricesCount = useMemo(
    () => products.filter((p) => visibleLists.some((l) => priceMap.get(p.id)?.[l.id] != null)).length,
    [products, priceMap, visibleLists],
  )
  const missingPricesCount = products.length - withPricesCount

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return products.filter((p) => {
      const hasVisiblePrice = visibleLists.some((l) => priceMap.get(p.id)?.[l.id] != null)
      if (priceFilter === 'has' && !hasVisiblePrice) return false
      if (priceFilter === 'missing' && hasVisiblePrice) return false
      if (q && !p.name.toLowerCase().includes(q) && !String(p.sku).toLowerCase().includes(q))
        return false
      return true
    })
  }, [products, priceMap, visibleLists, query, priceFilter])

  const handleFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    setBusy(true)
    setResult(null)

    try {
      const rows = await parseSheet(file)
      if (rows.length === 0) throw new Error('Archivo vacío')

      // Detectar qué columnas del archivo corresponden a cada lista.
      const headers = Object.keys(rows[0])
      const listByHeader = {}
      for (const list of priceLists) {
        const aliases = [
          ...(LIST_ALIASES[list.code] ?? []),
          normalizeHeader(list.label),
          list.code,
        ]
        const match = headers.find((h) => aliases.includes(h))
        if (match) listByHeader[match] = list.id
      }
      const skuHeader = headers.find((h) => SKU_ALIASES.includes(h))
      if (!skuHeader) throw new Error('No se encontró la columna SKU')

      // Columna de precio genérica (lista "general"): requiere que el
      // admin haya elegido la lista destino en el selector.
      if (Object.keys(listByHeader).length === 0) {
        const generic = headers.find((h) => GENERIC_PRICE_ALIASES.includes(h))
        if (generic && targetList) {
          listByHeader[generic] = targetList
        } else if (generic) {
          throw new Error(t('chooseTargetList'))
        } else {
          throw new Error('No se encontró ninguna columna de lista de precios')
        }
      }

      // Mapear SKU -> product_id (paginado: la tabla supera las 1,000
      // filas del límite por consulta de Supabase)
      const allProducts = await fetchAll('products', 'id, sku')
      const bySku = new Map(allProducts.map((p) => [String(p.sku).toLowerCase(), p.id]))

      const upserts = []
      const skippedSkus = []
      for (const row of rows) {
        const sku = String(row[skuHeader] ?? '').trim()
        if (!sku) continue
        const productId = bySku.get(sku.toLowerCase())
        if (!productId) {
          skippedSkus.push(sku)
          continue
        }
        for (const [header, listId] of Object.entries(listByHeader)) {
          const raw = String(row[header] ?? '').replace(/[$,\s]/g, '')
          if (raw === '') continue
          const price = Number(raw)
          if (!Number.isFinite(price) || price < 0) continue
          upserts.push({ product_id: productId, price_list_id: listId, price })
        }
      }

      if (upserts.length > 0) {
        const { error } = await supabase
          .from('product_prices')
          .upsert(upserts, { onConflict: 'product_id,price_list_id' })
        if (error) throw error
      }

      setResult({
        ok: true,
        message: `${upserts.length} ${t('updated')} · ${skippedSkus.length} SKU ${t('skipped')}${
          skippedSkus.length ? `: ${skippedSkus.slice(0, 10).join(', ')}` : ''
        }`,
      })
      await load()
    } catch (err) {
      setResult({ ok: false, message: err.message })
    }
    setBusy(false)
  }

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
                value={targetList}
                onChange={(e) => setTargetList(e.target.value)}
                className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm outline-none transition-colors focus:border-secondary md:max-w-xs"
              >
                <option value="">—</option>
                {orderedLists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block cursor-pointer rounded-2xl border-2 border-dashed border-secondary/50 bg-surface p-10 text-center shadow-sm transition-colors hover:border-secondary hover:bg-gold-pale/20">
              <input type="file" accept=".xlsx,.xls,.csv" onChange={handleFile} className="hidden" />
              <span className="text-3xl">📊</span>
              <p className="mt-2 font-semibold">{busy ? t('processing') : t('uploadExcel')}</p>
            </label>

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
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
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
            value={listFilter}
            onChange={(e) => setListFilter(e.target.value)}
            className={inputCls}
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
                      <span className="block font-mono text-[11px] text-primary/45">{p.sku}</span>
                    </td>
                    {visibleLists.map((l) => {
                      const price = row?.[l.id]
                      return (
                        <td key={l.id} className="p-3 text-right font-brand">
                          {price != null ? (
                            <span className="font-semibold">{money(price)}</span>
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

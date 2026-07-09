import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase, fetchAll } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { money } from '../../utils/format'
import { parseSheet, pick } from '../../utils/excel'
import { UploadZone, inputCls } from './ui'

const EMPTY = { product_id: '', price: '', starts_at: '', expires_at: '' }

// Alias de columnas del Excel "Special Flash Sale" (mismo formato letterhead
// que las listas wholesale: UPC, Sku, Brand, Title Product, Price, Type,
// Qty, Total Price). Solo se usan Sku y Price; Type/Qty/Total se ignoran
// porque acá el rango de fechas lo elige el admin arriba, no el archivo.
const SKU_ALIASES = ['sku', 'codigo', 'código', 'code', 'productid']
const PRICE_ALIASES = ['price', 'precio']

const STATUS_STYLES = {
  live: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300',
  scheduled: 'bg-gold-pale text-secondary-dark',
  expired: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400',
  deactivated: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
}

// datetime-local trabaja en hora local; convertir a ISO para Postgres.
const toIso = (local) => (local ? new Date(local).toISOString() : null)
const nowLocal = () => {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}
const isoToLocal = (iso) => {
  if (!iso) return ''
  const d = new Date(iso)
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

export default function FlashSalesAdmin() {
  const { t } = useI18n()
  const { role } = useOutletContext()
  const isAdmin = role === 'admin'
  const [sales, setSales] = useState([])
  const [products, setProducts] = useState([])
  const [form, setForm] = useState(null)
  const [error, setError] = useState('')

  // Carga masiva por Excel (2026-07-08): mismo archivo semanal "Special
  // Flash Sale" que ya usan para armar la promo, con precio por SKU. La
  // fecha de inicio/fin la elige el admin acá arriba, no viene del Excel.
  const [bulkRange, setBulkRange] = useState({ starts_at: nowLocal(), expires_at: '' })
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkResult, setBulkResult] = useState(null)
  const [statusFilter, setStatusFilter] = useState('')
  // Buscador del alta individual (2026-07-09): con miles de productos el
  // <select> era inusable — se escribe nombre o SKU y se elige de la lista.
  const [productQuery, setProductQuery] = useState('')

  const load = async () => {
    const [{ data: fs }, ps] = await Promise.all([
      supabase
        .from('flash_sales')
        .select('*, products(sku, name)')
        .order('expires_at', { ascending: false }),
      // Paginado: los productos activos superan el límite de 1,000
      // filas por consulta y el selector debe listarlos todos.
      fetchAll('products', 'id, sku, name, active', 'name').then((all) => all.filter((p) => p.active)),
    ])
    setSales(fs ?? [])
    setProducts(ps ?? [])
  }

  useEffect(() => {
    load()
  }, [])

  const save = async (e) => {
    e.preventDefault()
    setError('')
    if (!form.product_id) {
      setError(t('selectProduct'))
      return
    }
    const { error } = await supabase.from('flash_sales').insert({
      product_id: form.product_id,
      price: Number(form.price),
      starts_at: toIso(form.starts_at) ?? new Date().toISOString(),
      expires_at: toIso(form.expires_at),
      active: true,
    })
    if (error) {
      setError(error.message)
    } else {
      setForm(null)
      await load()
    }
  }

  const handleBulkFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''

    if (!bulkRange.expires_at) {
      setBulkResult({ ok: false, message: t('flashUploadNeedDates') })
      return
    }

    setBulkBusy(true)
    setBulkResult(null)

    try {
      const rows = await parseSheet(file)
      if (rows.length === 0) throw new Error('Archivo vacío')

      const bySku = new Map(products.map((p) => [String(p.sku).toLowerCase(), p]))
      const startsIso = toIso(bulkRange.starts_at) ?? new Date().toISOString()
      const expiresIso = toIso(bulkRange.expires_at)
      // Todas las filas de esta carga comparten batch_id para poder
      // desactivarlas juntas después desde la tabla (2026-07-09).
      const batchId = crypto.randomUUID()

      const inserts = []
      let notFound = 0
      let noPrice = 0

      for (const row of rows) {
        const skuRaw = pick(row, SKU_ALIASES)
        const product = skuRaw ? bySku.get(String(skuRaw).trim().toLowerCase()) : undefined
        if (!product) {
          notFound++
          continue
        }
        const price = Number(String(pick(row, PRICE_ALIASES) ?? '').replace(/[$,\s]/g, ''))
        if (!Number.isFinite(price) || price < 0) {
          noPrice++
          continue
        }
        inserts.push({
          product_id: product.id,
          price,
          starts_at: startsIso,
          expires_at: expiresIso,
          active: true,
          batch_id: batchId,
        })
      }

      if (inserts.length > 0) {
        const { error } = await supabase.from('flash_sales').insert(inserts)
        if (error) throw error
      }

      setBulkResult({
        ok: true,
        message: `${inserts.length} ${t('created')} · ${notFound} ${t('notMatched')} · ${noPrice} ${t('skipped')}`,
      })
      await load()
    } catch (err) {
      setBulkResult({ ok: false, message: err.message })
    }
    setBulkBusy(false)
  }

  const deactivate = async (id) => {
    await supabase.from('flash_sales').update({ active: false }).eq('id', id)
    await load()
  }

  // Los grupos se arman client-side (por batch_id O por misma fecha de
  // expiración), así que desactivar/reprogramar un grupo opera sobre la
  // lista de ids concreta en vez de un WHERE por batch — funciona igual
  // para lotes de Excel y para ofertas sueltas que comparten vencimiento.
  const deactivateGroup = async (items) => {
    const ids = items.filter((i) => i.active).map((i) => i.id)
    if (ids.length === 0) return
    await supabase.from('flash_sales').update({ active: false }).in('id', ids)
    await load()
  }

  const updateExpiry = async (ids, localDate) => {
    const iso = toIso(localDate)
    if (!iso) return
    await supabase.from('flash_sales').update({ expires_at: iso }).in('id', ids)
    await load()
  }

  // El apagado por fecha es automático (get_flash_sales() ya filtra por
  // expires_at): 'active' solo sirve para cortar la oferta ANTES de su
  // fecha. Esta función distingue los 4 casos para que la tabla no
  // muestre "Inactivo" por igual a algo que expiró solo por fecha y a
  // algo que se desactivó a mano.
  const saleStatus = (s) => {
    const now = new Date()
    if (!s.active) return 'deactivated'
    if (now < new Date(s.starts_at)) return 'scheduled'
    if (now >= new Date(s.expires_at)) return 'expired'
    return 'live'
  }

  const filteredSales = statusFilter ? sales.filter((s) => saleStatus(s) === statusFilter) : sales

  // Agrupa por lote de carga masiva (batch_id) y, para las que no tienen
  // lote (alta manual o cargadas antes de que existiera batch_id), por
  // misma fecha de expiración — lo típico es que la promo de la semana
  // comparta vencimiento aunque se haya cargado producto por producto.
  // Grupos de 1 se muestran como fila suelta.
  const byKey = new Map()
  for (const s of filteredSales) {
    const key = s.batch_id ?? `exp:${s.expires_at}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(s)
  }
  const rows = []
  const seenKeys = new Set()
  for (const s of filteredSales) {
    const key = s.batch_id ?? `exp:${s.expires_at}`
    if (seenKeys.has(key)) continue
    seenKeys.add(key)
    const items = byKey.get(key)
    if (items.length > 1) {
      rows.push({ type: 'group', key, isBatch: !!s.batch_id, items })
    } else {
      rows.push({ type: 'single', item: s })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">⚡ {t('flashSales')}</h2>
        {isAdmin && (
          <button
            onClick={() => {
              setForm({ ...EMPTY, starts_at: nowLocal() })
              setProductQuery('')
            }}
            className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-secondary hover:bg-ink-soft"
          >
            + Flash Sale
          </button>
        )}
      </div>

      {isAdmin && form && (
        <form onSubmit={save} className="grid gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm md:grid-cols-2">
          {/* Selector de producto con búsqueda: escribir nombre o SKU y
              elegir de la lista (máx. 30 resultados para no colgar el DOM). */}
          <div className="md:col-span-2">
            {form.product_id ? (
              (() => {
                const sel = products.find((p) => p.id === form.product_id)
                return (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-secondary/50 bg-gold-pale/30 px-3 py-2 text-sm">
                    <span>
                      <span className="font-mono text-xs text-primary/50">{sel?.sku}</span>{' '}
                      <span className="font-semibold">{sel?.name}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setForm({ ...form, product_id: '' })
                        setProductQuery('')
                      }}
                      className="shrink-0 text-xs font-semibold text-secondary-dark hover:underline"
                    >
                      {t('change')}
                    </button>
                  </div>
                )
              })()
            ) : (
              <>
                <input
                  autoFocus
                  type="search"
                  value={productQuery}
                  onChange={(e) => setProductQuery(e.target.value)}
                  placeholder={`${t('selectProduct')} — ${t('searchProducts')}`}
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-secondary"
                />
                {productQuery.trim() && (
                  <div className="mt-1 max-h-52 overflow-y-auto rounded-lg border border-line">
                    {products
                      .filter((p) => {
                        const q = productQuery.trim().toLowerCase()
                        return (
                          p.name.toLowerCase().includes(q) ||
                          String(p.sku).toLowerCase().includes(q)
                        )
                      })
                      .slice(0, 30)
                      .map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setForm({ ...form, product_id: p.id })}
                          className="block w-full border-b border-line/60 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-gold-pale/30"
                        >
                          <span className="font-mono text-xs text-primary/50">{p.sku}</span> {p.name}
                        </button>
                      ))}
                  </div>
                )}
              </>
            )}
          </div>
          <label className="text-sm">
            {t('promoPrice')} (USD)
            <input
              required
              type="number"
              step="0.01"
              min="0"
              value={form.price}
              onChange={(e) => setForm({ ...form, price: e.target.value })}
              className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-secondary"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              {t('startsAt')}
              <input
                type="datetime-local"
                value={form.starts_at}
                onChange={(e) => setForm({ ...form, starts_at: e.target.value })}
                className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-secondary"
              />
            </label>
            <label className="text-sm">
              {t('expiresAt')}
              <input
                required
                type="datetime-local"
                value={form.expires_at}
                onChange={(e) => setForm({ ...form, expires_at: e.target.value })}
                className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-secondary"
              />
            </label>
          </div>
          {error && <p className="text-sm text-red-600 dark:text-red-400 md:col-span-2">{error}</p>}
          <div className="flex gap-2 md:col-span-2">
            <button className="rounded-lg bg-secondary px-5 py-2 text-sm font-semibold text-ink hover:bg-secondary-dark">
              {t('save')}
            </button>
            <button
              type="button"
              onClick={() => setForm(null)}
              className="rounded-lg border border-primary/20 px-5 py-2 text-sm hover:bg-primary/5"
            >
              {t('cancel')}
            </button>
          </div>
        </form>
      )}

      {isAdmin && (
        <div className="space-y-3 rounded-2xl border border-line bg-surface p-4 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wider text-primary/60">
            {t('bulkFlashUpload')}
          </p>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              {t('startsAt')}
              <input
                type="datetime-local"
                value={bulkRange.starts_at}
                onChange={(e) => setBulkRange({ ...bulkRange, starts_at: e.target.value })}
                className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-secondary"
              />
            </label>
            <label className="text-sm">
              {t('expiresAt')}
              <input
                required
                type="datetime-local"
                value={bulkRange.expires_at}
                onChange={(e) => setBulkRange({ ...bulkRange, expires_at: e.target.value })}
                className="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-secondary"
              />
            </label>
          </div>
          <UploadZone
            icon="📊"
            title={t('uploadExcel')}
            hint={t('flashUploadHint')}
            busy={bulkBusy}
            result={bulkResult}
            onFile={handleBulkFile}
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputCls}>
          <option value="">{t('allStatuses')}</option>
          <option value="live">{t('flashStatus_live')}</option>
          <option value="scheduled">{t('flashStatus_scheduled')}</option>
          <option value="expired">{t('flashStatus_expired')}</option>
          <option value="deactivated">{t('flashStatus_deactivated')}</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-primary/10 text-left text-xs uppercase text-primary/50">
              <th className="p-3">{t('product')}</th>
              <th className="p-3">{t('promoPrice')}</th>
              <th className="p-3">{t('startsAt')}</th>
              <th className="p-3">{t('expiresAt')}</th>
              <th className="p-3">{t('status')}</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) =>
              row.type === 'single' ? (
                <tr key={row.item.id} className="border-b border-primary/5">
                  <SaleRow
                    s={row.item}
                    t={t}
                    isAdmin={isAdmin}
                    saleStatus={saleStatus}
                    deactivate={deactivate}
                    updateExpiry={updateExpiry}
                  />
                </tr>
              ) : (
                <FlashGroup
                  key={row.key}
                  isBatch={row.isBatch}
                  items={row.items}
                  t={t}
                  isAdmin={isAdmin}
                  saleStatus={saleStatus}
                  deactivate={deactivate}
                  deactivateGroup={deactivateGroup}
                  updateExpiry={updateExpiry}
                />
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// Fecha de expiración editable con un click (solo admin): mismo patrón
// que el teléfono en VendedoresAdmin — click sobre el valor, aparece el
// datetime-local, Enter o click afuera guarda.
function ExpiryCell({ s, isAdmin, updateExpiry }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  if (!isAdmin) return <span>{new Date(s.expires_at).toLocaleString()}</span>

  if (!editing) {
    return (
      <button
        onClick={() => {
          setDraft(isoToLocal(s.expires_at))
          setEditing(true)
        }}
        className="text-left underline decoration-dotted underline-offset-2 hover:text-secondary-dark"
        title="Editar fecha"
      >
        {new Date(s.expires_at).toLocaleString()}
      </button>
    )
  }

  const commit = () => {
    setEditing(false)
    if (draft && draft !== isoToLocal(s.expires_at)) updateExpiry([s.id], draft)
  }

  return (
    <input
      autoFocus
      type="datetime-local"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') setEditing(false)
      }}
      className="rounded-lg border border-secondary bg-surface px-2 py-1 text-xs outline-none"
    />
  )
}

function SaleRow({ s, t, isAdmin, saleStatus, deactivate, updateExpiry }) {
  return (
    <>
      <td className="p-3">
        <span className="font-mono text-xs text-primary/50">{s.products?.sku}</span> {s.products?.name}
      </td>
      <td className="p-3 font-bold text-secondary-dark">{money(s.price)}</td>
      <td className="p-3 text-primary/60">{new Date(s.starts_at).toLocaleString()}</td>
      <td className="p-3 text-primary/60">
        <ExpiryCell s={s} isAdmin={isAdmin} updateExpiry={updateExpiry} />
      </td>
      <td className="p-3">
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLES[saleStatus(s)]}`}>
          {t(`flashStatus_${saleStatus(s)}`)}
        </span>
      </td>
      <td className="p-3 text-right">
        {isAdmin && s.active && (
          <button onClick={() => deactivate(s.id)} className="text-xs font-semibold text-red-600 hover:underline">
            {t('deactivate')}
          </button>
        )}
      </td>
    </>
  )
}

// Grupo de ofertas: un lote de carga masiva (batch_id) o varias ofertas
// sueltas con la misma fecha de vencimiento. Encabezado con contador,
// botón para desactivar el grupo entero y un datetime-local para
// reprogramar el vencimiento de todas juntas; debajo, sus filas con un
// borde izquierdo dorado que marca que son un grupo.
function FlashGroup({ isBatch, items, t, isAdmin, saleStatus, deactivate, deactivateGroup, updateExpiry }) {
  const [groupDate, setGroupDate] = useState('')
  const activeCount = items.filter((i) => i.active).length
  const liveCount = items.filter((i) => saleStatus(i) === 'live').length

  return (
    <>
      <tr className="border-b border-primary/5 bg-gold-pale/20">
        <td colSpan={3} className="p-3 text-xs font-semibold text-primary/70">
          🗂️ {t(isBatch ? 'flashBatchGroup' : 'flashExpiryGroup')} · {items.length} {t('items')} ·{' '}
          {liveCount} {t('flashStatus_live')}
        </td>
        <td colSpan={2} className="p-3">
          {isAdmin && (
            <span className="flex items-center gap-1.5">
              <input
                type="datetime-local"
                value={groupDate}
                onChange={(e) => setGroupDate(e.target.value)}
                className="rounded-lg border border-line bg-surface px-2 py-1 text-xs outline-none focus:border-secondary"
              />
              <button
                disabled={!groupDate}
                onClick={() => {
                  updateExpiry(items.map((i) => i.id), groupDate)
                  setGroupDate('')
                }}
                className="whitespace-nowrap text-xs font-semibold text-secondary-dark hover:underline disabled:opacity-40"
              >
                {t('applyToGroup')}
              </button>
            </span>
          )}
        </td>
        <td className="p-3 text-right">
          {isAdmin && activeCount > 0 && (
            <button
              onClick={() => deactivateGroup(items)}
              className="whitespace-nowrap text-xs font-semibold text-red-600 hover:underline"
            >
              {t('deactivateGroup')}
            </button>
          )}
        </td>
      </tr>
      {items.map((s) => (
        <tr key={s.id} className="border-b border-primary/5 border-l-2 border-l-secondary/40">
          <SaleRow
            s={s}
            t={t}
            isAdmin={isAdmin}
            saleStatus={saleStatus}
            deactivate={deactivate}
            updateExpiry={updateExpiry}
          />
        </tr>
      ))}
    </>
  )
}

import { Fragment, useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase, fetchAll } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { money, cleanPhone } from '../../utils/format'
import { downloadOrderExcel } from '../../utils/excel'
import { downloadOrderPdf } from '../../utils/pdf'
import { SearchIcon, inputCls } from './ui'

// Estilos de badge por estado (2026-07-15 agrega 'cancelled': un pedido
// se arma y confirma, pero a veces el cliente lo cancela después).
const STATUS_STYLES = {
  new: 'bg-gold-pale text-secondary-dark',
  done: 'bg-primary/10 text-primary/50',
  cancelled: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
}

// Bandeja de pedidos: cada uno se marca atendido para no depender de la
// memoria del chat de WhatsApp.
export default function OrdersAdmin() {
  const { t } = useI18n()
  const { role } = useOutletContext()
  const isAdmin = role === 'admin'
  const [orders, setOrders] = useState([])
  const [expanded, setExpanded] = useState(null)

  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [repFilter, setRepFilter] = useState('')

  // Cotizaciones (kind='quote') nunca guardan precio congelado — se
  // recalculan con el precio VIGENTE del producto (2026-07-17, a pedido
  // del usuario). livePricing guarda {orderId: {items, total}} pisando
  // lo que se muestra para esos pedidos; ver displayOf().
  const [livePricing, setLivePricing] = useState({})

  // Edición de ítems de un pedido (2026-07-17): cantidades, quitar y
  // agregar productos, auditado server-side vía update_order_items.
  const [editing, setEditing] = useState(null)
  const [editItems, setEditItems] = useState([])
  const [editError, setEditError] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [productQuery, setProductQuery] = useState('')
  const [products, setProducts] = useState(null)

  const loadLivePricing = async (list) => {
    const quoteIds = list.filter((o) => o.kind === 'quote').map((o) => o.id)
    if (quoteIds.length === 0) return
    const { data } = await supabase.rpc('get_quotes_live_pricing', { p_order_ids: quoteIds })
    if (data) setLivePricing((prev) => ({ ...prev, ...data }))
  }

  useEffect(() => {
    // A una vendedora, RLS ya le filtra esto a sus propios pedidos —
    // el join de vendedora solo importa para el filtro que ve el admin.
    supabase
      .from('orders')
      .select('*, clients(name, phone, vendedora_id, vendedores(name))')
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data }) => {
        const list = data ?? []
        setOrders(list)
        loadLivePricing(list)
      })
  }, [])

  const setStatus = async (id, status) => {
    const { error } = await supabase.from('orders').update({ status }).eq('id', id)
    if (!error) setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status } : o)))
  }

  // Ítems/total a mostrar: los de la cotización se pisan con el precio
  // vigente si ya se cargó (livePricing); si no, se ve lo guardado
  // (siempre sin precio para una cotización recién creada).
  const displayOf = (o) =>
    (o.kind === 'quote' && livePricing[o.id]) || { items: o.items ?? [], total: o.total }

  const exportOrder = (o) => {
    const stamp = new Date(o.created_at).toISOString().slice(0, 10)
    downloadOrderExcel(displayOf(o).items ?? [], `${stamp}-${o.id.slice(0, 8)}`)
  }

  const exportPdf = (o) => {
    const d = displayOf(o)
    downloadOrderPdf({ t, clientName: o.clients?.name ?? '', items: d.items ?? [], total: d.total })
  }

  const startEdit = async (o) => {
    setEditing(o.id)
    setEditError('')
    setEditItems(
      (o.items ?? []).map((i) => ({ id: i.id, sku: i.sku, name: i.name, qty: i.qty, flash: !!i.flash })),
    )
    setProductQuery('')
    if (products === null) {
      setProducts([])
      const all = await fetchAll('products', 'id, sku, name, active', 'name')
      setProducts(all.filter((p) => p.active))
    }
  }

  const cancelEdit = () => {
    setEditing(null)
    setEditItems([])
    setEditError('')
  }

  const setEditQty = (id, qty) => {
    const clean = Math.max(1, Math.min(9999, Math.floor(qty) || 1))
    setEditItems((prev) => prev.map((i) => (i.id === id ? { ...i, qty: clean } : i)))
  }

  const removeEditItem = (id) => {
    setEditItems((prev) => prev.filter((i) => i.id !== id))
  }

  const addEditProduct = (p) => {
    setEditItems((prev) =>
      prev.some((i) => i.id === p.id) ? prev : [...prev, { id: p.id, sku: p.sku, name: p.name, qty: 1, flash: false }],
    )
    setProductQuery('')
  }

  const saveEdit = async (orderId) => {
    if (editItems.length === 0) {
      setEditError(t('orderNeedsItem'))
      return
    }
    setEditBusy(true)
    setEditError('')
    const { data, error } = await supabase.rpc('update_order_items', {
      p_order_id: orderId,
      p_items: editItems.map((i) => ({ id: i.id, qty: i.qty, flash: i.flash })),
    })
    setEditBusy(false)
    if (error) {
      setEditError(error.message)
      return
    }
    setOrders((prev) => prev.map((o) => (o.id === orderId ? { ...o, items: data.items, total: data.total } : o)))
    const edited = orders.find((o) => o.id === orderId)
    if (edited?.kind === 'quote') {
      const { data: pricing } = await supabase.rpc('get_quotes_live_pricing', { p_order_ids: [orderId] })
      if (pricing) setLivePricing((prev) => ({ ...prev, ...pricing }))
    }
    setEditing(null)
    setEditItems([])
  }

  const reps = useMemo(() => {
    const map = new Map()
    for (const o of orders) {
      const v = o.clients?.vendedora_id
      if (v && !map.has(v)) map.set(v, o.clients.vendedores?.name ?? '')
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [orders])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const qDigits = q.replace(/\D/g, '')
    return orders.filter((o) => {
      if (statusFilter && (o.status ?? 'new') !== statusFilter) return false
      if (typeFilter && (o.kind ?? 'order') !== typeFilter) return false
      if (repFilter && o.clients?.vendedora_id !== repFilter) return false
      if (!q) return true
      return (
        (o.clients?.name ?? '').toLowerCase().includes(q) ||
        (qDigits && cleanPhone(o.clients?.phone).includes(qDigits))
      )
    })
  }, [orders, query, statusFilter, typeFilter, repFilter])

  if (orders.length === 0) {
    return (
      <div>
        <h2 className="mb-4 text-xl font-bold">{t('orders')}</h2>
        <p className="text-primary/60">{t('noOrders')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-bold">
        {t('orders')} ({filtered.length}
        {filtered.length !== orders.length ? ` / ${orders.length}` : ''})
      </h2>

      <div className="flex flex-col gap-2 md:flex-row">
        <div className="relative flex-1">
          <SearchIcon />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchOrders')}
            className={`${inputCls} w-full pl-10`}
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className={inputCls}
        >
          <option value="">{t('allStatuses')}</option>
          <option value="new">{t('statusNew')}</option>
          <option value="done">{t('statusDone')}</option>
          <option value="cancelled">{t('statusCancelled')}</option>
        </select>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={inputCls}>
          <option value="">{t('allTypes')}</option>
          <option value="order">{t('order')}</option>
          <option value="quote">{t('quote')}</option>
        </select>
        {isAdmin && reps.length > 0 && (
          <select value={repFilter} onChange={(e) => setRepFilter(e.target.value)} className={inputCls}>
            <option value="">{t('allReps')}</option>
            {reps.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="py-10 text-center text-primary/50">{t('noOrders')}</p>
      ) : (
      <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-primary/10 text-left text-xs uppercase text-primary/50">
              <th className="p-3">{t('date')}</th>
              <th className="p-3">{t('client')}</th>
              <th className="p-3">{t('type')}</th>
              <th className="p-3">{t('items')}</th>
              <th className="p-3 text-right">{t('total')}</th>
              <th className="p-3">{t('status')}</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((o) => (
              <Fragment key={o.id}>
              <tr
                onClick={() => setExpanded(expanded === o.id ? null : o.id)}
                className="cursor-pointer border-b border-primary/5 align-top hover:bg-primary/[0.02]"
              >
                <td className="whitespace-nowrap p-3 text-primary/60">
                  {new Date(o.created_at).toLocaleString()}
                </td>
                <td className="p-3 font-medium">
                  {o.clients?.name}
                  <span className="block text-xs font-normal text-primary/50">
                    {o.clients?.phone}
                  </span>
                </td>
                <td className="p-3">
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      o.kind === 'quote'
                        ? 'bg-secondary/20 text-secondary-dark'
                        : 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300'
                    }`}
                  >
                    {o.kind === 'quote' ? t('quote') : t('order')}
                  </span>
                </td>
                <td className="p-3">
                  {expanded === o.id ? (
                    <ul className="space-y-1">
                      {(displayOf(o).items ?? []).map((i, n) => (
                        <li key={n} className="text-xs">
                          <span className="font-mono text-primary/50">[{i.sku}]</span> {i.name} ×
                          {i.qty}
                          {i.price != null && <> @ {money(i.price)}</>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-primary/60">
                      {(o.items ?? []).reduce((n, i) => n + (i.qty ?? 0), 0)} {t('items')} ▾
                    </span>
                  )}
                </td>
                <td className="p-3 text-right font-bold">
                  {displayOf(o).total != null ? money(displayOf(o).total) : '—'}
                </td>
                <td className="whitespace-nowrap p-3">
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLES[o.status ?? 'new']}`}
                  >
                    {o.status === 'done'
                      ? t('statusDone')
                      : o.status === 'cancelled'
                        ? t('statusCancelled')
                        : t('statusNew')}
                  </span>
                  {(o.status ?? 'new') === 'new' ? (
                    <span className="ml-2 inline-flex gap-1.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setStatus(o.id, 'done')
                        }}
                        className="rounded-lg border border-line px-2.5 py-1 text-xs text-primary/60 transition-colors hover:border-secondary hover:text-primary"
                      >
                        {t('markDone')}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setStatus(o.id, 'cancelled')
                        }}
                        className="rounded-lg border border-line px-2.5 py-1 text-xs text-red-600 transition-colors hover:border-red-400 dark:text-red-400"
                      >
                        {t('cancelOrder')}
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setStatus(o.id, 'new')
                      }}
                      className="ml-2 rounded-lg border border-line px-2.5 py-1 text-xs text-primary/60 transition-colors hover:border-secondary hover:text-primary"
                    >
                      {t('markNew')}
                    </button>
                  )}
                </td>
                <td className="whitespace-nowrap p-3 text-right">
                  <span className="inline-flex gap-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        exportPdf(o)
                      }}
                      className="rounded-full border border-line px-2.5 py-1 text-xs text-primary/60 transition-colors hover:border-secondary hover:text-primary"
                    >
                      {t('downloadPdf')}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        exportOrder(o)
                      }}
                      className="rounded-full border border-line px-2.5 py-1 text-xs text-primary/60 transition-colors hover:border-secondary hover:text-primary"
                    >
                      {t('downloadExcel')}
                    </button>
                    {(o.status ?? 'new') !== 'cancelled' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          startEdit(o)
                        }}
                        className="rounded-full border border-line px-2.5 py-1 text-xs text-primary/60 transition-colors hover:border-secondary hover:text-primary"
                      >
                        {t('edit')}
                      </button>
                    )}
                  </span>
                </td>
              </tr>
              {editing === o.id && (
                <tr className="border-b border-primary/10 bg-gold-pale/10">
                  <td colSpan={7} className="p-4">
                    <div className="space-y-3">
                      {editItems.length === 0 ? (
                        <p className="text-xs text-primary/50">{t('emptyCart')}</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {editItems.map((i) => (
                            <li key={i.id} className="flex items-center gap-2 text-sm">
                              <span className="min-w-0 flex-1 truncate">
                                <span className="font-mono text-xs text-primary/50">[{i.sku}]</span> {i.name}
                              </span>
                              <input
                                type="number"
                                min={1}
                                max={9999}
                                value={i.qty}
                                onChange={(e) => setEditQty(i.id, Number(e.target.value))}
                                className={`${inputCls} w-20 text-right`}
                              />
                              <button
                                type="button"
                                onClick={() => removeEditItem(i.id)}
                                className="shrink-0 rounded-lg border border-line px-2 py-1 text-xs text-red-600 transition-colors hover:border-red-400 dark:text-red-400"
                              >
                                {t('remove')}
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}

                      <div className="relative max-w-md">
                        <input
                          type="search"
                          value={productQuery}
                          onChange={(e) => setProductQuery(e.target.value)}
                          placeholder={`${t('selectProduct')} — ${t('searchProducts')}`}
                          className={`${inputCls} w-full`}
                        />
                        {productQuery.trim() && (
                          <div className="absolute z-10 mt-1 max-h-52 w-full overflow-y-auto rounded-lg border border-line bg-surface shadow-lg">
                            {(products ?? [])
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
                                  onClick={() => addEditProduct(p)}
                                  className="block w-full border-b border-line/60 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-gold-pale/30"
                                >
                                  <span className="font-mono text-xs text-primary/50">{p.sku}</span> {p.name}
                                </button>
                              ))}
                          </div>
                        )}
                      </div>

                      {editError && <p className="text-xs font-medium text-red-600 dark:text-red-400">{editError}</p>}

                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={editBusy}
                          onClick={() => saveEdit(o.id)}
                          className="rounded-lg bg-ink px-4 py-2 text-xs font-semibold text-secondary transition-colors hover:bg-ink-soft disabled:opacity-50"
                        >
                          {editBusy ? t('processing') : t('save')}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="rounded-lg border border-line px-4 py-2 text-xs text-primary/60 transition-colors hover:border-primary/30"
                        >
                          {t('cancel')}
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  )
}

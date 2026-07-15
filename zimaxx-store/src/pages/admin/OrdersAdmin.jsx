import { useEffect, useMemo, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { money, cleanPhone } from '../../utils/format'
import { downloadOrderExcel } from '../../utils/excel'
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

  useEffect(() => {
    // A una vendedora, RLS ya le filtra esto a sus propios pedidos —
    // el join de vendedora solo importa para el filtro que ve el admin.
    supabase
      .from('orders')
      .select('*, clients(name, phone, vendedora_id, vendedores(name))')
      .order('created_at', { ascending: false })
      .limit(200)
      .then(({ data }) => setOrders(data ?? []))
  }, [])

  const setStatus = async (id, status) => {
    const { error } = await supabase.from('orders').update({ status }).eq('id', id)
    if (!error) setOrders((prev) => prev.map((o) => (o.id === id ? { ...o, status } : o)))
  }

  const exportOrder = (o) => {
    const stamp = new Date(o.created_at).toISOString().slice(0, 10)
    downloadOrderExcel(o.items ?? [], `${stamp}-${o.id.slice(0, 8)}`)
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
              <tr
                key={o.id}
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
                      {(o.items ?? []).map((i, n) => (
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
                  {o.total != null ? money(o.total) : '—'}
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
                <td className="p-3 text-right">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      exportOrder(o)
                    }}
                    className="rounded-full border border-line px-2.5 py-1 text-xs text-primary/60 transition-colors hover:border-secondary hover:text-primary"
                  >
                    {t('downloadExcel')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  )
}

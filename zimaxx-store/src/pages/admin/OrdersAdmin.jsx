import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { money } from '../../utils/format'
import { downloadOrderExcel } from '../../utils/excel'

// Bandeja de pedidos: cada uno se marca atendido para no depender de la
// memoria del chat de WhatsApp.
export default function OrdersAdmin() {
  const { t } = useI18n()
  const [orders, setOrders] = useState([])
  const [expanded, setExpanded] = useState(null)

  useEffect(() => {
    supabase
      .from('orders')
      .select('*, clients(name, phone)')
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
      <h2 className="text-xl font-bold">{t('orders')} ({orders.length})</h2>
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
            {orders.map((o) => (
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
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      o.status === 'done'
                        ? 'bg-primary/10 text-primary/50'
                        : 'bg-gold-pale text-secondary-dark'
                    }`}
                  >
                    {o.status === 'done' ? t('statusDone') : t('statusNew')}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setStatus(o.id, o.status === 'done' ? 'new' : 'done')
                    }}
                    className="ml-2 rounded-lg border border-line px-2.5 py-1 text-xs text-primary/60 transition-colors hover:border-secondary hover:text-primary"
                  >
                    {o.status === 'done' ? t('markNew') : t('markDone')}
                  </button>
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
    </div>
  )
}

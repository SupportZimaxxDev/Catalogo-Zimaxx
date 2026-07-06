import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { supabase, fetchAll } from '../../lib/supabase'
import { useI18n } from '../../i18n'
import { money } from '../../utils/format'

const EMPTY = { product_id: '', price: '', starts_at: '', expires_at: '' }

// datetime-local trabaja en hora local; convertir a ISO para Postgres.
const toIso = (local) => (local ? new Date(local).toISOString() : null)
const nowLocal = () => {
  const d = new Date()
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

  const deactivate = async (id) => {
    await supabase.from('flash_sales').update({ active: false }).eq('id', id)
    await load()
  }

  const isLive = (s) =>
    s.active && new Date(s.starts_at) <= new Date() && new Date(s.expires_at) > new Date()

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold">⚡ {t('flashSales')}</h2>
        {isAdmin && (
          <button
            onClick={() => setForm({ ...EMPTY, starts_at: nowLocal() })}
            className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-secondary hover:bg-ink-soft"
          >
            + Flash Sale
          </button>
        )}
      </div>

      {isAdmin && form && (
        <form onSubmit={save} className="grid gap-3 rounded-2xl border border-line bg-surface p-4 shadow-sm md:grid-cols-2">
          <select
            required
            value={form.product_id}
            onChange={(e) => setForm({ ...form, product_id: e.target.value })}
            className="rounded-lg border border-line bg-surface px-3 py-2 outline-none focus:border-secondary md:col-span-2"
          >
            <option value="">{t('selectProduct')}</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                [{p.sku}] {p.name}
              </option>
            ))}
          </select>
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

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-primary/10 text-left text-xs uppercase text-primary/50">
              <th className="p-3">{t('product')}</th>
              <th className="p-3">{t('promoPrice')}</th>
              <th className="p-3">{t('startsAt')}</th>
              <th className="p-3">{t('expiresAt')}</th>
              <th className="p-3">Status</th>
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {sales.map((s) => (
              <tr key={s.id} className="border-b border-primary/5">
                <td className="p-3">
                  <span className="font-mono text-xs text-primary/50">{s.products?.sku}</span>{' '}
                  {s.products?.name}
                </td>
                <td className="p-3 font-bold text-secondary-dark">{money(s.price)}</td>
                <td className="p-3 text-primary/60">{new Date(s.starts_at).toLocaleString()}</td>
                <td className="p-3 text-primary/60">{new Date(s.expires_at).toLocaleString()}</td>
                <td className="p-3">
                  <span
                    className={`rounded-full px-3 py-1 text-xs font-semibold ${
                      isLive(s) ? 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300' : 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
                    }`}
                  >
                    {isLive(s) ? 'LIVE' : t('inactive')}
                  </span>
                </td>
                <td className="p-3 text-right">
                  {isAdmin && s.active && (
                    <button
                      onClick={() => deactivate(s.id)}
                      className="text-xs font-semibold text-red-600 hover:underline"
                    >
                      {t('deactivate')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
